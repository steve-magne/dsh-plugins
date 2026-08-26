/**
 * @dsh-plugins/merge-pilot — host half.
 *
 * A DeepSeek Harness (cordis) plugin bringing the GitHub-Copilot-app
 * "Agent Merge" pillar to the DSH web surface: register ANY pull request and
 * a host-side supervisor loop carries it through review, checks, and merge
 * conditions —
 *
 *   1. polls `gh pr view` (rollup, reviewDecision, mergeability) on a timer;
 *   2. when CI fails it fetches the failed steps' logs (`gh run list` +
 *      `gh run view --log-failed`) and wakes the OWNING SESSION with
 *      `agent.followup(...)` so it analyzes and pushes a fix;
 *   3. when changes are requested it wakes the session with the reviewers'
 *      objections (`latestReviews`);
 *   4. when the PR becomes mergeable (green + approved + mergeable +
 *      non-draft) it either stops on `ready` or — with autoMerge enabled —
 *      performs `gh pr merge` itself using the configured method, retrying
 *      within an attempts budget.
 *
 * Deliberately different from @dsh-plugins/create-pr's post-flight watchdog:
 * merge-pilot supervises ANY PR from creation onward (not only ones this
 * harness created), triages REVIEW feedback in addition to CI failures, and
 * executes the final merge. The two compose cleanly.
 *
 * Trust posture mirrors the other plugins here: loopback-only server, Host
 * allowlist, capped bodies. gh/git commands execute with the full privileges
 * of the harness process; `gh` uses the host user's keyring authentication.
 */

import { randomUUID } from "node:crypto";

export const inject = ["webServer", "subprocess"];

const API_PREFIX = "/merge-pilot/api";
const MAX_BODY_BYTES = 64 * 1024;
const GH_TIMEOUT_MS = 60_000;

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_GRACE_POLLS = 4;
const DEFAULT_MAX_FIX_ROUNDS = 3;
const DEFAULT_MAX_MERGE_ATTEMPTS = 3;
const DEFAULT_MAX_WATCH_MS = 24 * 60 * 60_000;
const MERGE_COOLDOWN_MS = 10_000;

/** Terminal pilot statuses: the client stops its per-pilot polling on these. */
export const TERMINAL_STATUSES = new Set(["merged", "closed", "expired", "cancelled"]);

export const MERGE_METHODS = new Map([
	["squash", "--squash"],
	["merge", "--merge"],
	["rebase", "--rebase"],
]);

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

/**
 * Parse a pull-request reference into `{number, repoFlag?}`. Accepted forms:
 * `https://github.com/o/r/pull/12`, `o/r#12`, `#12`, bare `12`.
 * @returns {{number: number, repoFlag?: string} | {error: string}}
 */
export function parsePullRequestRef(raw) {
	const value = String(raw ?? "").trim();
	if (!value) return { error: "provide a PR number, o/r#N, or a GitHub PR URL" };
	const urlMatch = value.match(
		/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/pull\/(\d+)\/?(?:[?#].*)?$/i,
	);
	if (urlMatch) {
		return { number: Number.parseInt(urlMatch[3], 10), repoFlag: `${urlMatch[1]}/${urlMatch[2]}` };
	}
	const shorthand = value.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
	if (shorthand) {
		return { number: Number.parseInt(shorthand[3], 10), repoFlag: `${shorthand[1]}/${shorthand[2]}` };
	}
	const hash = value.match(/^#(\d+)$/);
	if (hash) return { number: Number.parseInt(hash[1], 10) };
	if (/^\d+$/.test(value)) {
		const number = Number.parseInt(value, 10);
		return number > 0 ? { number } : { error: `invalid PR number: ${value}` };
	}
	return { error: `cannot parse the PR reference: ${value}` };
}

/** Extract `{owner, repo}` from a GitHub remote URL (https/ssh forms). */
export function parseGitHubOwnerRepo(remoteUrl) {
	const match = String(remoteUrl ?? "")
		.trim()
		.match(/github\.com[/:]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/i);
	if (!match) return undefined;
	return { owner: match[1], repo: match[2] };
}

/**
 * Normalize one `statusCheckRollup` entry into `{name, conclusion}`
 * (UNKNOWN/PENDING = still running).
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

/** Classify a full rollup snapshot: failed > pending > passed > empty. */
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

/** Per-state counters used by the browser badge row. */
export function summarizeChecks(checks) {
	let passed = 0;
	let failed = 0;
	let pending = 0;
	for (const check of Array.isArray(checks) ? checks : []) {
		if (GOOD_CONCLUSIONS.has(check.conclusion)) passed += 1;
		else if (BAD_CONCLUSIONS.has(check.conclusion)) failed += 1;
		else pending += 1;
	}
	return { passed, failed, pending };
}

/** Validate a merge method name into its gh flag. */
export function mergeMethodFlag(mode) {
	const key = String(mode ?? "squash").toLowerCase();
	const flag = MERGE_METHODS.get(key);
	if (!flag) return { error: `unsupported merge method: ${mode} (use squash|merge|rebase)` };
	return { flag, method: key };
}

/**
 * The pilot control law: given the latest `gh pr view` projection plus the
 * classified check outcome, decide the next status.
 */
export function decideNextStatus({ state, isDraft, mergeable, reviewDecision, checksOutcome }) {
	if (state === "MERGED") return "merged";
	if (state === "CLOSED") return "closed";
	if (checksOutcome === "failed") return "fix-checks";
	if (reviewDecision === "CHANGES_REQUESTED") return "fix-review";
	if (isDraft) return "watching";
	if (checksOutcome !== "passed" && checksOutcome !== "empty") return "watching";
	if (reviewDecision !== "APPROVED") return "watching";
	if (mergeable !== true) return "watching";
	return "ready";
}

function httpError(status, message) {
	return Object.assign(new Error(message), { status });
}

function oneLine(text) {
	return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function tail(text, maxChars) {
	const raw = String(text ?? "");
	return raw.length <= maxChars ? raw : raw.slice(raw.length - maxChars);
}

function nowIso(clock) {
	return new Date(clock()).toISOString();
}

/**
 * Build the controller. Factored out of {@link apply} so the whole loop is
 * testable against a fake `gh` executable, a scripted agents resolver and
 * injectable timers.
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable.
 * @param {string} [deps.defaultCwd] - repository providing origin-derived slug fallbacks.
 * @param {string} [deps.defaultSessionId] - wake target when a request omits one.
 * @param {string} [deps.mode] - default merge method (squash|merge|rebase).
 * @param {boolean} [deps.autoMerge] - default auto-merge policy.
 * @param {boolean} [deps.deleteBranch] - pass --delete-branch when merging.
 * @param {number} [deps.pollMs] - supervisor poll period.
 * @param {number} [deps.checksGracePolls] - empty-rollup patience before "no checks".
 * @param {number} [deps.maxFixRounds] - automatic followup wake budget per pilot.
 * @param {number} [deps.maxMergeAttempts] - auto/manual merge attempt budget.
 * @param {number} [deps.maxWatchMs] - total watch budget per pilot.
 * @param {string} [deps.ghPath] - explicit gh binary instead of PATH lookup.
 * @param {(sessionId: string) => {followup?: Function}|undefined} [deps.resolveAgent].
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers].
 * @param {(message: string) => void} [deps.warn].
 */
export function createMergePilot(deps) {
	const spawn = deps.spawn;
	const resolveExecutable = deps.resolveExecutable;
	const defaultCwd = typeof deps.defaultCwd === "string" ? deps.defaultCwd : process.cwd();
	const defaultSessionId =
		typeof deps.defaultSessionId === "string" ? deps.defaultSessionId : undefined;
	const defaultMode = mergeMethodFlag(deps.mode).error ? "squash" : String(deps.mode ?? "squash").toLowerCase();
	const defaultAutoMerge = deps.autoMerge === true;
	const defaultDeleteBranch = deps.deleteBranch === true;
	const pollMs =
		Number.isFinite(deps.pollMs) && deps.pollMs >= 10 ? deps.pollMs : DEFAULT_POLL_MS;
	const gracePolls =
		Number.isFinite(deps.checksGracePolls) && deps.checksGracePolls >= 0
			? deps.checksGracePolls
			: DEFAULT_GRACE_POLLS;
	const maxFixRounds =
		Number.isFinite(deps.maxFixRounds) && deps.maxFixRounds >= 0 ? deps.maxFixRounds : DEFAULT_MAX_FIX_ROUNDS;
	const maxMergeAttempts =
		Number.isFinite(deps.maxMergeAttempts) && deps.maxMergeAttempts > 0
			? deps.maxMergeAttempts
			: DEFAULT_MAX_MERGE_ATTEMPTS;
	const maxWatchMs =
		Number.isFinite(deps.maxWatchMs) && deps.maxWatchMs > 0 ? deps.maxWatchMs : DEFAULT_MAX_WATCH_MS;
	const ghPath = deps.ghPath;
	const resolveAgent = typeof deps.resolveAgent === "function" ? deps.resolveAgent : () => undefined;
	const warn = typeof deps.warn === "function" ? deps.warn : () => {};
	const clock = () => Date.now();

	/** id -> record (+ private handle) */
	const pilots = new Map();
	/** id -> pending timer handle */
	const watchers = new Map();

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

	async function run(argv, options = {}) {
		const executable = await resolveExecutable(argv[0]);
		const handle = spawn({
			argv: [executable, ...argv.slice(1)],
			cwd: options.cwd ?? defaultCwd,
			stdio: { stdin: "ignore", stdout: {}, stderr: {} },
			graceMs: 2_000,
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

	async function resolveGhPath() {
		return ghPath ?? (await resolveExecutable("gh"));
	}

	async function runGh(args, options = {}) {
		const gh = await resolveGhPath();
		const result = await run([gh, ...args], options);
		if (result.code !== 0 && !options.tolerateFailure) {
			throw httpError(
				502,
				`gh ${args[0]} ${args[1] ?? ""} failed: ${(result.err || result.out || "gh error").trim().slice(0, 300)}`,
			);
		}
		return result;
	}

	async function ghJson(args, options = {}) {
		const result = await runGh(args, options);
		try {
			return JSON.parse(result.out);
		} catch {
			throw httpError(502, `gh ${args[0]} returned unparsable JSON`);
		}
	}

	/** Resolve the repo slug: explicit flag wins, else origin remote of defaultCwd. */
	async function resolveSlug(explicitRepoFlag) {
		if (typeof explicitRepoFlag === "string" && explicitRepoFlag.trim()) {
			const trimmed = explicitRepoFlag.trim();
			return trimmed.includes("/") ? trimmed : `${trimmed}`;
		}
		const originUrl = await run(["git", "config", "--get", "remote.origin.url"], {
			cwd: defaultCwd,
		}).catch(() => ({ code: 1, out: "" }));
		const slug = parseGitHubOwnerRepo(originUrl.out);
		if (slug) return `${slug.owner}/${slug.repo}`;
		throw httpError(
			400,
			"cannot infer the GitHub repository: pass repo=owner/repo or configure a pilot cwd whose origin points at github.com",
		);
	}

	function publicPilot(record) {
		return {
			id: record.id,
			slug: record.slug,
			prNumber: record.prNumber,
			prUrl: record.prUrl,
			title: record.title,
			branch: record.branch,
			mode: record.mode,
			autoMerge: record.autoMerge,
			deleteBranch: record.deleteBranch,
			sessionId: record.sessionId ?? null,
			status: record.status,
			note: record.note ?? null,
			fixRounds: record.fixRounds,
			mergeTries: record.mergeTries,
			checks: record.checks,
			checkSummary: summarizeChecks(record.checks),
			reviewDecision: record.reviewDecision ?? null,
			isDraft: record.isDraft ?? null,
			mergeable: record.mergeable ?? null,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			timeline: record.timeline.slice(-12),
		};
	}

	function pushTimeline(record, event) {
		record.timeline.push({ at: nowIso(clock), event });
	}

	function setStatus(record, status, note) {
		record.status = status;
		record.note = note ?? null;
		record.updatedAt = clock();
	}

	function scheduleTimeout(fn, ms) {
		return (deps.timers?.setTimeout ?? ((inner, delay) => setTimeout(inner, delay)))(fn, ms);
	}

	function cancelTimeout(handle) {
		if (!handle) return;
		(deps.timers?.clearTimeout ?? ((inner) => clearTimeout(inner)))(handle);
	}

	// ------------------------------------------------------------ gh reads

	const VIEW_FIELDS =
		"url,number,title,state,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup,mergeable";

	async function fetchView(record) {
		return ghJson([
			"pr",
			"view",
			String(record.prNumber),
			"-R",
			record.slug,
			"--json",
			VIEW_FIELDS,
		], { timeoutMs: GH_TIMEOUT_MS });
	}

	/** Tail of the newest failed Actions run for the pilot's branch. */
	async function collectFailureLog(record) {
		let runId;
		try {
			const listed = await ghJson([
				"run",
				"list",
				"--branch",
				record.branch,
				"-R",
				record.slug,
				"--limit",
				"8",
				"--json",
				"databaseId,conclusion,status",
			], { timeoutMs: GH_TIMEOUT_MS });
			const failed = (Array.isArray(listed) ? listed : [])
				.filter((entry) => BAD_RUN_CONCLUSIONS.has(String(entry?.conclusion ?? "").toLowerCase()))
				.sort((a, b) => Number(b.databaseId) - Number(a.databaseId));
			runId = failed[0]?.databaseId;
		} catch (error) {
			warn(`merge-pilot: run listing failed: ${error?.message ?? error}`);
		}
		if (!runId) return "";
		try {
			const result = await runGh([
				"run",
				"view",
				String(runId),
				"--log-failed",
				"-R",
				record.slug,
			], { timeoutMs: GH_TIMEOUT_MS, tolerateFailure: true });
			return tail(result.out || result.err, 12_000);
		} catch (error) {
			warn(`merge-pilot: failed-log fetch failed: ${error?.message ?? error}`);
			return "";
		}
	}

	/** Logins of reviewers currently requesting changes (best-effort). */
	async function collectRequestingReviewers(record) {
		try {
			const view = await ghJson([
				"pr",
				"view",
				String(record.prNumber),
				"-R",
				record.slug,
				"--json",
				"latestReviews",
			], { timeoutMs: GH_TIMEOUT_MS });
			const reviews = Array.isArray(view?.latestReviews) ? view.latestReviews : [];
			return reviews
				.filter((review) => String(review?.state ?? "").toUpperCase() === "CHANGES_REQUESTED")
				.map((review) =>
					typeof review?.author?.login === "string" ? review.author.login : null,
				)
				.filter(Boolean)
				.slice(0, 5);
		} catch {
			return [];
		}
	}

	// ------------------------------------------------------------- messages

	function buildChecksWakeMessage(record, logTail) {
		const failing = (record.checks ?? [])
			.filter((check) => BAD_CONCLUSIONS.has(check.conclusion))
			.map((check) => check.name)
			.join(", ");
		const summary = `CI failed on PR #${record.prNumber} (${record.prUrl}) while the merge pilot was shepherding it`;
		return {
			summary,
			text: [
				`${summary}.`,
				failing ? `Failing checks: ${failing}.` : "",
				"",
				"Failed-step log tail:",
				"```",
				logTail || "(log unavailable)",
				"```",
				"",
				[
					"This message was posted automatically by the DSH merge-pilot.",
					`Analyze the failure and push a fix to the SAME branch (\`${record.branch}\`) of ${record.slug}.`,
					"Do NOT open a new pull request and do NOT rebase: the pilot keeps polling this PR and will proceed once it turns green.",
				].join(" "),
			]
				.filter((part) => part !== "")
				.join("\n"),
		};
	}

	function buildReviewWakeMessage(record, reviewers) {
		const who = reviewers.length > 0 ? reviewers.join(", ") : "a reviewer";
		const summary = `Changes requested on PR #${record.prNumber} (${record.prUrl}) by ${who}`;
		return {
			summary,
			text: [
				`${summary}; the merge pilot cannot proceed until they are addressed.`,
				"",
				[
					"This message was posted automatically by the DSH merge-pilot.",
					`Read the review thread on the PR, address every comment, and push your responses to the SAME branch (\`${record.branch}\`) of ${record.slug}.`,
					"Reply to each review thread on GitHub if asked; do NOT open a new pull request.",
					"The pilot keeps polling and will merge once the PR turns green and approved.",
				].join(" "),
			].join("\n"),
		};
	}

	function tryFollowup(record, message) {
		const agent = record.sessionId ? resolveAgent(record.sessionId) : undefined;
		if (!agent || typeof agent.followup !== "function") return false;
		try {
			agent.followup({
				id: randomUUID(),
				role: "user",
				content: [{ type: "text", text: message.text }],
				source: {
					kind: "plugin",
					plugin: "@dsh-plugins/merge-pilot",
					form: "notice",
					summary: message.summary,
				},
			});
			return true;
		} catch (error) {
			warn(`merge-pilot: followup wake failed: ${error?.message ?? error}`);
			return false;
		}
	}

	// ------------------------------------------------------------ merge step

	async function performMerge(record, methodOverride) {
		const chosen = methodOverride ?? record.mode;
		const flag = mergeMethodFlag(chosen);
		if (flag.error) throw httpError(400, flag.error);
		const args = ["pr", "merge", String(record.prNumber), "-R", record.slug, flag.flag];
		if (record.deleteBranch) args.push("--delete-branch");
		const result = await runGh(args, { timeoutMs: GH_TIMEOUT_MS, tolerateFailure: true });
		if (result.code !== 0) {
			return { ok: false, error: oneLine(result.err || result.out || "gh pr merge failed") };
		}
		return { ok: true };
	}

	// --------------------------------------------------------------- polling

	function reschedule(record, delayMs) {
		if (!pilots.has(record.id)) return;
		if (TERMINAL_STATUSES.has(record.status)) return;
		cancelTimeout(watchers.get(record.id));
		watchers.set(
			record.id,
			scheduleTimeout(() => {
				void Promise.resolve()
					.then(() => pollPilot(record.id))
					.catch((error) => {
						warn(`merge-pilot: poll crashed: ${error?.message ?? error}`);
						reschedule(record, delayMs);
					});
			}, delayMs),
		);
	}

	function stopWatching(record) {
		cancelTimeout(watchers.get(record.id));
		watchers.delete(record.id);
	}

	function finishPilot(record, status, note) {
		stopWatching(record);
		setStatus(record, status, note);
		pushTimeline(record, `status → ${status}${note ? ` (${note})` : ""}`);
	}

	async function pollPilot(pilotId) {
		const record = pilots.get(pilotId);
		if (!record || TERMINAL_STATUSES.has(record.status)) return;
		// `ready` without autoMerge is a stable resting point: nothing to watch.
		if (record.status === "ready") return;
		if (clock() - record.createdAt > maxWatchMs) {
			finishPilot(record, "expired", "watch budget exceeded");
			return;
		}

		let view;
		try {
			view = await fetchView(record);
		} catch (error) {
			setStatus(record, record.status === "watching" ? "watching" : record.status, oneLine(error.message));
			reschedule(record, pollMs * 2);
			return;
		}
		record.prUrl = typeof view.url === "string" ? view.url : record.prUrl;
		record.title = typeof view.title === "string" ? record.title : record.title;
		record.branch = typeof view.headRefName === "string" ? view.headRefName : record.branch;
		record.reviewDecision =
			typeof view.reviewDecision === "string" ? view.reviewDecision.toUpperCase() : null;
		record.isDraft = view.isDraft === true;
		record.mergeable = view.mergeable === true;
		const verdict = classifyChecks(view.statusCheckRollup);

		// Empty rollups get a grace window before being treated as "no checks".
		let checksOutcome = verdict.outcome;
		record.checks = verdict.checks;
		if (checksOutcome === "empty") {
			record.graceCount = (record.graceCount ?? 0) + 1;
			if (record.graceCount <= gracePolls) checksOutcome = "pending";
			else checksOutcome = "passed";
		} else {
			record.graceCount = 0;
		}
		record.updatedAt = clock();

		const next = decideNextStatus({
			state: String(view.state ?? "").toUpperCase(),
			isDraft: record.isDraft,
			mergeable: record.mergeable,
			reviewDecision: record.reviewDecision,
			checksOutcome,
		});

		if (next === "merged") {
			finishPilot(record, "merged", "GitHub reports the PR as merged");
			return;
		}
		if (next === "closed") {
			finishPilot(record, "closed", "PR was closed without merging");
			return;
		}

		if (next === "fix-checks") {
			const logTail = await collectFailureLog(record);
			const woke =
				record.fixRounds < maxFixRounds &&
				tryFollowup(record, buildChecksWakeMessage(record, logTail));
			if (woke) {
				record.fixRounds += 1;
				setStatus(record, "fixing", `fix round ${record.fixRounds}/${maxFixRounds}: session woken with the failure logs`);
				pushTimeline(record, `CI failed — session woken (round ${record.fixRounds}/${maxFixRounds})`);
			} else {
				setStatus(
					record,
					"blocked",
					record.fixRounds >= maxFixRounds
						? "auto-fix budget exhausted; fix manually — the pilot keeps watching"
						: "CI failed and no live session could be woken to fix it",
				);
				pushTimeline(record, "CI failed — no automatic fix available");
			}
			reschedule(record, pollMs);
			return;
		}

		if (next === "fix-review") {
			const reviewers = await collectRequestingReviewers(record);
			const woke =
				record.fixRounds < maxFixRounds &&
				tryFollowup(record, buildReviewWakeMessage(record, reviewers));
			if (woke) {
				record.fixRounds += 1;
				setStatus(record, "fixing", `review fixes requested (round ${record.fixRounds}/${maxFixRounds})`);
				pushTimeline(record, `changes requested${reviewers.length ? ` by ${reviewers.join(", ")}` : ""} — session woken`);
			} else {
				setStatus(
					record,
					"blocked",
					`changes requested${reviewers.length ? ` by ${reviewers.join(", ")}` : ""} and no live session could be woken`,
				);
				pushTimeline(record, "changes requested — no automatic fix available");
			}
			reschedule(record, pollMs);
			return;
		}

		if (next === "ready") {
			if (record.autoMerge) {
				await attemptAutoMerge(record);
			} else {
				finishPilot(record, "ready", "mergeable — awaiting your manual merge");
			}
			return;
		}

		if (next === "watching") {
			// Conditions are neither failing nor mergeable (pending checks,
			// review required, draft…). Recover from fixing/blocked so the UI
			// reflects reality.
			if (record.status !== "watching") {
				const previous = record.status;
				setStatus(
					record,
					"watching",
					record.isDraft
						? "draft PR — waiting for readiness"
						: "waiting on checks / review approval",
				);
				pushTimeline(record, `${previous} → watching`);
			}
			reschedule(record, pollMs);
			return;
		}
		reschedule(record, pollMs);
	}

	async function attemptAutoMerge(record) {
		if (clock() - (record.lastMergeTryAt ?? 0) < MERGE_COOLDOWN_MS) {
			reschedule(record, pollMs);
			return;
		}
		record.lastMergeTryAt = clock();
		record.mergeTries += 1;
		const result = await performMerge(record);
		if (result.ok) {
			finishPilot(record, "merged", `merged via gh pr merge (${record.mode})`);
			return;
		}
		pushTimeline(record, `merge attempt ${record.mergeTries}/${maxMergeAttempts} failed: ${result.error}`);
		if (record.mergeTries >= maxMergeAttempts) {
			finishPilot(record, "blocked", `auto-merge keeps failing: ${result.error}`);
			return;
		}
		setStatus(record, record.status, `merge attempt failed (${result.error}); retrying`);
		reschedule(record, pollMs);
	}

	// ------------------------------------------------------------ operations

	async function createPilot(body) {
		const ref = parsePullRequestRef(body?.pullRequest);
		if (ref.error) throw httpError(400, ref.error);
		const slug = await resolveSlug(ref.repoFlag ?? body?.repo);
		const method = mergeMethodFlag(body?.mode ?? defaultMode);
		if (method.error) throw httpError(400, method.error);

		const record = {
			id: `pilot-${randomUUID().slice(0, 8)}`,
			slug,
			prNumber: ref.number,
			prUrl: null,
			title: null,
			branch: null,
			baseBranch: null,
			mode: method.method,
			autoMerge: body?.autoMerge === true || (body?.autoMerge === undefined && defaultAutoMerge),
			deleteBranch: body?.deleteBranch === true || (body?.deleteBranch === undefined && defaultDeleteBranch),
			sessionId:
				typeof body?.sessionId === "string" && body.sessionId.trim()
					? body.sessionId.trim()
					: defaultSessionId,
			status: "watching",
			note: null,
			fixRounds: 0,
			mergeTries: 0,
			checks: [],
			graceCount: 0,
			reviewDecision: null,
			isDraft: null,
			mergeable: null,
			createdAt: clock(),
			updatedAt: clock(),
			timeline: [],
		};

		// Seed the record synchronously so bogus references fail fast.
		try {
			const view = await fetchView(record);
			record.prUrl = typeof view.url === "string" ? view.url : null;
			record.title = typeof view.title === "string" ? String(view.title).slice(0, 300) : null;
			record.branch = typeof view.headRefName === "string" ? view.headRefName : null;
			record.baseBranch = typeof view.baseRefName === "string" ? view.baseRefName : null;
			record.reviewDecision =
				typeof view.reviewDecision === "string" ? view.reviewDecision.toUpperCase() : null;
			record.isDraft = view.isDraft === true;
			record.mergeable = view.mergeable === true;
			const verdict = classifyChecks(view.statusCheckRollup);
			record.checks = verdict.checks;
		} catch (error) {
			throw httpError(error.status ?? 502, `cannot read PR #${ref.number} on ${slug}: ${error.message}`);
		}
		if (!record.prUrl) throw httpError(502, `PR #${ref.number} not found on ${slug}`);

		pushTimeline(record, `pilot started (${record.mode}${record.autoMerge ? ", auto-merge" : ""})`);
		pilots.set(record.id, record);
		reschedule(record, Math.min(pollMs, 1_000));
		return { status: 201, payload: publicPilot(record) };
	}

	function listPilots() {
		const all = [...pilots.values()].map(publicPilot);
		all.sort((a, b) => b.createdAt - a.createdAt);
		return all;
	}

	function getPilot(id) {
		const record = pilots.get(id);
		if (!record) throw httpError(404, `unknown pilot id: ${id}`);
		return publicPilot(record);
	}

	async function manualMerge(id, body) {
		const record = pilots.get(id);
		if (!record) throw httpError(404, `unknown pilot id: ${id}`);
		if (TERMINAL_STATUSES.has(record.status) && record.status !== "ready") {
			throw httpError(409, `pilot is ${record.status}; nothing to merge`);
		}
		const result = await performMerge(record, body?.mode);
		if (!result.ok) {
			record.mergeTries += 1;
			setStatus(record, record.status, `manual merge failed: ${result.error}`);
			throw httpError(409, result.error);
		}
		finishPilot(record, "merged", "merged via manual merge action");
		return publicPilot(record);
	}

	function cancelPilot(id) {
		const record = pilots.get(id);
		if (!record) throw httpError(404, `unknown pilot id: ${id}`);
		finishPilot(record, "cancelled", "cancelled by user");
		return publicPilot(record);
	}

	function discardPilot(id) {
		const record = pilots.get(id);
		if (!record) throw httpError(404, `unknown pilot id: ${id}`);
		stopWatching(record);
		pilots.delete(id);
		return { discarded: id };
	}

	/** Cancel every watcher (plugin disposal). */
	function shutdown() {
		for (const handle of watchers.values()) cancelTimeout(handle);
		watchers.clear();
	}

	// ----------------------------------------------------------------- routes

	/**
	 * The single prefix-route handler registered on the harness web server.
	 * Owns the full response lifecycle of every `/merge-pilot/api/*` request.
	 */
	async function handle(req, res) {
		if (!isLocalHost(req)) {
			sendJson(res, 403, { error: "merge-pilot: local connections only" });
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
			if (method === "POST" && pathname === `${API_PREFIX}/pilots`) {
				const body = await readBody(req);
				const result = await createPilot(body);
				sendJson(res, result.status, result.payload);
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/pilots`) {
				sendJson(res, 200, { pilots: listPilots(), pollHintMs: pollMs });
				return;
			}
			const mergeMatch = pathname.match(new RegExp(`^${API_PREFIX}/pilots/([\\w-]+)/merge$`));
			if (method === "POST" && mergeMatch) {
				const body = await readBody(req);
				sendJson(res, 200, await manualMerge(mergeMatch[1], body));
				return;
			}
			const cancelMatch = pathname.match(new RegExp(`^${API_PREFIX}/pilots/([\\w-]+)/cancel$`));
			if (method === "POST" && cancelMatch) {
				sendJson(res, 200, cancelPilot(cancelMatch[1]));
				return;
			}
			const pilotMatch = pathname.match(new RegExp(`^${API_PREFIX}/pilots/([\\w-]+)$`));
			if (method === "GET" && pilotMatch) {
				sendJson(res, 200, getPilot(pilotMatch[1]));
				return;
			}
			if (method === "DELETE" && pilotMatch) {
				sendJson(res, 200, discardPilot(pilotMatch[1]));
				return;
			}
			sendJson(res, 404, {
				error: `no such merge-pilot endpoint: ${method} ${pathname}`,
			});
		} catch (error) {
			sendJson(res, error.status ?? 500, { error: String(error?.message ?? error) });
		}
	}

	return {
		handle,
		createPilot,
		listPilots,
		getPilot,
		manualMerge,
		cancelPilot,
		discardPilot,
		shutdown,
	};
}

/**
 * Cordis plugin body: wire the controller to the harness services and clean
 * up behind the plugin fiber.
 * @param {object} ctx - host cordis context (`webServer` + `subprocess` injected).
 * @param {object} [config] - row config
 *   `{ cwd?, defaultSessionId?, mode?, autoMerge?, deleteBranch?, pollMs?,
 *      checksGracePolls?, maxFixRounds?, maxMergeAttempts?, maxWatchMs?,
 *      ghPath?, debug? }`.
 */
export function apply(ctx, config) {
	const options = config ?? {};

	// Every supervisor timer belongs to this fiber: tracked here, cleared on dispose.
	const fiberTimers = new Set();
	const safeSchedule = (fn, ms) => {
		const handle = setTimeout(() => {
			fiberTimers.delete(handle);
			fn();
		}, ms);
		fiberTimers.add(handle);
		return handle;
	};
	const safeCancel = (handle) => {
		clearTimeout(handle);
		fiberTimers.delete(handle);
	};

	const controller = createMergePilot({
		spawn: (spec) => ctx.subprocess.spawn(spec),
		resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
		defaultCwd: typeof options.cwd === "string" ? options.cwd : undefined,
		defaultSessionId:
			typeof options.defaultSessionId === "string" ? options.defaultSessionId : undefined,
		mode: typeof options.mode === "string" ? options.mode : undefined,
		autoMerge: options.autoMerge === true,
		deleteBranch: options.deleteBranch === true,
		pollMs: typeof options.pollMs === "number" ? options.pollMs : undefined,
		checksGracePolls:
			typeof options.checksGracePolls === "number" ? options.checksGracePolls : undefined,
		maxFixRounds: typeof options.maxFixRounds === "number" ? options.maxFixRounds : undefined,
		maxMergeAttempts:
			typeof options.maxMergeAttempts === "number" ? options.maxMergeAttempts : undefined,
		maxWatchMs: typeof options.maxWatchMs === "number" ? options.maxWatchMs : undefined,
		ghPath: typeof options.ghPath === "string" ? options.ghPath : undefined,
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
		timers: { setTimeout: safeSchedule, clearTimeout: safeCancel },
		warn: options.debug ? (message) => console.warn(message) : undefined,
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
		controller.shutdown();
		for (const handle of fiberTimers) clearTimeout(handle);
		fiberTimers.clear();
	});
}
