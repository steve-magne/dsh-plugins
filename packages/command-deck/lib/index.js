/**
 * @dsh-plugins/command-deck — host half.
 *
 * A DeepSeek Harness (cordis) plugin that registers a small HTTP surface under
 * `/command-deck/api` on the harness web server and manages a registry of
 * shell commands run through `ctx.subprocess` (collect-mode stdio, tree-scoped
 * termination). The browser half (`./client.js`) renders the right-docked
 * Command Deck sidebar against these endpoints.
 *
 * Trust posture: the harness web server binds loopback by default and ships
 * without auth by design. This surface adds one hardening measure — a Host
 * allowlist (localhost/127.0.0.1/[::1]) to blunt DNS rebinding — and inherits
 * the rest of the harness's local-trust model. Commands run with the full
 * privileges of the harness process.
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Services this plugin needs before activation. */
export const inject = ["webServer", "subprocess"];

const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMMAND_CHARS = 20_000;
const MAX_LABEL_CHARS = 200;
const DEFAULT_SHELL = "/bin/bash";
const DEFAULT_SHELL_ARGS = ["-c"];
const STDOUT_MAX_BYTES = 512 * 1024;
const STDERR_MAX_BYTES = 256 * 1024;
const SPILL_MAX_BYTES = 8 * 1024 * 1024;
const GRACE_MS = 2_000;

/**
 * Build the command-deck controller. Factored out of {@link apply} so the HTTP
 * behavior is testable against a stubbed subprocess service.
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable - ctx.subprocess.resolveExecutable.
 * @param {string} [deps.defaultCwd] - working directory used when a request omits cwd.
 * @param {string} [deps.shell] - executable launched as argv[0].
 * @param {string[]} [deps.shellArgs] - arguments inserted before the command string.
 * @param {number} [deps.maxFinished] - FIFO cap on retained settled runs.
 */
export function createCommandDeck(deps) {
	const spawn = deps.spawn;
	const resolveExecutable = deps.resolveExecutable;
	const defaultCwd = deps.defaultCwd ?? process.cwd();
	const shell = deps.shell ?? DEFAULT_SHELL;
	const shellArgs = deps.shellArgs ?? DEFAULT_SHELL_ARGS;
	const maxFinished = deps.maxFinished ?? 100;

	/** id -> { record, handle } */
	const runs = new Map();

	// ---------------------------------------------------------------- helpers

	function publicRun(entry) {
		const { record } = entry;
		return {
			id: record.id,
			label: record.label,
			command: record.command,
			cwd: record.cwd,
			pid: record.pid,
			status: record.status,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			exit: record.exit,
			error: record.error,
		};
	}

	function prune() {
		let settled = 0;
		for (const entry of runs.values()) {
			if (
				entry.record.status !== "running" &&
				entry.record.status !== "stopping"
			)
				settled += 1;
		}
		if (settled <= maxFinished) return;
		// Map preserves insertion order; oldest first.
		for (const [id, entry] of runs) {
			if (settled <= maxFinished) break;
			const status = entry.record.status;
			if (status !== "running" && status !== "stopping") {
				runs.delete(id);
				settled -= 1;
			}
		}
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

	async function startRun(body) {
		const command = body?.command;
		if (typeof command !== "string" || command.trim().length === 0) {
			return {
				status: 400,
				payload: { error: "field 'command' must be a non-empty string" },
			};
		}
		if (command.length > MAX_COMMAND_CHARS) {
			return {
				status: 400,
				payload: {
					error: `field 'command' exceeds ${MAX_COMMAND_CHARS} characters`,
				},
			};
		}
		const label =
			typeof body.label === "string" && body.label.trim().length > 0
				? body.label.trim().slice(0, MAX_LABEL_CHARS)
				: command.split("\n")[0].trim().slice(0, MAX_LABEL_CHARS);
		const cwd =
			typeof body.cwd === "string" && body.cwd.trim().length > 0
				? resolve(body.cwd)
				: defaultCwd;
		try {
			const info = await stat(cwd);
			if (!info.isDirectory()) throw new Error("not a directory");
		} catch {
			return {
				status: 400,
				payload: { error: `cwd is not an accessible directory: ${cwd}` },
			};
		}

		let executable;
		try {
			executable = await resolveExecutable(shell);
		} catch (error) {
			return {
				status: 500,
				payload: {
					error: `cannot resolve shell ${shell}: ${String(error?.message ?? error)}`,
				},
			};
		}

		const handle = spawn({
			argv: [executable, ...shellArgs, command],
			cwd,
			stdio: {
				stdin: "ignore",
				stdout: {
					maxBytes: STDOUT_MAX_BYTES,
					spill: { maxBytes: SPILL_MAX_BYTES },
				},
				stderr: { maxBytes: STDERR_MAX_BYTES },
			},
			graceMs: GRACE_MS,
		});

		const record = {
			id: randomUUID(),
			label,
			command,
			cwd,
			pid: handle.pid,
			status: "running",
			startedAt: Date.now(),
			finishedAt: null,
			exit: null,
			error: null,
		};
		const entry = { record, handle };
		runs.set(record.id, entry);

		handle.done
			.then((outcome) => {
				record.status = "exited";
				record.finishedAt = Date.now();
				record.exit = { exitCode: outcome.exitCode, signal: outcome.signal };
				prune();
			})
			.catch((error) => {
				record.status = "failed";
				record.finishedAt = Date.now();
				record.error = String(error?.message ?? error);
				prune();
			});

		return { status: 201, payload: publicRun(entry) };
	}

	function stopRun(id) {
		const entry = runs.get(id);
		if (!entry)
			return { status: 404, payload: { error: `unknown run id: ${id}` } };
		if (entry.record.status === "running") {
			entry.record.status = "stopping";
			entry.handle.terminate();
		}
		return { status: 200, payload: publicRun(entry) };
	}

	async function discardRun(id) {
		const entry = runs.get(id);
		if (!entry)
			return { status: 404, payload: { error: `unknown run id: ${id}` } };
		if (
			entry.record.status === "running" ||
			entry.record.status === "stopping"
		) {
			entry.handle.terminate();
			await entry.handle
				.waitForExit(AbortSignal.timeout(GRACE_MS + 1_000))
				.catch(() => {});
		}
		runs.delete(id);
		return { status: 200, payload: { discarded: id } };
	}

	function listRuns() {
		const all = [...runs.values()].map(publicRun);
		all.sort((a, b) => b.startedAt - a.startedAt);
		return all;
	}

	function runOutput(id, url) {
		const entry = runs.get(id);
		if (!entry)
			return { status: 404, payload: { error: `unknown run id: ${id}` } };
		const readStream = (param, stream) => {
			const reader = entry.handle.collected[stream];
			if (!reader) return null;
			const offsetRaw = url.searchParams.get(param) ?? "0";
			const offset = Number.parseInt(offsetRaw, 10);
			const delta = reader.readFrom(
				Number.isFinite(offset) && offset >= 0 ? offset : 0,
			);
			return {
				text: delta.text,
				nextOffset: delta.nextOffset,
				lossy: delta.lossy,
			};
		};
		return {
			status: 200,
			payload: {
				...publicRun(entry),
				out: readStream("out", "stdout"),
				err: readStream("err", "stderr"),
			},
		};
	}

	// ----------------------------------------------------------------- routes

	/**
	 * The single prefix-route handler registered on the harness web server.
	 * Owns the full response lifecycle of every `/command-deck/api/*` request.
	 */
	async function handle(req, res) {
		if (!isLocalHost(req)) {
			sendJson(res, 403, { error: "command-deck: local connections only" });
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
			// POST /command-deck/api/runs — start a command.
			if (method === "POST" && pathname === "/command-deck/api/runs") {
				const body = await readBody(req);
				const result = await startRun(body);
				sendJson(res, result.status, result.payload);
				return;
			}
			// GET /command-deck/api/runs — registry snapshot.
			if (method === "GET" && pathname === "/command-deck/api/runs") {
				sendJson(res, 200, { runs: listRuns() });
				return;
			}
			// POST /command-deck/api/runs/<id>/stop — terminate one run's tree.
			const stopMatch = pathname.match(
				/^\/command-deck\/api\/runs\/([\w-]+)\/stop$/,
			);
			if (method === "POST" && stopMatch) {
				const result = stopRun(stopMatch[1]);
				sendJson(res, result.status, result.payload);
				return;
			}
			// DELETE /command-deck/api/runs/<id> — discard one run from the registry.
			const runMatch = pathname.match(/^\/command-deck\/api\/runs\/([\w-]+)$/);
			if (method === "DELETE" && runMatch) {
				const result = await discardRun(runMatch[1]);
				sendJson(res, result.status, result.payload);
				return;
			}
			// GET /command-deck/api/runs/<id>/output?out=&err= — incremental deltas.
			const outputMatch = pathname.match(
				/^\/command-deck\/api\/runs\/([\w-]+)\/output$/,
			);
			if (method === "GET" && outputMatch) {
				const result = runOutput(outputMatch[1], url);
				sendJson(res, result.status, result.payload);
				return;
			}
			sendJson(res, 404, {
				error: `no such command-deck endpoint: ${method} ${pathname}`,
			});
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) });
		}
	}

	/** Terminate every still-running tree and drop the registry (plugin disposal). */
	async function shutdown() {
		const live = [...runs.values()].filter(
			(entry) =>
				entry.record.status === "running" || entry.record.status === "stopping",
		);
		for (const entry of live) entry.handle.terminate();
		await Promise.allSettled(
			live.map((entry) =>
				entry.handle.waitForExit(AbortSignal.timeout(GRACE_MS + 1_000)),
			),
		);
		runs.clear();
	}

	return { handle, shutdown, startRun, stopRun, discardRun, listRuns };
}

/**
 * Cordis plugin body: wire the controller to the harness services and clean up
 * behind the plugin fiber.
 * @param {object} ctx - host cordis context (`webServer` + `subprocess` injected).
 * @param {object} [config] - row config: `{ cwd?, shell?, shellArgs?, maxFinishedRuns? }`.
 */
export function apply(ctx, config) {
	const options = config ?? {};
	const deck = createCommandDeck({
		spawn: (spec) => ctx.subprocess.spawn(spec),
		resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
		defaultCwd: typeof options.cwd === "string" ? options.cwd : undefined,
		shell: typeof options.shell === "string" ? options.shell : undefined,
		shellArgs: Array.isArray(options.shellArgs) ? options.shellArgs : undefined,
		maxFinished:
			typeof options.maxFinishedRuns === "number"
				? options.maxFinishedRuns
				: undefined,
	});

	const disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: "/command-deck/api",
		handler: (req, res) => {
			void deck.handle(req, res);
		},
	});

	ctx.on("dispose", () => {
		disposeRoute();
		void deck.shutdown();
	});
}
