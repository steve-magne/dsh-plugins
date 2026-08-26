/**
 * @dsh-plugins/changes-lens — host half.
 *
 * A DeepSeek Harness (cordis) plugin bringing the GitHub-Copilot-app
 * "Changes canvas" pillar to the DSH web surface: an inspectable surface over
 * ANY local checkout's pending work — branch + sync state, per-file
 * staged/unstaged/untracked entries with +/- line stats, a capped unified
 * diff viewer per file, and a one-click RECOVERY SNAPSHOT: uncommitted
 * tracked work is committed into an object (`git stash create`) pinned by a
 * `refs/dsh-changes-lens/*` ref so destructive agent operations can never
 * silently destroy it (the same safety net the Copilot app applies before
 * deleting session worktrees).
 *
 * Deterministic plumbing only: every operation is plain git through
 * `ctx.subprocess` (collect-mode stdio). Trust posture mirrors the other
 * plugins here: loopback-only server, Host allowlist, capped bodies and diff
 * payloads. Git runs with the full privileges of the harness process.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export const inject = ["webServer", "subprocess"];

const API_PREFIX = "/changes-lens/api";
const MAX_BODY_BYTES = 64 * 1024;
const GRACE_MS = 2_000;
const GIT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_DIFF_BYTES = 512 * 1024;
const DEFAULT_MAX_RECENT = 8;
const REF_PREFIX = "refs/dsh-changes-lens/";
const MAX_SNAPSHOTS_LISTED = 12;

/**
 * Classify one porcelain entry pair `(x, y)` into `{glyph, label, staged,
 * unstaged, untracked}`. `x` is the index (staged) status, `y` the worktree
 * status; both are single characters (' ', M, A, D, R, C, U, T, ?).
 */
export function classifyEntry(x, y) {
	const xi = String(x ?? " ");
	const yi = String(y ?? " ");
	if (xi === "?" && yi === "?") {
		return { glyph: "?", label: "untracked", staged: false, unstaged: false, untracked: true };
	}
	if (xi === "!" && yi === "!") {
		return { glyph: "!", label: "ignored", staged: false, unstaged: false, untracked: false };
	}
	const glyph = xi !== " " ? xi : yi;
	let label;
	if (xi !== " " && yi !== " ") label = "staged + edited";
	else if (xi !== " ") label = "staged";
	else label = "unstaged";
	const map = {
		M: "modified",
		A: "added",
		D: "deleted",
		R: "renamed",
		C: "copied",
		T: "typechange",
		U: "conflict",
	};
	return {
		glyph,
		label: map[glyph] ? `${label} (${map[glyph].toLowerCase()})` : label,
		staged: xi !== " ",
		unstaged: yi !== " ",
		untracked: false,
	};
}

const QUOTED_RE = /^"(.*)"$/;

/** Decode a possibly-quoted git path (core.quotePath octal escapes). */
function decodeGitPath(raw) {
	const text = String(raw ?? "");
	const match = text.match(QUOTED_RE);
	if (!match) return text;
	try {
		return JSON.parse(`"${match[1].replace(/\\([\d]{3})/g, "\\u$1")}"`);
	} catch {
		return match[1];
	}
}

/**
 * Parse `git status --porcelain` output (v1, no `-z`) into entries
 * `{x, y, path}`. Rename/copy lines carry `orig -> new`; the NEW path wins
 * (the one the diff will show). Exotic filenames quoted by core.quotePath are
 * decoded best-effort.
 */
export function parsePorcelainStatus(text) {
	const entries = [];
	for (const rawLine of String(text ?? "").split("\n")) {
		if (!rawLine || rawLine.startsWith("## ")) continue;
		if (rawLine.length < 4) continue;
		const x = rawLine[0];
		const y = rawLine[1];
		let rest = rawLine.slice(3);
		const arrow = rest.indexOf(" -> ");
		if (arrow >= 0) {
			const parts = rest.split(" -> ");
			rest = parts[parts.length - 1];
		}
		entries.push({ x, y, path: decodeGitPath(rest.trim()) });
	}
	return entries;
}

/**
 * Parse `git diff --numstat` output into a map path →
 * `{adds, dels, binary}` (`-` counts mark binary files).
 */
export function parseNumstat(text) {
	const map = new Map();
	for (const rawLine of String(text ?? "").split("\n")) {
		if (!rawLine.trim()) continue;
		const tabIndex = rawLine.indexOf("\t");
		if (tabIndex < 0) continue;
		const secondIndex = rawLine.indexOf("\t", tabIndex + 1);
		if (secondIndex < 0) continue;
		const addsRaw = rawLine.slice(0, tabIndex);
		const delsRaw = rawLine.slice(tabIndex + 1, secondIndex);
		const pathPart = rawLine.slice(secondIndex + 1);
		const arrow = pathPart.indexOf(" -> ");
		const pathText = arrow >= 0 ? pathPart.split(" -> ").pop() : pathPart;
		const binary = addsRaw === "-" || delsRaw === "-";
		map.set(decodeGitPath(pathText.trim()), {
			adds: binary ? null : Number.parseInt(addsRaw, 10) || 0,
			dels: binary ? null : Number.parseInt(delsRaw, 10) || 0,
			binary,
		});
	}
	return map;
}

function httpError(status, message) {
	return Object.assign(new Error(message), { status });
}

function oneLine(text) {
	return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function stamp(date) {
	const pad = (value, width = 2) => String(value).padStart(width, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

/**
 * Build the changes-lens controller. Factored out of {@link apply} so the
 * HTTP behavior is testable against a stubbed subprocess service over real
 * temporary repositories.
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable - ctx.subprocess.resolveExecutable.
 * @param {string} [deps.defaultRoot] - checkout opened when a request omits root.
 * @param {() => Date} [deps.now] - injectable clock for snapshot stamps.
 * @param {number} [deps.maxDiffBytes] - hard cap on returned unified diffs.
 * @param {number} [deps.maxRecent] - MRU cap on remembered roots.
 */
export function createChangesLens(deps) {
	const spawn = deps.spawn;
	const resolveExecutable = deps.resolveExecutable;
	const defaultRoot = typeof deps.defaultRoot === "string" ? deps.defaultRoot : undefined;
	const now = typeof deps.now === "function" ? deps.now : () => new Date();
	const maxDiffBytes =
		Number.isFinite(deps.maxDiffBytes) && deps.maxDiffBytes > 0
			? deps.maxDiffBytes
			: DEFAULT_MAX_DIFF_BYTES;
	const maxRecent =
		Number.isFinite(deps.maxRecent) && deps.maxRecent > 0 ? deps.maxRecent : DEFAULT_MAX_RECENT;

	/** Most-recently-opened roots, newest first. */
	const recent = [];

	// ---------------------------------------------------------------- helpers

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
		res.writeHead(statusCode, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(JSON.stringify(payload));
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

	/** Run one command in collect mode; resolves {code, out, err}. */
	async function run(argv, options = {}) {
		const executable = await resolveExecutable(argv[0]);
		const handle = spawn({
			argv: [executable, ...argv.slice(1)],
			cwd: options.cwd ?? process.cwd(),
			stdio: { stdin: "ignore", stdout: {}, stderr: {} },
			graceMs: GRACE_MS,
		});
		const outcome = await handle.done;
		const out = readAll(handle, "stdout");
		const err = readAll(handle, "stderr");
		return { code: outcome.exitCode ?? 1, out, err };
	}

	function readAll(handle, streamName) {
		try {
			const reader = handle.collected[streamName];
			if (!reader) return "";
			return reader.readFrom(0).text ?? "";
		} catch {
			return "";
		}
	}

	async function runGit(args, cwd) {
		return run(["git", ...args], { cwd });
	}

	function rememberRoot(root) {
		const index = recent.indexOf(root);
		if (index >= 0) recent.splice(index, 1);
		recent.unshift(root);
		while (recent.length > maxRecent) recent.pop();
	}

	/** Resolve + validate a request root: an existing directory inside a repo. */
	async function requireRoot(rawCwd) {
		const root =
			typeof rawCwd === "string" && rawCwd.trim().length > 0
				? resolve(rawCwd)
				: defaultRoot
					? resolve(defaultRoot)
					: undefined;
		if (!root) throw httpError(400, "no root given and no defaultRoot configured");
		try {
			const info = await stat(root);
			if (!info.isDirectory()) throw new Error("not a directory");
		} catch {
			throw httpError(400, `root is not an accessible directory: ${root}`);
		}
		const topResult = await runGit(["rev-parse", "--show-toplevel"], root).catch((error) => {
			throw httpError(400, `git unavailable: ${error.message}`);
		});
		const top = topResult.out.split("\n")[0]?.trim();
		if (topResult.code !== 0 || !top) {
			throw httpError(400, `not a git repository: ${root}`);
		}
		return top;
	}

	/** Branch + ahead/behind from `git status -b --porcelain`. */
	async function readSyncState(top) {
		const result = await runGit(["status", "-b", "--porcelain"], top);
		if (result.code !== 0) {
			throw httpError(500, `git status failed: ${oneLine(result.err)}`);
		}
		const lines = result.out.split("\n");
		const head = lines.find((line) => line.startsWith("## ")) ?? "## HEAD";
		let branch = head.slice(3).trim();
		let upstream = null;
		let ahead = 0;
		let behind = 0;
		const dots = branch.indexOf("...");
		if (dots >= 0) {
			upstream = branch.slice(dots + 3);
			branch = branch.slice(0, dots);
			const brackets = upstream.match(/\[ahead (\d+)(?:, behind (\d+))?\]/);
			const behindOnly = upstream.match(/\[behind (\d+)\]/);
			if (brackets) {
				ahead = Number.parseInt(brackets[1], 10) || 0;
				behind = Number.parseInt(brackets[2], 10) || 0;
			} else if (behindOnly) {
				behind = Number.parseInt(behindOnly[1], 10) || 0;
			}
			const spaceIndex = upstream.indexOf(" [");
			if (spaceIndex >= 0) upstream = upstream.slice(0, spaceIndex);
			else if (upstream.includes("]")) upstream = upstream.replace(/\s*\[[^\]]*\]\s*$/, "");
		} else if (branch.startsWith("HEAD ")) {
			branch = "detached";
		} else if (branch === "HEAD") {
			branch = "detached";
		}
		return { branch, upstream, ahead, behind };
	}

	async function readNumstats(top) {
		const [unstaged, staged] = await Promise.all([
			runGit(["diff", "--numstat"], top),
			runGit(["diff", "--cached", "--numstat"], top),
		]);
		const merged = parseNumstat(unstaged.out);
		for (const [path, entry] of parseNumstat(staged.out)) {
			const existing = merged.get(path);
			merged.set(path, existing
				? {
						adds: (existing.adds ?? 0) + (entry.adds ?? 0),
						dels: (existing.dels ?? 0) + (entry.dels ?? 0),
						binary: existing.binary || entry.binary,
					}
				: entry);
		}
		return merged;
	}

	// ------------------------------------------------------------- operations

	async function defaults() {
		return {
			status: 200,
			payload: { defaultRoot: defaultRoot ?? null, recent: [...recent] },
		};
	}

	async function openRoot(body) {
		const top = await requireRoot(body?.cwd);
		rememberRoot(top);
		const sync = await readSyncState(top);
		return { status: 200, payload: { root: top, ...sync } };
	}

	async function status(url) {
		const top = await requireRoot(url.searchParams.get("root"));
		const [sync, porcelain, stats] = await Promise.all([
			readSyncState(top),
			runGit(["status", "--porcelain"], top),
			readNumstats(top),
		]);
		if (porcelain.code !== 0) {
			throw httpError(500, `git status failed: ${oneLine(porcelain.err)}`);
		}
		const entries = parsePorcelainStatus(porcelain.out).map((entry) => {
			const classification = classifyEntry(entry.x, entry.y);
			const numbers = stats.get(entry.path) ?? null;
			return {
				path: entry.path,
				glyph: classification.glyph,
				label: classification.label,
				staged: classification.staged,
				unstaged: classification.unstaged,
				untracked: classification.untracked,
				adds: numbers ? numbers.adds : null,
				dels: numbers ? numbers.dels : null,
				binary: numbers ? numbers.binary : false,
			};
		});
		entries.sort((a, b) => a.path.localeCompare(b.path));
		return {
			status: 200,
			payload: {
				root: top,
				...sync,
				entries,
				counts: {
					total: entries.length,
					staged: entries.filter((entry) => entry.staged).length,
					unstaged: entries.filter((entry) => entry.unstaged).length,
					untracked: entries.filter((entry) => entry.untracked).length,
				},
				maxDiffBytes,
			},
		};
	}

	async function diff(url) {
		const top = await requireRoot(url.searchParams.get("root"));
		const cached = url.searchParams.get("cached") === "1";
		const pathParam = url.searchParams.get("path");
		const args = ["diff", "--no-color"];
		if (cached) args.push("--cached");
		args.push("--");
		if (pathParam && pathParam.trim()) args.push(pathParam.trim());
		const result = await runGit(args, top);
		if (result.code !== 0) {
			throw httpError(500, `git diff failed: ${oneLine(result.err)}`);
		}
		const full = result.out;
		const truncated = full.length > maxDiffBytes;
		return {
			status: 200,
			payload: {
				root: top,
				cached,
				path: pathParam && pathParam.trim() ? pathParam.trim() : null,
				text: truncated ? full.slice(0, maxDiffBytes) : full,
				truncated,
			},
		};
	}

	async function createSnapshot(body) {
		const top = await requireRoot(body?.root);
		// A repository without any commit has no HEAD: nothing can be pinned.
		const headProbe = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], top);
		if (headProbe.code !== 0) {
			return {
				status: 200,
				payload: {
					created: false,
					note: "repository has no commits yet; nothing to snapshot",
				},
			};
		}
		const stampText = stamp(now());
		const message = `dsh-changes-lens recovery snapshot ${stampText}`;
		const created = await runGit(["stash", "create", message], top);
		if (created.code !== 0) {
			throw httpError(500, `git stash create failed: ${oneLine(created.err)}`);
		}
		const sha = created.out.trim().split("\n")[0]?.trim();
		if (!sha) {
			return {
				status: 200,
				payload: { created: false, note: "working tree has no tracked modifications to snapshot" },
			};
		}
		const shortSha = sha.slice(0, 10);
		const refName = `${REF_PREFIX}${stampText}-${shortSha}`;
		const updated = await runGit(["update-ref", refName, sha], top);
		if (updated.code !== 0) {
			throw httpError(500, `git update-ref failed: ${oneLine(updated.err)}`);
		}
		return { status: 201, payload: { created: true, ref: refName, sha, root: top } };
	}

	async function listSnapshots(url) {
		const top = await requireRoot(url.searchParams.get("root"));
		const result = await runGit(
			[
				"for-each-ref",
				REF_PREFIX,
				"--sort=-creatordate",
				`--format=%(refname)%09%(objectname:short)%09%(creatordate:iso)%09%(contents:subject)`,
			],
			top,
		);
		if (result.code !== 0) {
			throw httpError(500, `git for-each-ref failed: ${oneLine(result.err)}`);
		}
		const snapshots = result.out
			.split("\n")
			.filter(Boolean)
			.slice(0, MAX_SNAPSHOTS_LISTED)
			.map((line) => {
				const [refname, shortSha, date, subject] = line.split("\t");
				return { ref: refname, sha: shortSha, date: date ?? "", subject: subject ?? "" };
			});
		return { status: 200, payload: { root: top, snapshots } };
	}

	// ----------------------------------------------------------------- routes

	/**
	 * The single prefix-route handler registered on the harness web server.
	 * Owns the full response lifecycle of every `/changes-lens/api/*` request.
	 */
	async function handle(req, res) {
		if (!isLocalHost(req)) {
			sendJson(res, 403, { error: "changes-lens: local connections only" });
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
			if (method === "GET" && pathname === `${API_PREFIX}/defaults`) {
				const result = await defaults();
				sendJson(res, result.status, result.payload);
				return;
			}
			if (method === "POST" && pathname === `${API_PREFIX}/open`) {
				const body = await readBody(req);
				const result = await openRoot(body);
				sendJson(res, result.status, result.payload);
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/status`) {
				const result = await status(url);
				sendJson(res, result.status, result.payload);
				return;
			}
			if (method === "POST" && pathname === `${API_PREFIX}/snapshot`) {
				const body = await readBody(req);
				const result = await createSnapshot(body);
				sendJson(res, result.status, result.payload);
				return;
			}
			if (method === "POST" && pathname === `${API_PREFIX}/snapshots/list`) {
				const result = await listSnapshots(url);
				sendJson(res, result.status, result.payload);
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/diff`) {
				const result = await diff(url);
				sendJson(res, result.status, result.payload);
				return;
			}
			sendJson(res, 404, {
				error: `no such changes-lens endpoint: ${method} ${pathname}`,
			});
		} catch (error) {
			sendJson(res, error.status ?? 500, { error: String(error?.message ?? error) });
		}
	}

	return { handle, defaults, openRoot, status, diff, createSnapshot, listSnapshots };
}

/**
 * Cordis plugin body: wire the controller to the harness services.
 * @param {object} ctx - host cordis context (`webServer` + `subprocess` injected).
 * @param {object} [config] - row config `{ defaultRoot?, maxDiffBytes?, maxRecent? }`.
 */
export function apply(ctx, config) {
	const options = config ?? {};
	const controller = createChangesLens({
		spawn: (spec) => ctx.subprocess.spawn(spec),
		resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
		defaultRoot: typeof options.defaultRoot === "string" ? options.defaultRoot : undefined,
		maxDiffBytes:
			typeof options.maxDiffBytes === "number" ? options.maxDiffBytes : undefined,
		maxRecent: typeof options.maxRecent === "number" ? options.maxRecent : undefined,
	});

	const disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: (req, res) => {
			void controller.handle(req, res);
		},
	});

	ctx.on("dispose", () => {
		disposeRoute();
	});
}
