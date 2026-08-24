/**
 * @dsh-plugins/create-pr — host half.
 *
 * A DeepSeek Harness (cordis) plugin that turns the current session's work
 * into a GitHub pull request with ONE click from the composer tool row:
 *
 *   - the browser half renders a "Create PR" button in the composer tool row
 *     (`conversation.input.left`, right beside the Worktree toggle);
 *   - clicking it starts a HOST-SIDE pipeline over `ctx.subprocess` whose every
 *     deterministic step is plain git/gh plumbing (no model tokens):
 *       1. resolve the repo (session cwd -> row config `cwd`), refuse the base
 *          branch and non-GitHub origins;
 *       2. stage + commit uncommitted work — the conventional-commit message
 *          is an LLM call (`ctx.llm` one-shot, strict parse, deterministic
 *          fallback when the service is absent);
 *       3. push the branch and `gh pr create` (adopting an existing PR for
 *          the branch instead of failing). The PR text is its own artifact,
 *          never the raw commit message: the title is a second LLM one-shot
 *          over the WHOLE branch delta (commit subjects + `git diff --stat`
 *          + truncated diff vs the merge base), and the body is assembled
 *          deterministically in the Claude Code / Codex shape — `## Summary`
 *          (LLM bullets or commit-subject fallback), `## Changes` (exact
 *          per-file +/- evidence from the stat digest, zero tokens) and
 *          `## Commits`;
 *   - a CI WATCHDOG hook then polls `gh pr view --json statusCheckRollup`
 *     on a timer until the checks settle. On failure it fetches the failed
 *     steps' logs (`gh run list` + `gh run view --log-failed`), and wakes the
 *     OWNING SESSION with `agent.followup(...)` so the very session that did
 *     the work analyzes the error and pushes a fix; the watchdog keeps
 *     watching the same PR and flips to `passed` once CI is green (bounded by
 *     `maxFixRounds` auto-fix rounds and `maxWatchMs`).
 *
 * HTTP surface: a small loopback-only JSON API under `/create-pr/api`
 * (POST /create, GET /runs, GET /runs/<id>, POST /runs/<id>/cancel).
 *
 * Trust posture matches @dsh-plugins/command-deck: the harness web server
 * binds loopback without auth by design; this surface adds the Host allowlist
 * (localhost/127.0.0.1/[::1]) against DNS rebinding and caps request bodies.
 * Git/gh commands execute with the full privileges of the harness process;
 * `gh` uses the host user's keyring authentication.
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Services this plugin needs before activation. */
export const inject = ["webServer", "subprocess"];

const API_PREFIX = "/create-pr/api";
const MAX_BODY_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 20_000;
const GH_TIMEOUT_MS = 60_000;

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_GRACE_POLLS = 4;
const DEFAULT_MAX_FIX_ROUNDS = 2;
const DEFAULT_MAX_WATCH_MS = 30 * 60_000;

/** LLM input/output budgets — the token frugality contract of this plugin. */
const DIFF_MAX_CHARS = 12_000;
const LOG_TAIL_CHARS = 12_000;
const COMMIT_MAX_TOKENS = 350;
const PR_MAX_TOKENS = 500;

const BASE_BRANCHES = new Set(["main", "master"]);

/** Terminal run statuses: the client stops polling on any of these. */
export const TERMINAL_STATUSES = new Set([
	"passed",
	"failed",
	"expired",
	"cancelled",
	"error",
]);

/**
 * A conventional-commit subject: `<type>(<scope>)?!: <description>`. Exported
 * for tests; the LLM output must match or the deterministic fallback wins.
 */
export const CONVENTIONAL_SUBJECT_RE =
	/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: \S.{3,160}$/i;

const BAD_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"STARTUP_FAILURE",
	"ACTION_REQUIRED",
	"CANCELLED",
	"ERROR",
]);
const GOOD_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const BAD_RUN_CONCLUSIONS = new Set([
	"failure",
	"timed_out",
	"startup_failure",
	"action_required",
	"cancelled",
]);

function httpStatusError(status, message) {
	return Object.assign(new Error(message), { status });
}

function oneLine(text) {
	return String(text ?? "").replace(/\s+/g, " ").trim();
}

function tail(text, maxChars) {
	const raw = String(text ?? "");
	return raw.length <= maxChars ? raw : raw.slice(raw.length - maxChars);
}

// --------------------------------------------------------------- pure helpers

/**
 * Extract `{owner, repo}` from a GitHub remote URL (https, ssh, or git
 * protocol forms). Returns undefined when the remote is not GitHub.
 */
export function parseGitHubOwnerRepo(remoteUrl) {
	const match = String(remoteUrl ?? "")
		.trim()
		.match(/github\.com[/:]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/i);
	if (!match) return undefined;
	return { owner: match[1], repo: match[2] };
}

/**
 * Normalize one `statusCheckRollup` entry (CheckRun, StatusContext, or
 * WorkflowRun shapes) into `{name, conclusion}` where conclusion is drawn
 * from the BAD/GOOD vocabularies above (UNKNOWN/PENDING = still running).
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
 * Classify a full rollup snapshot: `failed` wins over pending, an empty
 * rollup is `empty` (checks not registered yet — the caller applies grace).
 */
export function classifyChecks(rollup) {
	const entries = Array.isArray(rollup) ? rollup : [];
	const checks = entries.map(normalizeCheck);
	if (checks.length === 0) return { outcome: "empty", checks };
	let failed = false;
	let pending = false;
	for (const check of checks) {
		if (BAD_CONCLUSIONS.has(check.conclusion)) failed = true;
		else if (!GOOD_CONCLUSIONS.has(check.conclusion)) pending = true;
	}
	if (failed) return { outcome: "failed", checks };
	if (pending) return { outcome: "pending", checks };
	return { outcome: "passed", checks };
}

/**
 * Parse an LLM reply into `{subject, body}`. The subject must be the first
 * non-empty line and must satisfy {@link CONVENTIONAL_SUBJECT_RE}; surrounding
 * fences/backticks are tolerated. Returns undefined otherwise.
 */
export function parseConventionalMessage(text) {
	const lines = String(text ?? "")
		.split("\n")
		.map((line) => line.replace(/\r$/, "").replace(/^```+\s*|```\s*$/g, "").trimEnd());
	const subjectLine = lines.find((line) => line.trim().length > 0);
	if (!subjectLine) return undefined;
	const subject = subjectLine.replace(/^[`*\s]+|[`*\s]+$/g, "").trim();
	if (!CONVENTIONAL_SUBJECT_RE.test(subject)) return undefined;
	const index = lines.indexOf(subjectLine);
	const body = lines
		.slice(index + 1)
		.join("\n")
		.trim();
	return { subject: subject.slice(0, 200), body: body.slice(0, 4_000) };
}

/** Section caps of the generated PR body — keeps `gh pr create --body` sane. */
const MAX_BODY_FILES = 40;
const MAX_BODY_COMMITS = 20;

/**
 * Parse `git diff --stat` output into per-file entries
 * `{path, insertions, deletions, binary}`. Insertion/deletion counts are read
 * from the +/- glyph bar (a scaled bar is approximate by design); binary files
 * (`img.png | Bin 0 -> 123 bytes`) report `{binary: true}`. The trailing
 * "N files changed…" summary line has no `|` column and never matches.
 */
export function parseStatEntries(statText) {
	const entries = [];
	for (const line of String(statText ?? "").split("\n")) {
		const text = line.replace(/\r$/, "");
		if (!text.trim()) continue;
		const pipeAt = text.indexOf("|");
		const graph = pipeAt >= 0 ? text.slice(pipeAt).match(/^\|\s+(\d+)\s*([+-]*)$/) : null;
		if (graph) {
			entries.push({
				path: text.slice(0, pipeAt).trim(),
				insertions: (graph[2].match(/\+/g) ?? []).length,
				deletions: (graph[2].match(/-/g) ?? []).length,
				binary: false,
			});
			continue;
		}
		const binary = text.match(/^\s*(.+?)\s+\|\s+Bin\b/);
		if (binary) {
			entries.push({ path: binary[1].trim(), insertions: 0, deletions: 0, binary: true });
		}
	}
	return entries;
}

function formatStatEntry(entry) {
	if (entry.binary) return `${entry.path} (binary)`;
	const parts = [];
	if (entry.insertions > 0) parts.push(`+${entry.insertions}`);
	if (entry.deletions > 0) parts.push(`-${entry.deletions}`);
	return `${entry.path} (${parts.join(" ") || "no line change"})`;
}

function cleanSubjects(commitSubjects) {
	return (Array.isArray(commitSubjects) ? commitSubjects : [])
		.map((subject) => String(subject ?? "").trim())
		.filter(Boolean);
}

/**
 * Assemble the deterministic skeleton of the PR conversation body — the
 * Claude Code / Codex shape: a summary (LLM or fallback) followed by the exact
 * impacted files and the branch's commit subjects. The file/action evidence is
 * pure `git diff --stat` shaping and costs zero tokens.
 */
export function buildPrBody({ summary, statText, commitSubjects } = {}) {
	const trimmedSummary = String(summary ?? "").trim();
	const sections = ["## Summary", trimmedSummary || "_No summary available._"];
	const entries = parseStatEntries(statText);
	if (entries.length > 0) {
		sections.push("", "## Changes");
		for (const entry of entries.slice(0, MAX_BODY_FILES)) {
			sections.push(`- ${formatStatEntry(entry)}`);
		}
		if (entries.length > MAX_BODY_FILES) {
			sections.push(`- …and ${entries.length - MAX_BODY_FILES} more changed files`);
		}
	}
	const subjects = cleanSubjects(commitSubjects);
	if (subjects.length > 0) {
		sections.push("", "## Commits");
		for (const subject of subjects.slice(0, MAX_BODY_COMMITS)) {
			sections.push(`- ${subject}`);
		}
		if (subjects.length > MAX_BODY_COMMITS) {
			sections.push(`- …and ${subjects.length - MAX_BODY_COMMITS} more commits`);
		}
	}
	return sections.join("\n");
}

const TYPE_PRIORITY = [
	"feat",
	"fix",
	"perf",
	"refactor",
	"docs",
	"test",
	"build",
	"ci",
	"style",
	"chore",
	"revert",
];

function dominantConventionalType(subjects) {
	const counts = new Map();
	for (const subject of subjects) {
		const match = String(subject).match(
			/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(|:)/i,
		);
		if (!match) continue;
		const type = match[1].toLowerCase();
		counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	for (const type of TYPE_PRIORITY) {
		if (counts.get(type)) return type;
	}
	return undefined;
}

/** The commit scope only becomes the PR scope when EVERY commit agrees on it. */
function sharedScope(subjects) {
	let scope;
	for (const subject of subjects) {
		const match = String(subject).match(/^[a-z]+\(([^)]+)\)/i);
		if (!match) return undefined;
		if (scope === undefined) scope = match[1];
		else if (scope !== match[1]) return undefined;
	}
	return scope;
}

function inferTypeFromPaths(paths) {
	if (paths.length === 0) return undefined;
	if (paths.every((f) => /\.md$|\.txt$|^docs\//i.test(f))) return "docs";
	if (
		paths.every(
			(f) => /(^|\/)(tests?|__tests__)\//i.test(f) || /\.(test|spec)\.[jt]sx?$/i.test(f),
		)
	) {
		return "test";
	}
	return undefined;
}

function plural(count, unit) {
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function fileSummaryBullets(subjects) {
	if (subjects.length === 0) return "_No summary available._";
	const lines = subjects.slice(0, 10).map((subject) => `- ${subject}`);
	if (subjects.length > 10) lines.push(`- …and ${subjects.length - 10} more commits`);
	return lines.join("\n");
}

/**
 * Deterministic fallback message (used when no `llm` service answered with a
 * valid conventional subject). Pure string shaping over file paths / commit
 * subjects — zero tokens. In `pr` mode the title reuses a single conventional
 * commit subject verbatim when there is exactly one, otherwise it derives the
 * dominant type/scope from the branch commits ("feat(api): land 2 commits
 * across 5 files"). The returned body is only the free-text part; the caller
 * wraps it with {@link buildPrBody} for the structured sections.
 */
export function deterministicFallbackMessage({ mode, statText, commitSubjects } = {}) {
	const entries = parseStatEntries(statText);
	const paths = [...new Set(entries.map((entry) => entry.path))];
	const subjects = cleanSubjects(commitSubjects);
	if (mode !== "pr") {
		const allDocs = paths.length > 0 && paths.every((f) => /\.md$|\.txt$|^docs\//i.test(f));
		const allTests =
			paths.length > 0 &&
			paths.every(
				(f) => /(^|\/)(tests?|__tests__)\//i.test(f) || /\.(test|spec)\.[jt]sx?$/i.test(f),
			);
		const type = allDocs ? "docs" : allTests ? "test" : "chore";
		const dirs = [
			...new Set(paths.map((f) => f.split("/")[0]).filter((d) => d && d !== "." && d !== "..")),
		].slice(0, 3);
		const scope = dirs.length > 0 ? ` (${dirs.join(", ")})` : "";
		const body = paths
			.slice(0, 8)
			.map((path) => `- ${path}`)
			.concat(paths.length > 8 ? [`- …and ${paths.length - 8} more files`] : [])
			.join("\n");
		return {
			subject: `${type}: update ${plural(paths.length || 1, "file")}${scope}`,
			body,
		};
	}
	// pr mode: a single conventional commit IS the honest PR title.
	if (subjects.length === 1 && CONVENTIONAL_SUBJECT_RE.test(subjects[0])) {
		return { subject: subjects[0].slice(0, 200), body: "" };
	}
	const type =
		dominantConventionalType(subjects) ??
		inferTypeFromPaths(paths) ??
		"chore";
	const scope = sharedScope(subjects);
	const scopePart = scope ? `(${scope})` : "";
	let description;
	if (subjects.length > 1) {
		description = `land ${plural(subjects.length, "commit")} across ${plural(entries.length, "file")}`;
	} else if (entries.length > 0) {
		description = `update ${plural(entries.length, "file")}`;
	} else {
		description = "open pull request for this branch";
	}
	return { subject: `${type}${scopePart}: ${description}`.slice(0, 200), body: "" };
}

/** Pull the first GitHub PR URL (+number) out of gh stdout/stderr text. */
export function extractPrUrl(text) {
	const match = String(text ?? "").match(
		/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/,
	);
	if (!match) return undefined;
	return { url: match[0], number: Number(match[1]) };
}

// ------------------------------------------------------------------ controller

/**
 * Build the create-pr controller. Factored out of {@link apply} so the whole
 * pipeline (git plumbing, gh calls, LLM one-shot, watchdog) is testable
 * without cordis against stub services and real temporary repositories.
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable - ctx.subprocess.resolveExecutable.
 * @param {string} [deps.defaultRoot] - repo used when a request has neither root nor resolvable session.
 * @param {string} [deps.baseBranch] - force the PR base instead of the repo default.
 * @param {boolean} [deps.draft] - open pull requests as drafts by default.
 * @param {number} [deps.pollIntervalMs] - watchdog poll period.
 * @param {number} [deps.checksGracePolls] - empty-rollup polls tolerated before "no checks".
 * @param {number} [deps.maxFixRounds] - automatic followup wake budget per run.
 * @param {number} [deps.maxWatchMs] - total watchdog budget per run.
 * @param {string} [deps.ghPath] - explicit gh executable (default: resolve "gh").
 * @param {{stream?: Function}} [deps.llm] - optional ctx.llm (streaming model calls).
 * @param {() => ({provider: string, model: string}|undefined)} [deps.modelSelection].
 * @param {(sessionId: string) => {followup?: Function}|undefined} [deps.resolveAgent].
 * @param {(message: string) => void} [deps.warn] - sink for best-effort failures.
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] - injectable scheduler.
 */
export function createPrLauncher(deps) {
	const spawn = deps.spawn;
	const resolveExecutable = deps.resolveExecutable;
	const defaultRoot =
		typeof deps.defaultRoot === "string" && deps.defaultRoot.trim()
			? resolve(deps.defaultRoot.trim())
			: undefined;
	const baseBranchOverride =
		typeof deps.baseBranch === "string" && deps.baseBranch.trim()
			? deps.baseBranch.trim()
			: undefined;
	const draftDefault = deps.draft === true;
	const pollIntervalMs =
		typeof deps.pollIntervalMs === "number" && deps.pollIntervalMs > 0
			? deps.pollIntervalMs
			: DEFAULT_POLL_MS;
	const gracePolls =
		typeof deps.checksGracePolls === "number" && deps.checksGracePolls >= 0
			? deps.checksGracePolls
			: DEFAULT_GRACE_POLLS;
	const maxFixRounds =
		typeof deps.maxFixRounds === "number" && deps.maxFixRounds >= 0
			? deps.maxFixRounds
			: DEFAULT_MAX_FIX_ROUNDS;
	const maxWatchMs =
		typeof deps.maxWatchMs === "number" && deps.maxWatchMs > 0
			? deps.maxWatchMs
			: DEFAULT_MAX_WATCH_MS;
	const llm = typeof deps.llm?.stream === "function" ? deps.llm : undefined;
	const modelSelection =
		typeof deps.modelSelection === "function" ? deps.modelSelection : () => undefined;
	const resolveAgent =
		typeof deps.resolveAgent === "function" ? deps.resolveAgent : () => undefined;
	const warn = typeof deps.warn === "function" ? deps.warn : () => {};
	const scheduleTimeout = deps.timers?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const cancelTimeout = deps.timers?.clearTimeout ?? ((handle) => clearTimeout(handle));

	/** runId -> record (insertion ordered). */
	const runs = new Map();
	/** runId -> pending watchdog timer handle. */
	const watchers = new Map();
	/** repo top -> tail promise serializing pipelines touching one repo. */
	const chains = new Map();

	const executables = new Map();
	async function executable(key) {
		if (!executables.has(key)) {
			const wanted = key === "gh" && typeof deps.ghPath === "string" && deps.ghPath.trim()
				? deps.ghPath.trim()
				: key;
			executables.set(
				key,
				resolveExecutable(wanted).catch((error) => {
					executables.delete(key);
					throw error;
				}),
			);
		}
		return executables.get(key);
	}

	// ------------------------------------------------------------ process I/O

	async function runProc(kind, argv, options = {}) {
		const cwd = options.cwd;
		const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
		const bin = await executable(kind);
		const handle = spawn({
			argv: [bin, ...argv],
			cwd,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: options.stdoutMaxBytes ?? 512 * 1024 },
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
		if (timedOut) throw new Error(`${kind} ${argv[0]} timed out after ${timeoutMs}ms`);
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

	async function runGh(argv, options = {}) {
		return runProc("gh", argv, options);
	}

	async function gitOut(argv, cwd) {
		const result = await runGit(argv, { cwd });
		if (result.code !== 0) {
			throw httpStatusError(
				500,
				`git ${argv[0]} failed:${result.err ? ` ${oneLine(result.err)}` : ""}`,
			);
		}
		return result.out;
	}

	async function ghJson(argv, options = {}) {
		const result = await runGh(argv, options);
		try {
			return JSON.parse(result.out);
		} catch {
			throw httpStatusError(
				502,
				`gh ${argv[0]} returned invalid JSON:${result.err ? ` ${oneLine(result.err)}` : ""}`,
			);
		}
	}

	// ------------------------------------------------------------- resolution

	async function resolveRepoTop(root) {
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
		const top = topResult.out.split("\n")[0]?.trim();
		if (!top) {
			throw httpStatusError(
				400,
				`not a git repository: ${root}${topResult.err ? ` (${oneLine(topResult.err)})` : ""}`,
			);
		}
		return top;
	}

	function rootFor(input) {
		const explicit =
			typeof input.root === "string" && input.root.trim() ? resolve(input.root.trim()) : undefined;
		if (explicit) return Promise.resolve(explicit);
		if (typeof input.sessionId === "string" && input.sessionId.trim()) {
			const agent = resolveAgent(input.sessionId.trim());
			const cwd = agent?.session?.header?.cwd;
			if (typeof cwd === "string" && cwd.trim()) return Promise.resolve(resolve(cwd));
		}
		if (defaultRoot) return Promise.resolve(defaultRoot);
		throw httpStatusError(
			400,
			"cannot resolve a repository: provide 'root'/'sessionId' or configure the row's 'cwd'",
		);
	}

	function slugFor(top) {
		return (async () => {
			const url = await gitOut(["config", "--get", "remote.origin.url"], top);
			const slug = parseGitHubOwnerRepo(url);
			if (!slug) {
				throw httpStatusError(
					400,
					`origin is not a GitHub remote: ${oneLine(url)}`,
				);
			}
			return slug;
		})();
	}

	async function detectBaseBranch(top) {
		if (baseBranchOverride) return baseBranchOverride;
		for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
			const probe = await runGit(["rev-parse", "--verify", "--quiet", candidate], { cwd: top });
			if (probe.code === 0 && probe.out.trim()) {
				return candidate.replace(/^origin\//, "");
			}
		}
		return undefined;
	}

	// ------------------------------------------------------- commit messaging

	/**
	 * One bounded LLM round-trip. Returns the raw text, or undefined when no
	 * `llm` service is wired, no model is selected, the transport fails, or the
	 * stream ends abnormally — every caller degrades to its deterministic
	 * fallback in that case.
	 */
	async function askModel(parts, maxTokens) {
		if (!llm) return undefined;
		const selection = modelSelection();
		if (!selection?.provider || !selection?.model) return undefined;
		let text = "";
		try {
			const stream = llm.stream({
				provider: selection.provider,
				model: selection.model,
				messages: [
					{
						id: randomUUID(),
						role: "user",
						content: [{ type: "text", text: parts.join("\n") }],
						source: { kind: "plugin", plugin: "@dsh-plugins/create-pr" },
					},
				],
				system:
					"You are a release engineer. Reply with the requested message ONLY: no markdown fences, no backticks around the subject, nothing before or after the message.",
				temperature: 0.2,
				maxTokens,
			});
			for await (const chunk of stream) {
				if (chunk?.type === "text-delta") text += chunk.text;
				if (chunk?.type === "finish" && chunk.reason && chunk.reason.kind !== "stop") {
					return undefined;
				}
			}
		} catch (error) {
			warn(`create-pr: message LLM call failed: ${error?.message ?? error}`);
			return undefined;
		}
		return text;
	}

	/** Commit message for uncommitted work: conventional subject + ≤3 bullets. */
	async function composeCommitMessage({ statText, diffText }) {
		const fallback = deterministicFallbackMessage({ mode: "commit", statText });
		const text = await askModel(
			[
				"Staged change about to be committed:",
				"",
				"File stats:",
				statText,
				"",
				"Diff (truncated):",
				diffText,
				"",
				"Write ONE conventional-commit message (type(scope)?: imperative description) summarizing this implementation, then a blank line, then at most 3 short body bullets.",
			],
			COMMIT_MAX_TOKENS,
		);
		return text ? (parseConventionalMessage(text) ?? fallback) : fallback;
	}

	/**
	 * PR title + summary over the WHOLE branch delta (commits, file stats and a
	 * truncated diff vs the merge base). The title must be a conventional
	 * subject; the summary bullets ride into the body's `## Summary` section.
	 * The `## Changes` / `## Commits` sections are appended deterministically by
	 * {@link buildPrBody} — they never depend on the model answering.
	 */
	async function composePrMessage({ statText, diffText, commitSubjects }) {
		const subjects = cleanSubjects(commitSubjects);
		const fallback = deterministicFallbackMessage({
			mode: "pr",
			statText,
			commitSubjects: subjects,
		});
		const text = await askModel(
			[
				`A branch is about to be opened as ONE GitHub pull request (${plural(subjects.length, "commit")}, ${plural(parseStatEntries(statText).length, "changed file")}).`,
				"",
				"Branch commit subjects:",
				subjects.map((subject) => `- ${subject}`).join("\n") || "(none recorded)",
				"",
				"File stats against the base branch:",
				statText || "(unavailable)",
				"",
				"Diff (truncated):",
				diffText || "(unavailable)",
				"",
				"Write the pull request title and summary:",
				"1. First line: ONE conventional-commit style title (feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert, optional scope, ': ', imperative description) summarizing the WHOLE branch.",
				"2. Then one blank line, then at most 5 short markdown bullets starting with '- ' describing what this change does and why — lead with user-visible behavior, not file-by-file narration.",
			],
			PR_MAX_TOKENS,
		);
		const parsed = text ? parseConventionalMessage(text) : undefined;
		const summary = parsed?.body || fileSummaryBullets(subjects);
		return {
			subject: parsed?.subject ?? fallback.subject,
			body: buildPrBody({ summary, statText, commitSubjects: subjects }),
		};
	}

	// ------------------------------------------------------------ branch digest

	async function revParseCommit(top, ref) {
		const probe = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
			cwd: top,
		});
		return probe.code === 0 ? probe.out.split("\n")[0]?.trim() || undefined : undefined;
	}

	/**
	 * Evidence bundle for the PR composer: everything between the fork point of
	 * `base` and HEAD — commit subjects, `git diff --stat` digest and a capped
	 * full diff. Each piece degrades independently to "" so an unusual ref
	 * layout degrades the summary instead of failing the run.
	 */
	async function collectBranchDigest(top, base) {
		const head = await revParseCommit(top, "HEAD");
		const baseSha = base
			? (await revParseCommit(top, base)) ?? (await revParseCommit(top, `origin/${base}`))
			: undefined;
		let range = "";
		if (head && baseSha) {
			const mergeBase = await runGit(["merge-base", baseSha, head], { cwd: top });
			range =
				mergeBase.code === 0 && mergeBase.out.trim()
					? `${mergeBase.out.trim()}..${head}`
					: `${baseSha}..${head}`;
		}
		const safeOut = async (argv) => {
			try {
				return await gitOut(argv, top);
			} catch {
				return "";
			}
		};
		const [logText, statText, diffRaw] = await Promise.all([
			safeOut(
				range ? ["log", "--format=%s", range] : ["log", "--format=%s", "-n", "10", "HEAD"],
			),
			safeOut(range ? ["diff", "--stat", range] : ["diff", "--stat", "HEAD~10..HEAD"]),
			safeOut(range ? ["diff", range] : []),
		]);
		return {
			statText,
			diffText: tail(diffRaw, DIFF_MAX_CHARS),
			// Chronological order (oldest -> newest) reads like a change story.
			commitSubjects: logText
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.reverse(),
		};
	}

	// ---------------------------------------------------------- the pipeline

	function setStatus(record, status) {
		record.status = status;
		record.updatedAt = Date.now();
	}

	function publicRecord(record) {
		return {
			id: record.id,
			root: record.root,
			branch: record.branch,
			slug: record.slug,
			sessionId: record.sessionId ?? null,
			status: record.status,
			prNumber: record.prNumber ?? null,
			prUrl: record.prUrl ?? null,
			prTitle: record.prTitle ?? null,
			commitSha: record.commitSha ?? null,
			commitSubject: record.commitSubject ?? null,
			checks: Array.isArray(record.checks) ? record.checks.slice(-20) : [],
			fixRounds: record.fixRounds ?? 0,
			note: record.note ?? null,
			error: record.error ?? null,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		};
	}

	async function findExistingPr(slug, branch) {
		try {
			const list = await ghJson([
				"pr",
				"list",
				"--head",
				branch,
				"-R",
				`${slug.owner}/${slug.repo}`,
				"--limit",
				"1",
				"--json",
				"url,number,state",
			]);
			const found = Array.isArray(list) ? list[0] : undefined;
			if (found && typeof found.number === "number" && found.url) return found;
		} catch {
			/* treat as absent; pr create will surface reality */
		}
		return undefined;
	}

	async function collectFailureLog(record) {
		let runId;
		try {
			const listed = await ghJson(
				[
					"run",
					"list",
					"--branch",
					record.branch,
					"-R",
					`${record.slug.owner}/${record.slug.repo}`,
					"--limit",
					"8",
					"--json",
					"databaseId,conclusion,status",
				],
				{ timeoutMs: GH_TIMEOUT_MS },
			);
			const failed = (Array.isArray(listed) ? listed : [])
				.filter((entry) => BAD_RUN_CONCLUSIONS.has(String(entry?.conclusion ?? "").toLowerCase()))
				.sort((a, b) => Number(b.databaseId) - Number(a.databaseId));
			runId = failed[0]?.databaseId;
		} catch (error) {
			warn(`create-pr: run listing failed: ${error?.message ?? error}`);
		}
		if (!runId) return "";
		try {
			const result = await runGh(
				[
					"run",
					"view",
					String(runId),
					"--log-failed",
					"-R",
					`${record.slug.owner}/${record.slug.repo}`,
				],
				{ timeoutMs: GH_TIMEOUT_MS, stdoutMaxBytes: 1024 * 1024 },
			);
			return tail(result.out || result.err, LOG_TAIL_CHARS);
		} catch (error) {
			warn(`create-pr: failed-log fetch failed: ${error?.message ?? error}`);
			return "";
		}
	}

	function buildFixMessage(record, logTail) {
		const failing = (record.checks ?? [])
			.filter((check) => BAD_CONCLUSIONS.has(check.conclusion))
			.map((check) => check.name)
			.join(", ");
		const summary = `CI failed on PR #${record.prNumber}`;
		return {
			summary,
			text: [
				`${summary} (${record.prUrl}) for branch \`${record.branch}\` in ${record.slug.owner}/${record.slug.repo}.`,
				failing ? `Failing checks: ${failing}.` : "",
				"",
				"Failed-step log tail:",
				"```",
				logTail || "(log unavailable)",
				"```",
				"",
				[
					"This message was posted automatically by the DSH create-pr watchdog.",
					`Analyze the failure and fix it IN THIS SESSION, inside the repository working tree at ${record.root}.`,
					"Then commit the correction with a Conventional Commit `fix:` subject and push to the SAME branch (`git push origin ${branch}`).".replace(
						"${branch}",
						record.branch,
					),
					"Do NOT open a new pull request and do NOT rebase: the watchdog keeps polling this PR and will confirm once CI passes.",
				].join(" "),
			]
				.filter((part) => part !== "")
				.join("\n"),
		};
	}

	async function pollRun(runId) {
		const record = runs.get(runId);
		if (!record || TERMINAL_STATUSES.has(record.status)) return;
		if (Date.now() - record.createdAt > maxWatchMs) {
			finishRun(record, "expired", "CI watch budget exceeded");
			return;
		}
		let view;
		try {
			view = await ghJson([
				"pr",
				"view",
				String(record.prNumber),
				"-R",
				`${record.slug.owner}/${record.slug.repo}`,
				"--json",
				"url,number,statusCheckRollup",
			]);
		} catch (error) {
			record.note = oneLine(error.message).slice(0, 300);
			reschedule(record, pollIntervalMs);
			return;
		}
		if (
			view?.url &&
			(typeof view.number !== "number" || view.number === record.prNumber)
		) {
			record.prUrl = view.url;
		}
		const verdict = classifyChecks(view?.statusCheckRollup);
		record.checks = verdict.checks;
		record.updatedAt = Date.now();
		if (verdict.outcome === "pending") {
			reschedule(record, pollIntervalMs);
			return;
		}
		if (verdict.outcome === "empty") {
			record.gracePolls = (record.gracePolls ?? 0) + 1;
			if (record.gracePolls <= gracePolls) {
				reschedule(record, pollIntervalMs);
				return;
			}
			finishRun(record, "passed", "no checks reported for this PR");
			return;
		}
		if (verdict.outcome === "passed") {
			finishRun(record, "passed");
			return;
		}
		// CI failed: gather evidence, wake the owning session within budget.
		const logTail = await collectFailureLog(record);
		const agent = record.sessionId ? resolveAgent(record.sessionId) : undefined;
		if (agent && typeof agent.followup === "function" && record.fixRounds < maxFixRounds) {
			const message = buildFixMessage(record, logTail);
			try {
				agent.followup({
					id: randomUUID(),
					role: "user",
					content: [{ type: "text", text: message.text }],
					source: {
						kind: "plugin",
						plugin: "@dsh-plugins/create-pr",
						form: "notice",
						summary: message.summary,
					},
				});
				record.fixRounds += 1;
				setStatus(record, "fixing");
				record.note = `fix round ${record.fixRounds}/${maxFixRounds}: session woken with the failure logs`;
				reschedule(record, pollIntervalMs * 2);
				return;
			} catch (error) {
				warn(`create-pr: followup wake failed: ${error?.message ?? error}`);
			}
		}
		finishRun(
			record,
			"failed",
			agent
				? "auto-fix budget exhausted; fix manually and re-run"
				: "CI failed and no live session could be woken to fix it",
		);
	}

	function reschedule(record, delayMs) {
		if (!runs.has(record.id) || TERMINAL_STATUSES.has(record.status)) return;
		cancelTimeout(watchers.get(record.id));
		watchers.set(
			record.id,
			scheduleTimeout(() => {
				void Promise.resolve()
					.then(() => pollRun(record.id))
					.catch((error) => {
						warn(`create-pr: watchdog poll crashed: ${error?.message ?? error}`);
						reschedule(record, delayMs);
					});
			}, delayMs),
		);
	}

	function finishRun(record, status, note) {
		cancelTimeout(watchers.get(record.id));
		watchers.delete(record.id);
		record.status = status;
		record.note = note ?? record.note ?? null;
		record.updatedAt = Date.now();
	}

	function startWatching(record) {
		reschedule(record, pollIntervalMs);
	}

	async function pipeline(record, options) {
		const { top } = options;
		// 1. Uncommitted work -> one conventional commit.
	 setStatus(record, "checking");
		const status = await runGit(["status", "--porcelain"], { cwd: top });
		let dirty = status.out.trim().length > 0;
		if (dirty) {
			await runGit(["add", "-A"], { cwd: top });
			const stagedEmpty = await runGit(["diff", "--cached", "--quiet"], { cwd: top });
			if (stagedEmpty.code === 0) dirty = false;
		}
		let base = await detectBaseBranch(top);
		if (dirty) {
			setStatus(record, "committing");
			const statOut = await gitOut(["diff", "--cached", "--stat"], top);
			const diffText = tail(await gitOut(["diff", "--cached"], top), DIFF_MAX_CHARS);
			const composedCommit = await composeCommitMessage({
				statText: statOut,
				diffText,
			});
			const args = ["commit", "-m", composedCommit.subject];
			if (composedCommit.body) args.push("-m", composedCommit.body);
			await runGit(args, { cwd: top });
			record.commitSubject = composedCommit.subject;
		}
		record.commitSha = await gitOut(["rev-parse", "HEAD"], top);

		// 2. Push the branch (before composing the PR text: an adopted PR needs
		//    no title/body and must not spend a single token).
		setStatus(record, "pushing");
		await runGit(["push", "-u", "origin", record.branch], {
			cwd: top,
			timeoutMs: GH_TIMEOUT_MS,
		});

		// 3. Open (or adopt) the pull request.
		setStatus(record, "creating");
		const existing = await findExistingPr(record.slug, record.branch);
		if (existing) {
			record.prNumber = existing.number;
			record.prUrl = existing.url;
			record.note = "existing PR adopted";
		} else {
			const digest = await collectBranchDigest(top, base);
			const composed = await composePrMessage(digest);
			record.prTitle = composed.subject;
			const args = [
				"pr",
				"create",
				"-R",
				`${record.slug.owner}/${record.slug.repo}`,
				"--head",
				record.branch,
				"--title",
				composed.subject,
				"--body",
				[composed.body, "---", "_Opened via the DSH create-pr plugin._"]
					.filter((part) => part.trim().length > 0)
					.join("\n\n"),
			];
			if (!base) base = await detectBaseBranch(top);
			if (base) args.push("--base", base);
			if (options.draft || draftDefault) args.push("--draft");
			const created = await runGh(args, { timeoutMs: GH_TIMEOUT_MS });
			const extracted = extractPrUrl(`${created.out}\n${created.err}`);
			if (extracted) {
				record.prNumber = extracted.number;
				record.prUrl = extracted.url;
			} else if (/already exists/i.test(created.err)) {
				const adopted = await findExistingPr(record.slug, record.branch);
				if (adopted) {
					record.prNumber = adopted.number;
					record.prUrl = adopted.url;
					record.note = "existing PR adopted";
				}
			}
			if (!record.prNumber) {
				throw httpStatusError(
					502,
					`gh pr create produced no PR URL:${created.err ? ` ${oneLine(created.err)}` : ""}`,
				);
			}
		}

		// 4. Arm the CI watchdog hook.
		setStatus(record, "waiting-ci");
		startWatching(record);
	}

	async function createRun(input = {}) {
		const rootInput = await rootFor(input);
		const top = await resolveRepoTop(rootInput);
		const branch = await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], top);
		if (!branch || branch === "HEAD") {
			throw httpStatusError(400, "detached HEAD: check out a feature branch first");
		}
		if (BASE_BRANCHES.has(branch)) {
			throw httpStatusError(
				400,
				`refusing to open a PR from the base branch '${branch}'; work on a feature branch`,
			);
		}
		const slug = await slugFor(top);
		const previous = chains.get(top) ?? Promise.resolve();
		const run = previous.catch(() => {}).then(() =>
			pipelineLocked({ top, slug, branch, input }),
		);
		// The chain waits for the WHOLE pipeline, serializing git mutations per repo.
		chains.set(
			top,
			run.then((locked) => locked.done).catch(() => {}),
		);
		return run.then((locked) => publicRecord(locked.record));
	}

	async function pipelineLocked({ top, slug, branch, input }) {
		const record = {
			id: randomUUID(),
			root: top,
			branch,
			slug,
			sessionId:
				typeof input.sessionId === "string" && input.sessionId.trim()
					? input.sessionId.trim()
					: null,
			status: "preparing",
			prNumber: null,
			prUrl: null,
			commitSha: null,
			commitSubject: null,
			checks: [],
			gracePolls: 0,
			fixRounds: 0,
			note: null,
			error: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		runs.set(record.id, record);
		const done = Promise.resolve()
			.then(() => pipeline(record, { top, draft: input.draft === true }))
			.catch((error) => {
				record.error = oneLine(error.message).slice(0, 500);
				record.status = "error";
				record.updatedAt = Date.now();
				warn(`create-pr: run ${record.id} failed: ${record.error}`);
			});
		return { record, done };
	}

	function listRuns() {
		return [...runs.values()].map(publicRecord).sort((a, b) => b.createdAt - a.createdAt);
	}

	function runRecord(runId) {
		const record = runs.get(String(runId));
		return record ? publicRecord(record) : undefined;
	}

	function cancelRun(runId) {
		const record = runs.get(String(runId));
		if (!record) throw httpStatusError(404, `unknown run: ${runId}`);
		if (!TERMINAL_STATUSES.has(record.status)) finishRun(record, "cancelled");
		return publicRecord(record);
	}

	function shutdown() {
		for (const handle of watchers.values()) cancelTimeout(handle);
		watchers.clear();
		runs.clear();
		chains.clear();
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
			sendJson(res, 403, { error: "create-pr: local connections only" });
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
			if (method === "POST" && pathname === `${API_PREFIX}/create`) {
				const body = await readBody(req);
				const record = await createRun(body ?? {});
				sendJson(res, 202, record);
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/runs`) {
				sendJson(res, 200, { runs: listRuns() });
				return;
			}
			const idMatch = pathname.match(/^\/create-pr\/api\/runs\/([^/]+)(\/cancel)?$/);
			if (idMatch) {
				const runId = decodeURIComponent(idMatch[1]);
				if (idMatch[2]) {
					if (method !== "POST") {
						sendJson(res, 405, { error: "use POST to cancel a run" });
						return;
					}
					sendJson(res, 200, cancelRun(runId));
					return;
				}
				if (method !== "GET") {
					sendJson(res, 405, { error: "use GET to read a run" });
					return;
				}
				const record = runRecord(runId);
				if (!record) {
					sendJson(res, 404, { error: `unknown run: ${runId}` });
					return;
				}
				sendJson(res, 200, record);
				return;
			}
			sendJson(res, 404, {
				error: `no such create-pr endpoint: ${method} ${pathname}`,
			});
		} catch (error) {
			const status = typeof error?.status === "number" ? error.status : 500;
			sendJson(res, status, { error: String(error?.message ?? error) });
		}
	}

	return {
		handle,
		shutdown,
		createRun,
		listRuns,
		runRecord,
		cancelRun,
	};
}

/**
 * Cordis plugin body: wire the controller to harness services and clean up
 * behind the plugin fiber.
 * @param {object} ctx - host cordis context (`webServer` + `subprocess` injected).
 * @param {object} [config] - row config
 *   `{ cwd?, baseBranch?, draft?, pollIntervalMs?, checksGracePolls?,
 *      maxFixRounds?, maxWatchMs?, ghPath?, debug? }`.
 */
export function apply(ctx, config) {
	const options = config ?? {};

	// Every watchdog timer belongs to this fiber: tracked here, cleared on dispose.
	const timers = new Set();
	const safeSchedule = (fn, ms) => {
		const handle = setTimeout(() => {
			timers.delete(handle);
			fn();
		}, ms);
		timers.add(handle);
		return handle;
	};
	const safeCancel = (handle) => {
		clearTimeout(handle);
		timers.delete(handle);
	};

	const launcher = createPrLauncher({
		spawn: (spec) => ctx.subprocess.spawn(spec),
		resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
		defaultRoot: typeof options.cwd === "string" ? options.cwd : undefined,
		baseBranch: typeof options.baseBranch === "string" ? options.baseBranch : undefined,
		draft: options.draft === true,
		pollIntervalMs:
			typeof options.pollIntervalMs === "number" ? options.pollIntervalMs : undefined,
		checksGracePolls:
			typeof options.checksGracePolls === "number" ? options.checksGracePolls : undefined,
		maxFixRounds: typeof options.maxFixRounds === "number" ? options.maxFixRounds : undefined,
		maxWatchMs: typeof options.maxWatchMs === "number" ? options.maxWatchMs : undefined,
		ghPath: typeof options.ghPath === "string" ? options.ghPath : undefined,
		llm: ctx.get("llm") ?? undefined,
		modelSelection: () => {
			const service = ctx.get("agentDefaultModel");
			if (!service) return undefined;
			try {
				return service.currentSelection();
			} catch {
				return undefined;
			}
		},
		resolveAgent: (sessionId) => {
			const agents = ctx.get("agents");
			if (!agents || typeof agents.get !== "function") return undefined;
			try {
				const agent = agents.get(sessionId);
				return agent && typeof agent.followup === "function" ? agent : undefined;
			} catch {
				return undefined;
			}
		},
		warn: options.debug ? (message) => console.warn(message) : undefined,
		timers: { setTimeout: safeSchedule, clearTimeout: safeCancel },
	});

	const disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: (req, res) => {
			void launcher.handle(req, res);
		},
	});

	ctx.on("dispose", () => {
		disposeRoute();
		launcher.shutdown();
		for (const handle of timers) clearTimeout(handle);
		timers.clear();
	});
}
