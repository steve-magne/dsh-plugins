/**
 * @dsh-plugins/worktree-launcher — host half.
 *
 * A DeepSeek Harness (cordis) plugin that gives every NEW chat session its own
 * isolated git worktree, codex/Claude-Code-App style:
 *
 *   - the browser half renders a "Worktree" toggle (ON by default) in the
 *     composer tool row of the chat window (`conversation.input.left`) and a
 *     branch/path chip under the composer card (`conversation.composer.dock`);
 *   - when a fresh session publishes (`agent/session-start`, source
 *     `startup`, never subagents/forks/resumes) the session is marked
 *     eligible, and its first real message (`agent/inbox/inserted`, turn 1)
 *     materializes a worktree under `<repo>/.dsh/worktrees/dsh-w1-w2-w3`
 *     based on an up-to-date main (best-effort `git fetch` + fast-forward —
 *     never an unsafe pull), with `main` left untouched when checked out;
 *   - a scoped system-prompt section tells the model to work inside that
 *     worktree for the whole session;
 *   - a session-list status endpoint joins every bound record with its
 *     session's display title and the GitHub PR state of its branch
 *     (`gh pr view <branch>`), so the browser half can paint a git logo
 *     beside each sidebar session row: green = worktree created, blue = PR
 *     open, red = CI failing (or PR closed unmerged), purple = merged.
 *
 * HTTP surface: a small loopback-only JSON API under `/worktree-launcher/api`
 * (preference get/set, create, list, per-session lookup, remove, and the
 * per-session git/PR state feed).
 *
 * Trust posture matches @dsh-plugins/command-deck: the harness web server
 * binds loopback without auth by design; this surface adds a Host allowlist
 * (localhost/127.0.0.1/[::1]) against DNS rebinding and caps request bodies.
 * Git commands execute with the full privileges of the harness process.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Services this plugin needs before activation. */
export const inject = ["webServer", "subprocess"];

const API_PREFIX = "/worktree-launcher/api";
const MAX_BODY_BYTES = 16 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

/** Branch names are exactly `dsh-` + three lowercase words joined by `-`. */
export const BRANCH_PATTERN = /^dsh-[a-z]{3,12}-[a-z]{3,12}-[a-z]{3,12}$/;

const WORKTREE_DIR_PARTS = [".dsh", "worktrees"];
const IGNORE_PATH = ".dsh/worktrees";
const IGNORE_LINE = `${IGNORE_PATH}/`;

/** Session-title cache TTL for the badge feed (`session-states`). */
const TITLE_TTL_MS = 30_000;
/** How often a missing `gh` binary is probed again before giving up. */
const GH_PROBE_RETRY_MS = 5 * 60_000;

/**
 * Check-conclusion vocabularies shared with @dsh-plugins/create-pr (duplicated
 * on purpose: plugins never import each other). Anything not explicitly good
 * or bad is treated as still running.
 */
const BAD_CHECK_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"STARTUP_FAILURE",
	"ACTION_REQUIRED",
	"CANCELLED",
	"ERROR",
]);
const GOOD_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Normalize one `statusCheckRollup` entry (CheckRun, StatusContext, or
 * WorkflowRun shapes) into `{name, conclusion}`.
 */
export function normalizeCheck(entry) {
	if (!entry || typeof entry !== "object") {
		return { name: "check", conclusion: "UNKNOWN" };
	}
	const rawStatus = String(entry.status ?? "").toUpperCase();
	const rawState = String(entry.state ?? "").toUpperCase();
	let conclusion = String(entry.conclusion ?? "").toUpperCase();
	if (!conclusion) {
		if (rawState === "SUCCESS") conclusion = "SUCCESS";
		else if (rawState === "FAILURE" || rawState === "ERROR") conclusion = "FAILURE";
		else if (rawState === "PENDING" || rawState === "EXPECTED") conclusion = "PENDING";
		else if (
			rawStatus === "IN_PROGRESS" ||
			rawStatus === "QUEUED" ||
			rawStatus === "PENDING" ||
			rawStatus === "WAITING"
		) {
			conclusion = "PENDING";
		} else conclusion = rawStatus || rawState ? "PENDING" : "UNKNOWN";
	}
	return {
		name: String(entry.name ?? entry.context ?? entry.workflowName ?? "check"),
		conclusion,
	};
}

/**
 * Classify a full rollup snapshot: `failed` wins over pending; an empty
 * rollup is `empty` (checks not registered yet — counts as healthy here).
 */
export function classifyChecks(rollup) {
	const entries = Array.isArray(rollup) ? rollup : [];
	const checks = entries.map(normalizeCheck);
	if (checks.length === 0) return { outcome: "empty", checks };
	let failed = false;
	let pending = false;
	for (const check of checks) {
		if (BAD_CHECK_CONCLUSIONS.has(check.conclusion)) failed = true;
		else if (!GOOD_CHECK_CONCLUSIONS.has(check.conclusion)) pending = true;
	}
	if (failed) return { outcome: "failed", checks };
	if (pending) return { outcome: "pending", checks };
	return { outcome: "passed", checks };
}

/**
 * Map one normalized PR view onto the session-list badge state:
 *   - no PR at all                        -> `created` (green)
 *   - MERGED                              -> `merged`  (purple)
 *   - CLOSED without a merge              -> `problem` (red)
 *   - OPEN with a failed check            -> `problem` (red)
 *   - OPEN otherwise (passing/pending/no) -> `pr`      (blue)
 */
export function deriveBadgeState(pr) {
	if (!pr || typeof pr !== "object") return "created";
	const state = String(pr.state ?? "").toUpperCase();
	if (state === "MERGED") return "merged";
	if (state === "CLOSED") return "problem";
	if (classifyChecks(pr.statusCheckRollup).outcome === "failed") return "problem";
	return "pr";
}

function firstTitleString(value, depth = 0) {
	if (typeof value === "string") return value.trim() ? value.trim() : undefined;
	if (!value || typeof value !== "object" || depth > 2) return undefined;
	for (const candidate of [value.title, value.displayTitle]) {
		const picked = firstTitleString(candidate, depth + 1);
		if (picked) return picked;
	}
	if (value.snapshot) return firstTitleString(value.snapshot, depth + 1);
	return undefined;
}

/**
 * Build the `listSessionTitles(ids) -> [{sessionId, title}]` dependency from
 * the optional host `sessionQuery` service. The service face grew over
 * releases, so the lister tries `readTitleSnapshots` first and falls back to
 * one `listSessions()` sweep, tolerantly extracting titles from either shape.
 * When the service is absent entirely the lister answers empty and the browser
 * badges simply stay hidden.
 * @param {object|undefined} sessionQuery - ctx.get("sessionQuery").
 * @param {object} [options]
 * @param {(message: string) => void} [options.warn] - best-effort diagnostics sink.
 */
export function createSessionTitleLister(sessionQuery, options = {}) {
	const warn = typeof options.warn === "function" ? options.warn : () => {};
	if (sessionQuery && typeof sessionQuery.readTitleSnapshots === "function") {
		return async (ids) => {
			const observations = await sessionQuery.readTitleSnapshots(ids);
			const pairs = [];
			const list = Array.isArray(observations) ? observations : [];
			for (let index = 0; index < list.length; index += 1) {
				const entry = list[index];
				const sessionId =
					entry && typeof entry === "object" && typeof entry.sessionId === "string"
						? entry.sessionId
						: ids[index];
				const title = firstTitleString(entry);
				if (sessionId && title) pairs.push({ sessionId, title });
			}
			return pairs;
		};
	}
	if (sessionQuery && typeof sessionQuery.listSessions === "function") {
		return async (ids) => {
			const wanted = new Set(ids);
			const records = await sessionQuery.listSessions();
			const pairs = [];
			for (const record of Array.isArray(records) ? records : []) {
				const sessionId = record ? record.sessionId ?? record.id : undefined;
				if (typeof sessionId !== "string" || !wanted.has(sessionId)) continue;
				const title =
					firstTitleString(record) ??
					firstTitleString(record?.projections?.title);
				if (title) pairs.push({ sessionId, title });
			}
			return pairs;
		};
	}
	warn("worktree-launcher: no usable sessionQuery service; session-list badges stay hidden");
	return async () => [];
}

/** Word pools for the `dsh-word-word-word` branch naming (letters only). */
const ADJECTIVES = [
	"amber", "azure", "bold", "brisk", "calm", "clever", "cobalt", "crisp",
	"eager", "fuzzy", "gentle", "ivory", "jade", "keen", "lucid", "mellow",
	"nimble", "opal", "plum", "quiet", "rapid", "sage", "swift", "tidy",
	"umber", "vivid",
];
const NOUNS = [
	"aurora", "basalt", "cinder", "comet", "delta", "dune", "ember", "falcon",
	"glacier", "harbor", "island", "lagoon", "meadow", "nectar", "orchid",
	"otter", "pixel", "puddle", "quartz", "river", "summit", "thicket",
	"vertex", "wren", "zephyr",
];

function pickWord(list, random) {
	return list[Math.floor(random() * list.length)] ?? list[0];
}

/**
 * Default branch-word picker: adjective-noun-adjective. Injectable so tests
 * can pin exact names.
 */
function defaultWordPicker(adjectives, nouns, random) {
	const first = pickWord(adjectives, random);
	const noun = pickWord(nouns, random);
	let second = pickWord(adjectives, random);
	let guard = 0;
	while (second === first && guard < 5) {
		second = pickWord(adjectives, random);
		guard += 1;
	}
	return [first, noun, second];
}

function httpStatusError(status, message) {
	return Object.assign(new Error(message), { status });
}

function oneLine(text) {
	return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Build the worktree launcher controller. Factored out of {@link apply} so the
 * git behavior and the HTTP behavior are testable without cordis.
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable - ctx.subprocess.resolveExecutable.
 * @param {string} [deps.defaultRoot] - repo used when a request omits root.
 * @param {string} [deps.baseBranch] - force the base branch instead of detecting main/master.
 * @param {number} [deps.fetchTimeoutMs] - budget for `git fetch origin <branch>`.
 * @param {boolean} [deps.enabled] - initial value of the auto-worktree preference.
 * @param {() => number} [deps.random] - randomness source for word picking.
 * @param {(adjectives: string[], nouns: string[], random: () => number) => string[]} [deps.wordPicker].
 * @param {string} [deps.ghPath] - explicit `gh` binary path instead of PATH resolution.
 * @param {number} [deps.prTtlMs] - PR-status cache TTL per branch (default 60 s).
 * @param {number} [deps.ghTimeoutMs] - budget for one `gh pr view` call (default 10 s).
 * @param {(ids: string[]) => Promise<Array<{sessionId: string, title: string}>>} [deps.listSessionTitles]
 *   - session-id -> display-title source for the badge feed (built from the
 *     optional sessionQuery service; absent -> badges stay hidden).
 * @param {(message: string) => void} [deps.warn] - sink for best-effort failures.
 */
export function createWorktreeLauncher(deps) {
	const spawn = deps.spawn;
	const resolveExecutable = deps.resolveExecutable;
	const defaultRoot =
		typeof deps.defaultRoot === "string" && deps.defaultRoot.trim()
			? resolve(deps.defaultRoot)
			: undefined;
	const baseBranchOverride =
		typeof deps.baseBranch === "string" && deps.baseBranch.trim()
			? deps.baseBranch.trim()
			: undefined;
	const fetchTimeoutMs =
		typeof deps.fetchTimeoutMs === "number" && deps.fetchTimeoutMs > 0
			? deps.fetchTimeoutMs
			: DEFAULT_FETCH_TIMEOUT_MS;
	const ghPath =
		typeof deps.ghPath === "string" && deps.ghPath.trim() ? deps.ghPath.trim() : undefined;
	const prTtlMs =
		typeof deps.prTtlMs === "number" && deps.prTtlMs > 0 ? deps.prTtlMs : 60_000;
	const ghTimeoutMs =
		typeof deps.ghTimeoutMs === "number" && deps.ghTimeoutMs > 0 ? deps.ghTimeoutMs : 10_000;
	const listSessionTitles =
		typeof deps.listSessionTitles === "function" ? deps.listSessionTitles : undefined;
	const random = typeof deps.random === "function" ? deps.random : Math.random;
	const wordPicker =
		typeof deps.wordPicker === "function" ? deps.wordPicker : defaultWordPicker;
	const warn = typeof deps.warn === "function" ? deps.warn : () => {};

	const pref = { enabled: deps.enabled !== false };
	/** branch -> record (insertion ordered). */
	const records = new Map();
	/** sessionId -> branch. */
	const bySession = new Map();
	/** sessionIds whose lifecycle started fresh (`startup`) and never resumed. */
	const eligible = new Set();
	/** One in-flight creation chain per repo top, serializing git mutations. */
	const chains = new Map();

	/** Resolved-binary cache keyed by kind ("git" | "gh"); failed lookups retry. */
	const executables = new Map();
	async function executable(kind) {
		if (!executables.has(kind)) {
			const wanted = kind === "gh" && ghPath ? ghPath : kind;
			executables.set(
				kind,
				resolveExecutable(wanted).catch((error) => {
					executables.delete(kind);
					throw error;
				}),
			);
		}
		return executables.get(kind);
	}

	// ------------------------------------------------------------------ git

	async function runProc(kind, argv, options = {}) {
		const cwd = options.cwd;
		const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
		const bin = await executable(kind);
		const handle = spawn({
			argv: [bin, ...argv],
			cwd,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: 256 * 1024 },
				stderr: { maxBytes: 256 * 1024 },
			},
			graceMs: 1_000,
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			handle.terminate();
		}, timeoutMs);
		let outcome;
		try {
			outcome = await handle.done;
		} finally {
			clearTimeout(timer);
		}
		if (timedOut) {
			throw new Error(`${kind} ${argv[0]} timed out after ${timeoutMs}ms`);
		}
		const readAll = (stream) => {
			const reader = handle.collected?.[stream];
			return reader ? reader.readFrom(0).text : "";
		};
		return {
			code: typeof outcome?.exitCode === "number" ? outcome.exitCode : 1,
			out: readAll("stdout").trim(),
			err: readAll("stderr").trim(),
		};
	}

	async function runGit(argv, options = {}) {
		return runProc("git", argv, options);
	}

	async function revParse(revision, cwd) {
		try {
			const result = await runGit(
				["rev-parse", "--verify", "--quiet", revision],
				{ cwd },
			);
			if (result.code === 0 && result.out) {
				return result.out.split("\n")[0].trim();
			}
		} catch {
			/* missing ref or git failure -> undefined */
		}
		return undefined;
	}

	async function resolveRepo(root) {
		let info;
		try {
			info = await stat(root);
		} catch {
			throw httpStatusError(400, `root is not an accessible directory: ${root}`);
		}
		if (!info.isDirectory()) {
			throw httpStatusError(400, `root is not a directory: ${root}`);
		}
		const topResult = await runGit(["rev-parse", "--show-toplevel"], { cwd: root });
		if (!topResult.out) {
			throw httpStatusError(
				400,
				`not a git repository: ${root}${topResult.err ? ` (${oneLine(topResult.err)})` : ""}`,
			);
		}
		const top = topResult.out.split("\n")[0].trim();
		let commonDir = "";
		try {
			const common = await runGit(
				["rev-parse", "--path-format=absolute", "--git-common-dir"],
				{ cwd: top },
			);
			commonDir = common.code === 0 ? common.out : "";
		} catch {
			/* older git: fall through to relative resolution */
		}
		if (!commonDir || !isAbsolute(commonDir)) {
			const common = await runGit(["rev-parse", "--git-common-dir"], { cwd: top });
			const raw = common.out || ".git";
			commonDir = isAbsolute(raw) ? raw : join(top, raw);
		}
		return { top, commonDir };
	}

	async function detectBaseBranch(top) {
		if (baseBranchOverride) {
			const sha = await revParse(`refs/heads/${baseBranchOverride}`, top);
			if (!sha) {
				throw httpStatusError(400, `base branch not found: ${baseBranchOverride}`);
			}
			return baseBranchOverride;
		}
		for (const candidate of ["main", "master"]) {
			if (await revParse(`refs/heads/${candidate}`, top)) return candidate;
		}
		try {
			const head = await runGit(
				["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
				{ cwd: top },
			);
			const name = head.out.replace(/^origin\//, "").trim();
			if (name && (await revParse(`refs/remotes/origin/${name}`, top))) return name;
		} catch {
			/* fall through */
		}
		throw httpStatusError(
			400,
			"no main/master branch found; set the row config 'baseBranch'",
		);
	}

	/**
	 * Path of the worktree that currently checks out `branch`, if any.
	 */
	async function findCheckoutPath(top, branch) {
		try {
			const listing = await runGit(
				["branch", "--list", branch, "--format=%(worktreepath)"],
				{ cwd: top },
			);
			if (listing.code !== 0) return undefined;
			const path = listing.out
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)[0];
			return path || undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * "git pull au besoin", safely: fetch the remote branch, then update the
	 * LOCAL branch to the fetched tip. Two modes:
	 *   - branch checked out somewhere (the usual case: the harness workspace
	 *     itself) -> a real `git pull --ff-only` in THAT worktree, which can
	 *     only fast-forward and fails harmlessly on divergence or conflicts;
	 *   - branch not checked out anywhere -> a pure ref update via
	 *     `git fetch . origin/<b>:<b>`, whose non-forced refspec refuses
	 *     non-fast-forwards by construction.
	 * Every failure mode leaves the repository exactly as it was while the new
	 * worktree still bases on the fetched remote tip.
	 */
	async function updateBaseBranch(top, branch) {
		let hasOrigin = false;
		try {
			const url = await runGit(["config", "--get", "remote.origin.url"], { cwd: top });
			hasOrigin = url.code === 0 && Boolean(url.out);
		} catch {
			hasOrigin = false;
		}
		if (!hasOrigin) {
			return { updated: false, note: "no origin remote configured" };
		}
		let fetched;
		try {
			fetched = await runGit(["fetch", "origin", branch], {
				cwd: top,
				timeoutMs: fetchTimeoutMs,
			});
		} catch (error) {
			return { updated: false, note: `fetch failed: ${oneLine(error.message)}` };
		}
		if (fetched.code !== 0) {
			const reason = oneLine(fetched.err || fetched.out) || "git error";
			return { updated: false, note: `fetch failed: ${reason}` };
		}
		const remoteSha = await revParse(`refs/remotes/origin/${branch}`, top);
		if (!remoteSha) {
			return { updated: false, note: `origin/${branch} missing after fetch` };
		}
		const beforeSha = await revParse(`refs/heads/${branch}`, top);
		if (beforeSha === remoteSha) {
			return { updated: false, note: null };
		}
		const checkoutPath = await findCheckoutPath(top, branch);
		if (checkoutPath) {
			let pulled;
			try {
				pulled = await runGit(["pull", "--ff-only", "origin", branch], {
					cwd: checkoutPath,
					timeoutMs: fetchTimeoutMs,
				});
			} catch (error) {
				return {
					updated: false,
					note: `local ${branch} not pulled (${oneLine(error.message)})`,
				};
			}
			if (pulled.code !== 0) {
				const reason = oneLine(pulled.err || pulled.out) || "git error";
				return { updated: false, note: `local ${branch} not pulled (${reason})` };
			}
			return { updated: true, note: null };
		}
		let refspec;
		try {
			refspec = await runGit(
				["fetch", ".", `refs/remotes/origin/${branch}:refs/heads/${branch}`],
				{ cwd: top },
			);
		} catch (error) {
			return {
				updated: false,
				note: `local ${branch} not fast-forwarded (${oneLine(error.message)})`,
			};
		}
		if (refspec.code !== 0) {
			const reason = oneLine(refspec.err || refspec.out) || "git error";
			return {
				updated: false,
				note: `local ${branch} not fast-forwarded (${reason})`,
			};
		}
		return { updated: true, note: null };
	}

	async function baseCommitSha(top, branch) {
		return (
			(await revParse(`refs/remotes/origin/${branch}`, top)) ??
			(await revParse(`refs/heads/${branch}`, top)) ??
			(await revParse("HEAD", top))
		);
	}

	/**
	 * Keep `.dsh/worktrees/` out of `git status` without touching any tracked
	 * file: respect an existing ignore rule, else add one line to the local
	 * `<commonDir>/info/exclude`.
	 */
	async function ensureIgnoreRule(top, commonDir) {
		let ignored = false;
		try {
			const probe = await runGit(["check-ignore", "-q", "--", IGNORE_PATH], {
				cwd: top,
			});
			ignored = probe.code === 0;
		} catch {
			ignored = false;
		}
		if (ignored) return;
		try {
			const excludePath = join(commonDir, "info", "exclude");
			let current = "";
			try {
				current = await readFile(excludePath, "utf8");
			} catch {
				current = "";
			}
			const lines = current.split("\n");
			if (lines.includes(IGNORE_LINE) || lines.includes(IGNORE_PATH)) return;
			const prefix =
				current.length > 0 && !current.endsWith("\n") ? "\n" : "";
			await mkdir(dirname(excludePath), { recursive: true });
			await writeFile(excludePath, `${current}${prefix}# added by worktree-launcher\n${IGNORE_LINE}\n`, "utf8");
		} catch (error) {
			warn(`worktree-launcher: could not update .git/info/exclude: ${error?.message ?? error}`);
		}
	}

	// ---------------------------------------------------------------- state

	function publicRecord(record) {
		return {
			branch: record.branch,
			path: record.path,
			root: record.root,
			baseBranch: record.baseBranch,
			baseSha: record.baseSha,
			mainUpdated: record.mainUpdated,
			note: record.note ?? null,
			sessionId: record.sessionId ?? null,
			createdAt: record.createdAt,
		};
	}

	function mintWords() {
		return wordPicker(ADJECTIVES, NOUNS, random);
	}

	function branchNameFor(words) {
		return `dsh-${words.join("-")}`;
	}

	async function pathFree(path) {
		try {
			await stat(path);
			return false;
		} catch {
			return true;
		}
	}

	async function mintBranch(top, worktreeDir) {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const candidate = branchNameFor(mintWords());
			if (!BRANCH_PATTERN.test(candidate)) continue;
			if (records.has(candidate)) continue;
			if (await revParse(`refs/heads/${candidate}`, top)) continue;
			if (!(await pathFree(join(worktreeDir, candidate)))) continue;
			return candidate;
		}
		throw new Error("could not mint a free dsh-* branch name after 8 attempts");
	}

	async function createWorktree({ root, sessionId } = {}) {
		const requestedRoot =
			typeof root === "string" && root.trim() ? resolve(root.trim()) : defaultRoot;
		if (!requestedRoot) {
			throw httpStatusError(400, "no root provided and no default cwd configured");
		}
		const sid =
			typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
		if (sid) {
			const boundBranch = bySession.get(sid);
			if (boundBranch) {
				const existing = records.get(boundBranch);
				if (existing) return { ...publicRecord(existing), created: false };
			}
		}

		const { top } = await resolveRepo(requestedRoot);
		const previous = chains.get(top) ?? Promise.resolve();
		const run = previous.catch(() => {}).then(() =>
			createLocked({ top, sid }),
		);
		chains.set(
			top,
			run.catch(() => {}),
		);
		return run;
	}

	async function createLocked({ top, sid }) {
		const { commonDir } = await resolveRepo(top);
		const worktreeDir = join(top, ...WORKTREE_DIR_PARTS);
		await mkdir(worktreeDir, { recursive: true });
		await ensureIgnoreRule(top, commonDir);

		const branch = await detectBaseBranch(top);
		const update = await updateBaseBranch(top, branch);
		const baseSha = await baseCommitSha(top, branch);
		if (!baseSha) {
			throw httpStatusError(500, `cannot resolve base commit for ${branch}`);
		}

		const newBranch = await mintBranch(top, worktreeDir);
		const targetPath = join(worktreeDir, newBranch);
		const add = await runGit(
			["worktree", "add", "-b", newBranch, targetPath, baseSha],
			{ cwd: top },
		);
		if (!existsSync(targetPath)) {
			throw httpStatusError(
				500,
				`git worktree add failed:${add.err ? ` ${oneLine(add.err)}` : " (no directory created)"}`,
			);
		}

		const record = {
			branch: newBranch,
			path: targetPath,
			root: top,
			baseBranch: branch,
			baseSha,
			mainUpdated: update.updated === true,
			note: update.note ?? null,
			sessionId: sid,
			createdAt: Date.now(),
		};
		records.set(newBranch, record);
		if (sid) bySession.set(sid, newBranch);
		return { ...publicRecord(record), created: true };
	}

	function removeWorktree(branch, options = {}) {
		if (typeof branch !== "string" || !BRANCH_PATTERN.test(branch)) {
			throw httpStatusError(400, `invalid branch name: ${branch}`);
		}
		const record = records.get(branch);
		if (!record) {
			throw httpStatusError(404, `unknown worktree branch: ${branch}`);
		}
		return (async () => {
			const argv = ["worktree", "remove"];
			if (options.force) argv.push("--force");
			argv.push(record.path);
			const result = await runGit(argv, { cwd: record.root });
			if (!existsSync(record.path)) {
				/* removed (possibly with a warning about dirty files) */
			} else if (result.code !== 0) {
				throw httpStatusError(
					409,
					`git worktree remove failed:${result.err ? ` ${oneLine(result.err)}` : ""} (retry with ?force=1)`,
				);
			}
			records.delete(branch);
			for (const [sid, bound] of bySession) {
				if (bound === branch) bySession.delete(sid);
			}
			return publicRecord(record);
		})();
	}

	function listWorktrees() {
		return [...records.values()]
			.map(publicRecord)
			.sort((a, b) => b.createdAt - a.createdAt);
	}

	function recordForSession(sessionId) {
		if (typeof sessionId !== "string") return undefined;
		const branch = bySession.get(sessionId);
		return branch ? records.get(branch) : undefined;
	}

	// ------------------------------------------------- session badge states

	/** Tri-state probe result: "unknown" | "available" | "missing". */
	let ghProbe = { state: "unknown", at: 0 };

	async function ghReady() {
		const now = Date.now();
		if (ghProbe.state === "available") return true;
		if (ghProbe.state === "missing" && now - ghProbe.at < GH_PROBE_RETRY_MS) {
			return false;
		}
		try {
			await executable("gh");
			ghProbe = { state: "available", at: now };
			return true;
		} catch {
			ghProbe = { state: "missing", at: now };
			warn("worktree-launcher: gh is unavailable; PR badges degrade to 'created'");
			return false;
		}
	}

	/** One normalized `gh pr view` snapshot, or null when GitHub has no PR. */
	async function fetchPrStatus(record) {
		if (!(await ghReady())) return null;
		let view;
		try {
			const result = await runProc(
				"gh",
				["pr", "view", record.branch, "--json", "number,url,state,statusCheckRollup"],
				{ cwd: record.root, timeoutMs: ghTimeoutMs },
			);
			if (result.code !== 0) return null;
			view = JSON.parse(result.out);
		} catch (error) {
			warn(`worktree-launcher: gh pr view failed for ${record.branch}: ${error?.message ?? error}`);
			return null;
		}
		if (!view || typeof view !== "object") return null;
		return {
			number: typeof view.number === "number" ? view.number : null,
			url: typeof view.url === "string" ? view.url : null,
			state: String(view.state ?? "").toUpperCase(),
			statusCheckRollup: Array.isArray(view.statusCheckRollup)
				? view.statusCheckRollup
				: [],
		};
	}

	/** branch -> {at, pr}; pr is null when GitHub has none for the branch. */
	const prCache = new Map();
	let prChain = Promise.resolve();

	function prStatusFor(branch) {
		const fresh = prCache.get(branch);
		if (fresh && Date.now() - fresh.at < prTtlMs) return Promise.resolve(fresh.pr);
		const record = records.get(branch);
		if (!record) return Promise.resolve(null);
		const run = prChain.catch(() => {}).then(async () => {
			const cached = prCache.get(branch);
			if (cached && Date.now() - cached.at < prTtlMs) return cached.pr;
			const pr = await fetchPrStatus(record);
			prCache.set(branch, { at: Date.now(), pr });
			return pr;
		});
		prChain = run.catch(() => {});
		return run;
	}

	/** sessionId -> display title, refreshed at most every TITLE_TTL_MS. */
	let titleCache = { at: 0, byId: new Map() };

	async function sessionTitles(ids) {
		if (!listSessionTitles || ids.length === 0) return new Map();
		const now = Date.now();
		if (now - titleCache.at < TITLE_TTL_MS) return titleCache.byId;
		try {
			const pairs = await listSessionTitles(ids);
			const byId = new Map();
			for (const pair of Array.isArray(pairs) ? pairs : []) {
				if (
					pair &&
					typeof pair.sessionId === "string" &&
					typeof pair.title === "string" &&
					pair.title.trim()
				) {
					byId.set(pair.sessionId, pair.title.trim());
				}
			}
			titleCache = { at: now, byId };
			return byId;
		} catch (error) {
			warn(`worktree-launcher: session titles unavailable: ${error?.message ?? error}`);
			return titleCache.at ? titleCache.byId : new Map();
		}
	}

	/**
	 * Badge feed for the browser half: one entry per bound worktree whose
	 * session title resolved — exactly what a sidebar row needs to paint its
	 * git logo between the title and the relative-time label.
	 */
	async function sessionStates() {
		const snapshot = listWorktrees();
		const ids = [...new Set(snapshot.map((entry) => entry.sessionId).filter(Boolean))];
		const titles = await sessionTitles(ids);
		const states = [];
		for (const record of snapshot) {
			if (!record.sessionId) continue;
			const title = titles.get(record.sessionId);
			if (!title) continue;
			const pr = await prStatusFor(record.branch);
			states.push({
				sessionId: record.sessionId,
				title,
				state: deriveBadgeState(pr),
				branch: record.branch,
				prNumber: pr ? pr.number : null,
				prUrl: pr ? pr.url : null,
			});
		}
		return states;
	}

	// ------------------------------------------------------- agent wiring

	/**
	 * Event listener body for `agent/session-start`: only brand-new lifecycles
	 * (`startup`) of ordinary root sessions become eligible. Resumes, clears,
	 * compactions, subagents and forks never are.
	 */
	function markEligible(payload) {
		const source = payload?.source;
		if (source !== "startup") return;
		const agent = payload?.agent;
		const id = agent?.id;
		if (typeof id !== "string" || !id) return;
		const header = agent?.session?.header;
		if (!header) return;
		if (
			header.origin === "subagent" ||
			header.parentSession != null ||
			(Number(header.delegationDepth) || 0) > 0
		) {
			return;
		}
		eligible.add(id);
	}

	/**
	 * Event listener body for `agent/inbox/inserted`: materialize the worktree
	 * on the session's FIRST real message, so merely browsing blank workspaces
	 * does not litter disk. Fire-and-forget by contract; failures degrade
	 * silently (the chip simply never appears).
	 */
	async function maybeCreateForTurn(payload) {
		const agent = payload?.agent;
		const id = agent?.id;
		if (typeof id !== "string" || !eligible.has(id)) return;
		if (Number(payload?.turn) !== 1) return;
		if (bySession.has(id)) return;
		if (!pref.enabled) return;
		const cwd = agent?.session?.header?.cwd;
		try {
			await createWorktree({ root: cwd, sessionId: id });
		} catch (error) {
			warn(`worktree-launcher: auto-create failed for ${id}: ${error?.message ?? error}`);
		}
	}

	/**
	 * Text provider for the system-prompt section. The assembly scope is the
	 * Agent object itself; match its `id` against the sessions this plugin
	 * equipped. Anything else yields no section text at all.
	 */
	function promptSectionText(context) {
		const scope = context && typeof context === "object" ? context.scope : undefined;
		let sessionId;
		if (scope && typeof scope === "object" && typeof scope.id === "string") {
			sessionId = scope.id;
		} else if (typeof scope === "string") {
			sessionId = scope;
		}
		if (!sessionId) return "";
		const record = recordForSession(sessionId);
		if (!record) return "";
		return [
			`Session worktree active — git branch \`${record.branch}\`.`,
			`Dedicated working directory for THIS session: ${record.path}`,
			`Run every shell command, file read/write, and search inside that`,
			`directory (an isolated git worktree based on \`${record.baseBranch}\`).`,
			`Treat the original checkout (${record.root}) as read-only reference and`,
			`commit this session's work on \`${record.branch}\`. Work outside the`,
			`working directory above only when the user explicitly asks.`,
		].join("\n");
	}

	// ------------------------------------------------------------------ http

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

	async function handle(req, res) {
		if (!isLocalHost(req)) {
			sendJson(res, 403, { error: "worktree-launcher: local connections only" });
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
			if (method === "GET" && pathname === `${API_PREFIX}/pref`) {
				sendJson(res, 200, { enabled: pref.enabled });
				return;
			}
			if (method === "PUT" && pathname === `${API_PREFIX}/pref`) {
				const body = await readBody(req);
				if (typeof body?.enabled !== "boolean") {
					sendJson(res, 400, { error: "field 'enabled' must be a boolean" });
					return;
				}
				pref.enabled = body.enabled;
				sendJson(res, 200, { enabled: pref.enabled });
				return;
			}
			if (method === "POST" && pathname === `${API_PREFIX}/worktrees`) {
				const body = await readBody(req);
				const result = await createWorktree({
					root: body?.root,
					sessionId: body?.sessionId,
				});
				sendJson(res, result.created ? 201 : 200, result);
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/worktrees`) {
				sendJson(res, 200, { worktrees: listWorktrees(), enabled: pref.enabled });
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/session-states`) {
				sendJson(res, 200, { states: await sessionStates() });
				return;
			}
			const sessionMatch = pathname.match(/^\/worktree-launcher\/api\/by-session\/(.+)$/);
			if (method === "GET" && sessionMatch) {
				const sessionId = decodeURIComponent(sessionMatch[1]);
				const record = recordForSession(sessionId);
				if (!record) {
					sendJson(res, 404, { error: `no worktree bound to session ${sessionId}` });
					return;
				}
				sendJson(res, 200, publicRecord(record));
				return;
			}
			const branchMatch = pathname.match(/^\/worktree-launcher\/api\/worktrees\/(.+)$/);
			if (branchMatch && (method === "DELETE" || method === "GET")) {
				const branch = decodeURIComponent(branchMatch[1]);
				if (method === "GET") {
					const record = records.get(branch);
					if (!record) {
						sendJson(res, 404, { error: `unknown worktree branch: ${branch}` });
						return;
					}
					sendJson(res, 200, publicRecord(record));
					return;
				}
				const result = await removeWorktree(branch, {
					force: url.searchParams.get("force") === "1",
				});
				sendJson(res, 200, result);
				return;
			}
			sendJson(res, 404, {
				error: `no such worktree-launcher endpoint: ${method} ${pathname}`,
			});
		} catch (error) {
			const status = typeof error?.status === "number" ? error.status : 500;
			sendJson(res, status, { error: String(error?.message ?? error) });
		}
	}

	function shutdown() {
		records.clear();
		bySession.clear();
		eligible.clear();
		chains.clear();
		prCache.clear();
		titleCache = { at: 0, byId: new Map() };
	}

	return {
		handle,
		shutdown,
		getPref: () => ({ ...pref }),
		setPref(next) {
			if (typeof next !== "boolean") throw new Error("enabled must be a boolean");
			pref.enabled = next;
			return { ...pref };
		},
		createWorktree,
		removeWorktree,
		listWorktrees,
		recordForSession,
		sessionStates,
		prStatusFor,
		markEligible,
		maybeCreateForTurn,
		promptSectionText,
	};
}

/**
 * Cordis plugin body: wire the controller to harness services and clean up
 * behind the plugin fiber.
 * @param {object} ctx - host cordis context (`webServer` + `subprocess` injected).
 * @param {object} [config] - row config `{ cwd?, enabled?, baseBranch?, fetchTimeoutMs?, ghPath?, prTtlMs?, ghTimeoutMs?, debug? }`.
 */
export function apply(ctx, config) {
	const options = config ?? {};
	const sessionQuery = ctx.get("sessionQuery");
	const warn = options.debug ? (message) => console.warn(message) : undefined;
	const launcher = createWorktreeLauncher({
		spawn: (spec) => ctx.subprocess.spawn(spec),
		resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
		defaultRoot: typeof options.cwd === "string" ? options.cwd : undefined,
		baseBranch: typeof options.baseBranch === "string" ? options.baseBranch : undefined,
		fetchTimeoutMs:
			typeof options.fetchTimeoutMs === "number" ? options.fetchTimeoutMs : undefined,
		ghPath: typeof options.ghPath === "string" ? options.ghPath : undefined,
		prTtlMs: typeof options.prTtlMs === "number" ? options.prTtlMs : undefined,
		ghTimeoutMs: typeof options.ghTimeoutMs === "number" ? options.ghTimeoutMs : undefined,
		listSessionTitles: createSessionTitleLister(sessionQuery, { warn }),
		enabled: options.enabled === false ? false : undefined,
		warn,
	});

	const disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: (req, res) => {
			void launcher.handle(req, res);
		},
	});

	const disposeSessionStart = ctx.on("agent/session-start", (payload) => {
		void Promise.resolve(launcher.markEligible(payload)).catch(() => {});
	});
	const disposeInbox = ctx.on("agent/inbox/inserted", (payload) => {
		void Promise.resolve(launcher.maybeCreateForTurn(payload)).catch(() => {});
	});

	const systemPrompt = ctx.get("systemPrompt");
	let disposeSection;
	if (systemPrompt) {
		disposeSection = systemPrompt.section({
			name: "worktree-launcher/session",
			order: 150,
			text: (context) => launcher.promptSectionText(context),
		});
	}

	ctx.on("dispose", () => {
		disposeRoute();
		disposeSessionStart?.();
		disposeInbox?.();
		disposeSection?.();
		launcher.shutdown();
	});
}
