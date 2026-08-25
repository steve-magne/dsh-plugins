/**
 * @dsh-plugins/agent-terminal — host half.
 *
 * A DeepSeek Harness (cordis) plugin that registers an HTTP surface under
 * `/agent-terminal/api` on the harness web server and manages a registry of
 * INTERACTIVE terminals running on the harness host — the "steering" half of
 * the GitHub-Copilot-app workflow: watch what actually runs, type into it,
 * interrupt it, all without leaving the web surface.
 *
 * Two backends, chosen per terminal at creation:
 *   - `pty`  — through the harness `spawnTerminal` primitive when the deployed
 *     subprocess provider offers it: real pseudo-terminal, UTF-8 text I/O,
 *     foreground-group signalling (^C actually interrupts);
 *   - `pipe` — plain managed spawn with a piped stdin otherwise: line-oriented
 *     interactivity (echoed programs, REPL-ish tools), foreground signals
 *     degrade to a 409 because pipes cannot deliver them.
 *
 * Output is kept in a bounded per-terminal {@link ScrollbackRing} and served
 * offset-based to independent browser readers (never consumed). Trust posture
 * mirrors the other plugins here: loopback-only server, Host allowlist against
 * DNS rebinding, capped bodies, and terminals run with the full privileges of
 * the harness process.
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ScrollbackRing } from "./ring.js";

/** Services this plugin needs before activation. */
export const inject = ["webServer", "subprocess"];

const API_PREFIX = "/agent-terminal/api";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_INPUT_CHARS = 8_000;
const MAX_LABEL_CHARS = 120;
const MAX_ARGV_ITEMS = 32;
const MAX_ARGV_ITEM_CHARS = 4_096;
const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;
const MAX_ROWS = 200;
const MAX_COLS = 500;
const GRACE_MS = 2_000;
const TERMINAL_SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGHUP"]);

/**
 * Build the agent-terminal controller. Factored out of {@link apply} so the
 * HTTP behavior is testable against stubbed subprocess services.
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {((spec: object) => Promise<object>) | undefined} [deps.spawnTerminal] -
 *   ctx.subprocess.spawnTerminal when the provider exposes the PTY primitive.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable - ctx.subprocess.resolveExecutable.
 * @param {string} [deps.defaultCwd] - cwd used when a request omits one.
 * @param {string} [deps.shell] - interactive shell used when neither argv nor command is given.
 * @param {number} [deps.maxTerminals] - cap on simultaneously LIVE terminals.
 * @param {number} [deps.scrollbackBytes] - retained-output budget per terminal.
 */
export function createAgentTerminal(deps) {
	const spawn = deps.spawn;
	const spawnTerminal =
		typeof deps.spawnTerminal === "function" ? deps.spawnTerminal : undefined;
	const resolveExecutable = deps.resolveExecutable;
	const defaultCwd = deps.defaultCwd ?? process.cwd();
	const fallbackShell = deps.shell ?? process.env.SHELL ?? "/bin/bash";
	const maxTerminals =
		Number.isFinite(deps.maxTerminals) && deps.maxTerminals > 0
			? deps.maxTerminals
			: 6;
	const scrollbackBytes =
		Number.isFinite(deps.scrollbackBytes) && deps.scrollbackBytes > 0
			? deps.scrollbackBytes
			: 512 * 1024;

	/** id -> { record, handle, ring, decoder } */
	const terminals = new Map();

	// ---------------------------------------------------------------- helpers

	function isLive(entry) {
		return (
			entry.record.status === "running" || entry.record.status === "stopping"
		);
	}

	function liveCount() {
		let count = 0;
		for (const entry of terminals.values()) if (isLive(entry)) count += 1;
		return count;
	}

	function publicTerminal(entry) {
		const { record } = entry;
		return {
			id: record.id,
			label: record.label,
			cwd: record.cwd,
			pid: record.pid,
			backend: record.backend,
			rows: record.rows,
			cols: record.cols,
			status: record.status,
			createdAt: record.createdAt,
			finishedAt: record.finishedAt,
			exit: record.exit,
			error: record.error,
		};
	}

	async function readBody(req) {
		let size = 0;
		const chunks = [];
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) throw new Error("request body too large");
			chunks.push(chunk);
		}
		if (chunks.length === 0) return {};
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new Error("request body is not valid JSON");
		}
	}

	function sendJson(res, statusCode, payload) {
		const body = JSON.stringify(payload);
		res.writeHead(statusCode, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(body);
	}

	function isLocalHost(req) {
		const raw = req.headers.host ?? "";
		let hostname = "";
		try {
			hostname = new URL(`http://${raw}`).hostname;
		} catch {
			return false;
		}
		return (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "[::1]" ||
			hostname === "::1"
		);
	}

	function clamp(value, min, max, fallback) {
		const parsed = Number.parseInt(String(value ?? ""), 10);
		if (!Number.isFinite(parsed)) return fallback;
		return Math.min(max, Math.max(min, parsed));
	}

	async function verifyCwd(rawCwd) {
		const cwd = typeof rawCwd === "string" && rawCwd.trim().length > 0
			? resolve(rawCwd)
			: defaultCwd;
		try {
			const info = await stat(cwd);
			if (!info.isDirectory()) throw new Error("not a directory");
		} catch {
			throw Object.assign(
				new Error(`cwd is not an accessible directory: ${cwd}`),
				{ status: 400 },
			);
		}
		return cwd;
	}

	async function resolveArgv(body) {
		if (Array.isArray(body?.argv)) {
			const argv = body.argv.map((item) => String(item));
			if (argv.length === 0 || argv.length > MAX_ARGV_ITEMS) {
				throw Object.assign(
					new Error(`field 'argv' must hold 1..${MAX_ARGV_ITEMS} strings`),
					{ status: 400 },
				);
			}
			for (const item of argv) {
				if (item.length > MAX_ARGV_ITEM_CHARS) {
					throw Object.assign(
						new Error(`argv item exceeds ${MAX_ARGV_ITEM_CHARS} characters`),
						{ status: 400 },
					);
				}
			}
			argv[0] = await resolveExecutable(argv[0]);
			return argv;
		}
		const command =
			typeof body?.command === "string" ? body.command : undefined;
		const shell = await resolveExecutable(fallbackShell);
		if (command !== undefined && command.trim().length > 0) {
			if (command.length > MAX_BODY_BYTES / 2) {
				throw Object.assign(new Error("command too long"), { status: 400 });
			}
			return [shell, "-c", command];
		}
		return [shell];
	}

	function settle(entry, outcome, error) {
		const { record } = entry;
		record.finishedAt = Date.now();
		if (error) {
			record.status = "failed";
			record.error = String(error?.message ?? error);
			return;
		}
		record.status = "exited";
		record.exit = { exitCode: outcome?.exitCode ?? null, signal: outcome?.signal ?? null };
	}

	/** Pump one UTF-8 stream into the entry's scrollback ring until it ends. */
	function pumpStream(stream, entry) {
		if (!stream || typeof stream.on !== "function") return;
		stream.setEncoding?.("utf8");
		stream.on("data", (chunk) => {
			entry.ring.append(typeof chunk === "string" ? chunk : String(chunk));
		});
		// Errors are tolerated: a closed tty/pipe simply stops producing deltas.
		stream.on("error", () => {});
	}

	/** Reap remaining session members once a terminal settles (idempotent). */
	async function reapSession(handle) {
		if (!handle || typeof handle.terminate !== "function") return;
		try {
			await handle.terminate();
		} catch {
			/* already gone */
		}
	}

	function finishWith(entry, promise) {
		promise
			.then(async (outcome) => {
				settle(entry, outcome);
				await reapSession(entry.handle);
			})
			.catch(async (error) => {
				settle(entry, undefined, error);
				await reapSession(entry.handle);
			});
	}

	// ------------------------------------------------------------ operations

	async function createTerminal(body) {
		if (liveCount() >= maxTerminals) {
			return {
				status: 409,
				payload: {
					error: `at most ${maxTerminals} live terminals are allowed; close one first`,
				},
			};
		}
		const rows = clamp(body?.rows, 2, MAX_ROWS, DEFAULT_ROWS);
		const cols = clamp(body?.cols, 10, MAX_COLS, DEFAULT_COLS);
		const label =
			typeof body?.label === "string" && body.label.trim().length > 0
				? body.label.trim().slice(0, MAX_LABEL_CHARS)
				: undefined;

		let cwd;
		try {
			cwd = await verifyCwd(body?.cwd);
		} catch (error) {
			return { status: error.status ?? 400, payload: { error: error.message } };
		}

		let argv;
		try {
			argv = await resolveArgv(body);
		} catch (error) {
			return { status: error.status ?? 500, payload: { error: error.message } };
		}

		const record = {
			id: randomUUID(),
			label: label ?? argv.slice(0, 2).join(" "),
			cwd,
			pid: -1,
			backend: "pipe",
			rows,
			cols,
			status: "running",
			createdAt: Date.now(),
			finishedAt: null,
			exit: null,
			error: null,
		};
		const entry = {
			record,
			handle: null,
			ring: new ScrollbackRing(scrollbackBytes),
			decoder: new StringDecoder("utf8"),
		};

		try {
			if (spawnTerminal) {
				const handle = await spawnTerminal({ argv, cwd, rows, cols, graceMs: GRACE_MS });
				entry.handle = handle;
				entry.record.backend = "pty";
				entry.record.pid = handle.pid;
				pumpStream(handle.output, entry);
				finishWith(entry, handle.done);
			} else {
				const handle = spawn({
					argv,
					cwd,
					stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
					graceMs: GRACE_MS,
				});
				entry.handle = handle;
				entry.record.pid = handle.pid;
				pumpStream(handle.stdout, entry);
				pumpStream(handle.stderr, entry);
				finishWith(entry, handle.done);
			}
		} catch (error) {
			return {
				status: 500,
				payload: { error: `terminal spawn failed: ${String(error?.message ?? error)}` },
			};
		}

		terminals.set(record.id, entry);
		pruneSettled();
		return { status: 201, payload: { ...publicTerminal(entry), backendHint: entry.record.backend } };
	}

	function pruneSettled() {
		const settled = [...terminals.entries()].filter(([, entry]) => !isLive(entry));
		const overflow = settled.length - maxTerminals * 2;
		for (let index = 0; index < overflow; index += 1) terminals.delete(settled[index][0]);
	}

	function writeInput(id, body) {
		const entry = terminals.get(id);
		if (!entry) return { status: 404, payload: { error: `unknown terminal id: ${id}` } };
		const text = body?.text;
		if (typeof text !== "string" || text.length === 0) {
			return { status: 400, payload: { error: "field 'text' must be a non-empty string" } };
		}
		if (text.length > MAX_INPUT_CHARS) {
			return {
				status: 400,
				payload: { error: `field 'text' exceeds ${MAX_INPUT_CHARS} characters` },
			};
		}
		if (!isLive(entry)) {
			return { status: 409, payload: { error: "terminal has exited" } };
		}
		try {
			if (entry.record.backend === "pty") {
				void entry.handle.write(text)?.catch?.(() => {});
			} else {
				const stdin = entry.handle.stdin;
				if (!stdin || stdin.destroyed) {
					return { status: 409, payload: { error: "terminal stdin is closed" } };
				}
				stdin.write(text);
			}
		} catch (error) {
			return {
				status: 409,
				payload: { error: `write failed: ${String(error?.message ?? error)}` },
			};
		}
		return { status: 200, payload: { written: text.length } };
	}

	async function signalForeground(id, body) {
		const entry = terminals.get(id);
		if (!entry) return { status: 404, payload: { error: `unknown terminal id: ${id}` } };
		const signal = String(body?.signal ?? "");
		if (!TERMINAL_SIGNALS.has(signal)) {
			return {
				status: 400,
				payload: {
					error: `signal must be one of ${[...TERMINAL_SIGNALS].join(", ")}`,
				},
			};
		}
		if (!isLive(entry)) return { status: 409, payload: { error: "terminal has exited" } };
		if (entry.record.backend !== "pty") {
			return {
				status: 409,
				payload: {
					error:
						"pipe-backed terminals cannot deliver foreground signals; stop the terminal instead",
				},
			};
		}
		try {
			const deliveredTo = await entry.handle.signalForeground(signal);
			return { status: 200, payload: { signaled: signal, processGroupId: deliveredTo } };
		} catch (error) {
			return {
				status: 409,
				payload: { error: `signal failed: ${String(error?.message ?? error)}` },
			};
		}
	}

	function stopTerminal(id) {
		const entry = terminals.get(id);
		if (!entry) return { status: 404, payload: { error: `unknown terminal id: ${id}` } };
		if (isLive(entry)) {
			entry.record.status = "stopping";
			void entry.handle.terminate?.();
		}
		return { status: 200, payload: publicTerminal(entry) };
	}

	async function discardTerminal(id) {
		const entry = terminals.get(id);
		if (!entry) return { status: 404, payload: { error: `unknown terminal id: ${id}` } };
		if (isLive(entry)) {
			entry.record.status = "stopping";
			void entry.handle.terminate?.();
			await entry.handle
				.waitForExit?.(AbortSignal.timeout(GRACE_MS + 1_000))
				.catch(() => {});
		}
		terminals.delete(id);
		return { status: 200, payload: { discarded: id } };
	}

	function listTerminals() {
		const all = [...terminals.values()].map(publicTerminal);
		all.sort((a, b) => b.createdAt - a.createdAt);
		return all;
	}

	function terminalOutput(id, url) {
		const entry = terminals.get(id);
		if (!entry) return { status: 404, payload: { error: `unknown terminal id: ${id}` } };
		const offsetRaw = url.searchParams.get("offset") ?? "0";
		const offset = Number.parseInt(offsetRaw, 10);
		const delta = entry.ring.readFrom(Number.isFinite(offset) && offset >= 0 ? offset : 0);
		return {
			status: 200,
			payload: { ...publicTerminal(entry), out: delta },
		};
	}

	// ----------------------------------------------------------------- routes

	/**
	 * The single prefix-route handler registered on the harness web server.
	 * Owns the full response lifecycle of every `/agent-terminal/api/*` request.
	 */
	async function handle(req, res) {
		if (!isLocalHost(req)) {
			sendJson(res, 403, { error: "agent-terminal: local connections only" });
			return;
		}
		let url;
		try {
			url = new URL(req.url ?? "/", "http://invalid.local");
		} catch {
			sendJson(res, 400, { error: "malformed request URL" });
			return;
		}
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		const method = (req.method ?? "GET").toUpperCase();
		try {
			// POST /agent-terminal/api/terminals — allocate a terminal.
			if (method === "POST" && pathname === `${API_PREFIX}/terminals`) {
				const body = await readBody(req);
				const result = await createTerminal(body);
				sendJson(res, result.status, result.payload);
				return;
			}
			// GET /agent-terminal/api/terminals — registry snapshot.
			if (method === "GET" && pathname === `${API_PREFIX}/terminals`) {
				sendJson(res, 200, { terminals: listTerminals(), ptyAvailable: Boolean(spawnTerminal) });
				return;
			}
			const idMatch = pathname.match(
				new RegExp(`^${API_PREFIX}/terminals/([\\w-]+)(/.*)?$`),
			);
			if (idMatch) {
				const [, id, action] = idMatch;
				if (!action) {
					if (method === "DELETE") {
						const result = await discardTerminal(id);
						sendJson(res, result.status, result.payload);
						return;
					}
				} else if (action === "/output" && method === "GET") {
					const result = terminalOutput(id, url);
					sendJson(res, result.status, result.payload);
					return;
				} else if (action === "/input" && method === "POST") {
					const body = await readBody(req);
					const result = writeInput(id, body);
					sendJson(res, result.status, result.payload);
					return;
				} else if (action === "/signal" && method === "POST") {
					const body = await readBody(req);
					const result = await signalForeground(id, body);
					sendJson(res, result.status, result.payload);
					return;
				} else if (action === "/stop" && method === "POST") {
					const result = stopTerminal(id);
					sendJson(res, result.status, result.payload);
					return;
				}
			}
			sendJson(res, 404, {
				error: `no such agent-terminal endpoint: ${method} ${pathname}`,
			});
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) });
		}
	}

	/** Terminate every still-live terminal tree and drop the registry. */
	async function shutdown() {
		const live = [...terminals.values()].filter(isLive);
		for (const entry of live) void entry.handle.terminate?.();
		await Promise.allSettled(
			live.map((entry) =>
				entry.handle
					.waitForExit?.(AbortSignal.timeout(GRACE_MS + 1_000))
					.catch(() => {}),
			),
		);
		terminals.clear();
	}

	return {
		handle,
		shutdown,
		createTerminal,
		writeInput,
		signalForeground,
		stopTerminal,
		discardTerminal,
		listTerminals,
		terminalOutput,
	};
}

/**
 * Cordis plugin body: wire the controller to the harness services and clean up
 * behind the plugin fiber.
 * @param {object} ctx - host cordis context (`webServer` + `subprocess` injected).
 * @param {object} [config] - row config `{ cwd?, shell?, maxTerminals?, scrollbackBytes? }`.
 */
export function apply(ctx, config) {
	const options = config ?? {};
	const controller = createAgentTerminal({
		spawn: (spec) => ctx.subprocess.spawn(spec),
		spawnTerminal:
			typeof ctx.subprocess.spawnTerminal === "function"
				? (spec) => ctx.subprocess.spawnTerminal(spec)
				: undefined,
		resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
		defaultCwd: typeof options.cwd === "string" ? options.cwd : undefined,
		shell: typeof options.shell === "string" ? options.shell : undefined,
		maxTerminals:
			typeof options.maxTerminals === "number" ? options.maxTerminals : undefined,
		scrollbackBytes:
			typeof options.scrollbackBytes === "number"
				? options.scrollbackBytes
				: undefined,
	});

	const disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: "/agent-terminal/api",
		handler: (req, res) => {
			void controller.handle(req, res);
		},
	});

	ctx.on("dispose", () => {
		disposeRoute();
		void controller.shutdown();
	});
}
