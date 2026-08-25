/**
 * @dsh-plugins/issue-starter — host half.
 *
 * A DeepSeek Harness (cordis) plugin that turns a GitHub issue into a RUNNING
 * agent session — the GitHub-Copilot-app "start work from an issue" workflow:
 * preview the issue, cut an isolated git worktree from an up-to-date base,
 * and launch a live session scoped to it through the harness `agents`
 * service. The session appears in the web sidebar like any other; this plugin
 * keeps a small registry so the browser half can list what it launched and
 * nudge it later.
 *
 * Deterministic plumbing only: `gh issue view` fetches the issue, plain git
 * commands cut the worktree (best-effort fetch, never rebasing or
 * overwriting), and the prompt framing is pure code. Trust posture mirrors
 * the other plugins here: loopback-only server, Host allowlist, capped bodies.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const inject = ["webServer", "subprocess"];

const API_PREFIX = "/issue-starter/api";
const MAX_BODY_BYTES = 64 * 1024;
const PREVIEW_BODY_CHARS = 6_000;
const PROMPT_BODY_CHARS = 12_000;
const GRACE_MS = 2_000;
const GIT_TIMEOUT_MS = 30_000;
const IGNORE_LINE = ".dsh/worktrees/";

/**
 * Parse an issue reference: a bare number or a full GitHub URL.
 * @returns {{number: number} | {error: string}}
 */
export function parseIssueReference(raw) {
	const value = String(raw ?? "").trim();
	if (!value) return { error: "provide an issue number or GitHub URL" };
	if (/^\d+$/.test(value)) {
		const number = Number.parseInt(value, 10);
		return number > 0 ? { number } : { error: `invalid issue number: ${value}` };
	}
	const match = value.match(/\/issues\/(\d+)\/?$/);
	if (match) return { number: Number.parseInt(match[1], 10) };
	return {
		error:
			"cannot parse the reference: give an issue number or a …/issues/<number> URL",
	};
}

/** Frame the opening prompt of the launched session. Pure code. */
export function buildIssuePrompt(issue, worktreePath) {
	const labels = Array.isArray(issue.labels)
		? issue.labels.map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean)
		: [];
	const body = String(issue.body ?? "").slice(0, PROMPT_BODY_CHARS);
	return [
		`You are taking over GitHub issue #${issue.number}: “${issue.title}”.`,
		labels.length > 0 ? `Labels: ${labels.join(", ")}.` : null,
		issue.url ? `Issue: ${issue.url}` : null,
		"",
		"Issue body:",
		"```",
		body || "(empty)",
		"```",
		"",
		`Work autonomously inside ${worktreePath} (this isolated git worktree is already checked out on its own branch).`,
		"Understand the request, implement it, and make sure the project's checks pass.",
		"Commit your work with conventional-commit messages as you go.",
		"Do NOT push and do NOT open pull requests yourself.",
	].filter((line) => line !== null).join("\n");
}

/**
 * Build the issue-starter controller. Factored out of {@link apply} so the
 * behavior is testable against a stubbed subprocess service and a fake
 * `agents` service.
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable - ctx.subprocess.resolveExecutable.
 * @param {object | undefined} deps.agents - ctx.get("agents"); absent → launch refuses with 501.
 * @param {string} [deps.defaultCwd] - repository used when a request omits cwd.
 * @param {string} [deps.ghPath] - explicit `gh` binary instead of PATH lookup.
 * @param {() => Date} [deps.now] - injectable clock for stamps.
 * @param {number} [deps.maxRuns] - FIFO cap on retained registry entries.
 */
export function createIssueStarter(deps) {
	const spawn = deps.spawn;
	const resolveExecutable = deps.resolveExecutable;
	const agents = deps.agents;
	const defaultCwd = deps.defaultCwd ?? process.cwd();
	const ghPath = deps.ghPath;
	const now = typeof deps.now === "function" ? deps.now : () => new Date();
	const maxRuns =
		Number.isFinite(deps.maxRuns) && deps.maxRuns > 0 ? deps.maxRuns : 20;

	/** id -> record (+ private handle) */
	const runs = new Map();

	// ---------------------------------------------------------------- helpers

	function publicRun(record) {
		return {
			id: record.id,
			issue: record.issue,
			repo: record.repo,
			branch: record.branch,
			worktreePath: record.worktreePath,
			sessionId: record.sessionId,
			startedAt: record.startedAt,
			baseNote: record.baseNote,
		};
	}

	function prune() {
		while (runs.size > maxRuns) {
			const oldest = runs.keys().next().value;
			if (oldest === undefined) break;
			runs.delete(oldest);
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

	/** Run one command in collect mode; resolves {code, out, err}. */
	async function run(argv, options = {}) {
		const executable = await resolveExecutable(argv[0]);
		const handle = spawn({
			argv: [executable, ...argv.slice(1)],
			cwd: options.cwd ?? defaultCwd,
			stdio: { stdin: "ignore", stdout: {}, stderr: {} },
			graceMs: GRACE_MS,
		});
		const outcome = await handle.done;
		const out = readAll(handle, "stdout");
		const err = readAll(handle, "stderr");
		void options;
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

	async function runGit(args, options = {}) {
		const result = await run(["git", ...args], options);
		return result;
	}

	async function verifyRepository(rawCwd) {
		const cwd =
			typeof rawCwd === "string" && rawCwd.trim().length > 0
				? resolve(rawCwd)
				: defaultCwd;
		try {
			const info = await stat(cwd);
			if (!info.isDirectory()) throw new Error("not a directory");
		} catch {
			throw httpError(400, `cwd is not an accessible directory: ${cwd}`);
		}
		const topResult = await runGit(["rev-parse", "--show-toplevel"], { cwd }).catch(
			(error) => {
				throw httpError(400, `git unavailable: ${error.message}`);
			},
		);
		const top = topResult.out.split("\n")[0]?.trim();
		if (topResult.code !== 0 || !top) {
			throw httpError(400, `not a git repository: ${cwd}`);
		}
		return top;
	}

	async function resolveGhPath() {
		return ghPath ?? (await resolveExecutable("gh"));
	}

	/**
	 * Fetch one issue through `gh issue view`.
	 * @returns {{number,title,body,url,labels}} parsed digest (body truncated).
	 */
	async function fetchIssue(reference, repoFlag, top) {
		const gh = await resolveGhPath();
		const argv = [gh, "issue", "view", String(reference.number)];
		if (repoFlag) argv.push("-R", repoFlag);
		argv.push("--json", "number,title,body,url,labels");
		const answer = await run(argv, { cwd: top });
		if (answer.code !== 0) {
			throw httpError(
				502,
				`gh issue view failed: ${(answer.err || answer.out || "gh error").trim().slice(0, 300)}`,
			);
		}
		let parsed;
		try {
			parsed = JSON.parse(answer.out);
		} catch {
			throw httpError(502, "gh issue view returned unparsable JSON");
		}
		if (typeof parsed?.title !== "string") {
			throw httpError(502, "gh issue view returned an unexpected payload");
		}
		return {
			number: typeof parsed.number === "number" ? parsed.number : reference.number,
			title: parsed.title.slice(0, 300),
			body: String(parsed.body ?? "").slice(0, PREVIEW_BODY_CHARS),
			url: typeof parsed.url === "string" ? parsed.url : null,
			labels: Array.isArray(parsed.labels) ? parsed.labels : [],
		};
	}

	async function revParse(ref, top) {
		const probe = await runGit(["rev-parse", "--verify", "--quiet", ref], { cwd: top });
		if (probe.code !== 0) return undefined;
		return probe.out.split("\n")[0]?.trim() || undefined;
	}

	async function detectBase(top) {
		for (const candidate of ["refs/heads/main", "refs/heads/master"]) {
			const sha = await revParse(candidate, top);
			if (sha) return { branch: candidate.replace("refs/heads/", ""), sha };
		}
		const head = await runGit(
			["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
			{ cwd: top },
		).catch(() => ({ out: "" }));
		const name = head.out.replace(/^origin\//, "").trim();
		if (name) {
			const sha = await revParse(`refs/remotes/origin/${name}`, top);
			if (sha) return { branch: name, sha };
		}
		return null;
	}

	async function updateBaseTip(top, branch) {
		const originUrl = await runGit(["config", "--get", "remote.origin.url"], { cwd: top }).catch(
			() => ({ code: 1, out: "" }),
		);
		if (originUrl.code !== 0 || !originUrl.out.trim()) {
			return { note: "no origin remote; based on local tip" };
		}
		const fetched = await runGit(["fetch", "origin", branch], {
			cwd: top,
		}).catch((error) => ({ code: 1, err: error.message }));
		if (fetched.code !== 0) {
			return { note: `fetch failed (${oneLine(fetched.err)}); based on local tip` };
		}
		return { note: null };
	}

	async function ensureIgnoreRule(top) {
		try {
			const commonDir = await runGit(
				["rev-parse", "--path-format=absolute", "--git-common-dir"],
				{ cwd: top },
			);
			const raw = commonDir.out.trim() || join(top, ".git");
			const excludePath = join(raw, "info", "exclude");
			let current = "";
			try {
				current = await readFile(excludePath, "utf8");
			} catch {
				current = "";
			}
			if (current.split("\n").includes(IGNORE_LINE)) return;
			const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
			await mkdir(dirname(excludePath), { recursive: true });
			await writeFile(excludePath, `${current}${prefix}${IGNORE_LINE}\n`, "utf8");
		} catch {
			/* cosmetic only */
		}
	}

	function stamp(date) {
		const pad = (value, width = 2) => String(value).padStart(width, "0");
		return (
			`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
			`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
		);
	}

	function oneLine(text) {
		return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
	}

	function httpError(status, message) {
		return Object.assign(new Error(message), { status });
	}

	// ------------------------------------------------------------ operations

	async function previewIssue(body) {
		const reference = parseIssueReference(body?.issue);
		if (reference.error) throw httpError(400, reference.error);
		const top = await verifyRepository(body?.cwd);
		const issue = await fetchIssue(
			reference,
			typeof body?.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined,
			top,
		);
		return { status: 200, payload: { issue, truncated: issue.body.length >= PREVIEW_BODY_CHARS } };
	}

	async function startFromIssue(body) {
		if (!agents || typeof agents.create !== "function") {
			throw httpError(
				501,
				"the harness 'agents' service is unavailable in this composition; sessions cannot be launched",
			);
		}
		const reference = parseIssueReference(body?.issue);
		if (reference.error) throw httpError(400, reference.error);
		const top = await verifyRepository(body?.cwd);
		const repoFlag =
			typeof body?.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined;

		const issue = await fetchIssue(reference, repoFlag, top);

		// Base: up-to-date main/master when possible, degrading gracefully.
		const detected = await detectBase(top);
		let baseNote = null;
		let baseSha;
		if (detected) {
			const tip = await updateBaseTip(top, detected.branch);
			baseNote = tip.note;
			baseSha =
				(await revParse(`refs/remotes/origin/${detected.branch}`, top)) ??
				detected.sha;
		} else {
			baseSha = await revParse("HEAD", top);
			baseNote = "no main/master found; based on HEAD";
		}
		if (!baseSha) throw httpError(500, "could not resolve a base commit");

		const stampText = stamp(now());
		const branch = `issue-${issue.number}-${stampText}`;
		const worktreePath = join(top, ".dsh", "worktrees", `${branch}`);
		const added = await runGit(["worktree", "add", "-b", branch, worktreePath, baseSha], {
			cwd: top,
		});
		if (added.code !== 0) {
			throw httpError(
				500,
				`git worktree add failed: ${oneLine(added.err || added.out)}`,
			);
		}
		await ensureIgnoreRule(top);

		// Launch the live session; do NOT await its completion.
		const sessionId = `session-${randomUUID()}`;
		const model =
			body?.model && typeof body.model.provider === "string" && typeof body.model.model === "string"
				? { provider: body.model.provider, model: body.model.model }
				: undefined;
		const handle = await agents.create({
			sessionId,
			meta: { cwd: worktreePath },
			...(model ? { agentOptions: model } : {}),
		});
		const agent = handle?.agent ?? handle;
		if (!agent || typeof agent.followup !== "function") {
			throw httpError(500, "agents.create returned an unexpected handle shape");
		}
		agent.followup({
			id: randomUUID(),
			role: "user",
			content: [{ type: "text", text: buildIssuePrompt(issue, worktreePath) }],
			source: { kind: "plugin", plugin: "@dsh-plugins/issue-starter" },
		});

		const record = {
			id: sessionId,
			issue: { number: issue.number, title: issue.title, url: issue.url },
			repo: repoFlag ?? null,
			branch,
			worktreePath,
			sessionId,
			startedAt: Date.now(),
			baseNote,
		};
		record.handle = handle;
		runs.set(sessionId, record);
		prune();
		return { status: 201, payload: publicRun(record) };
	}

	async function nudgeRun(id, body) {
		const record = runs.get(id);
		if (!record) throw httpError(404, `unknown run id: ${id}`);
		const message = typeof body?.message === "string" ? body.message.trim() : "";
		if (!message) throw httpError(400, "field 'message' must be a non-empty string");
		const agent = record.handle?.agent ?? record.handle;
		if (!agent || typeof agent.followup !== "function") {
			throw httpError(409, "the session handle can no longer accept messages");
		}
		agent.followup({
			id: randomUUID(),
			role: "user",
			content: [{ type: "text", text: message }],
			source: { kind: "plugin", plugin: "@dsh-plugins/issue-starter" },
		});
		return { status: 200, payload: publicRun(record) };
	}

	function listRuns() {
		const all = [...runs.values()].map(publicRun);
		all.sort((a, b) => b.startedAt - a.startedAt);
		return all;
	}

	function discardRun(id) {
		const record = runs.get(id);
		if (!record) throw httpError(404, `unknown run id: ${id}`);
		runs.delete(id);
		return { status: 200, payload: { discarded: id } };
	}

	// ----------------------------------------------------------------- routes

	/**
	 * The single prefix-route handler registered on the harness web server.
	 * Owns the full response lifecycle of every `/issue-starter/api/*` request.
	 */
	async function handle(req, res) {
		if (!isLocalHost(req)) {
			sendJson(res, 403, { error: "issue-starter: local connections only" });
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
			if (method === "POST" && pathname === `${API_PREFIX}/issues/preview`) {
				const body = await readBody(req);
				const result = await previewIssue(body);
				sendJson(res, result.status, result.payload);
				return;
			}
			if (method === "POST" && pathname === `${API_PREFIX}/issues/start`) {
				const body = await readBody(req);
				const result = await startFromIssue(body);
				sendJson(res, result.status, result.payload);
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/runs`) {
				sendJson(res, 200, { runs: listRuns(), launchable: Boolean(agents) });
				return;
			}
			const nudgeMatch = pathname.match(new RegExp(`^${API_PREFIX}/runs/([\\w-]+)/nudge$`));
			if (method === "POST" && nudgeMatch) {
				const body = await readBody(req);
				const result = await nudgeRun(nudgeMatch[1], body);
				sendJson(res, result.status, result.payload);
				return;
			}
			const runMatch = pathname.match(new RegExp(`^${API_PREFIX}/runs/([\\w-]+)$`));
			if (method === "DELETE" && runMatch) {
				const result = discardRun(runMatch[1]);
				sendJson(res, result.status, result.payload);
				return;
			}
			sendJson(res, 404, { error: `no such issue-starter endpoint: ${method} ${pathname}` });
		} catch (error) {
			sendJson(res, error.status ?? 500, { error: String(error?.message ?? error) });
		}
	}

	return { handle, previewIssue, startFromIssue, nudgeRun, listRuns, discardRun };
}

/**
 * Cordis plugin body: wire the controller to the harness services.
 * @param {object} ctx - host cordis context (`webServer` + `subprocess` injected).
 * @param {object} [config] - row config `{ cwd?, ghPath?, maxRuns? }`.
 */
export function apply(ctx, config) {
	const options = config ?? {};
	const controller = createIssueStarter({
		spawn: (spec) => ctx.subprocess.spawn(spec),
		resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
		agents: ctx.get("agents"),
		defaultCwd: typeof options.cwd === "string" ? options.cwd : undefined,
		ghPath: typeof options.ghPath === "string" ? options.ghPath : undefined,
		maxRuns: typeof options.maxRuns === "number" ? options.maxRuns : undefined,
	});

	const disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: "/issue-starter/api",
		handler: (req, res) => {
			void controller.handle(req, res);
		},
	});

	ctx.on("dispose", () => {
		disposeRoute();
	});
}
