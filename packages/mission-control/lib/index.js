/**
 * @dsh-plugins/mission-control — host half.
 *
 * A DeepSeek Harness (cordis) plugin bringing the GitHub-Copilot-app "My
 * Work" pillar to the DSH web surface: one aggregated TRIAGE INBOX of the
 * GitHub items that need attention right now — pull requests where your
 * review was requested, your own open pull requests, and issues assigned to
 * you — each actionable into a RUNNING agent session ("hand off"), with a
 * small registry so the browser half can list what it launched and nudge it
 * later.
 *
 * Deterministic plumbing only: every read is a `gh search … --json` /
 * `gh … view --json` call through `ctx.subprocess` (collect mode), the
 * worktree cut is plain git (best-effort fetch, never rebasing or
 * overwriting), and the prompt framing is pure code. Trust posture mirrors
 * the other plugins here: loopback-only server, Host allowlist, capped
 * bodies. `gh` uses the host user's keyring authentication.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const inject = ["webServer", "subprocess"];

const API_PREFIX = "/mission-control/api";
const MAX_BODY_BYTES = 64 * 1024;
const PREVIEW_BODY_CHARS = 6_000;
const PROMPT_BODY_CHARS = 12_000;
const GRACE_MS = 2_000;
const GH_TIMEOUT_MS = 45_000;
const IGNORE_LINE = ".dsh/worktrees/";

/** Default per-section result caps (mirrors the Copilot app inbox density). */
const DEFAULT_LIMIT = 15;

/**
 * Extract `{owner, repo}` from a github.com item URL
 * (`https://github.com/o/r/pull/12`, `/issues/7`, `/…`). Returns undefined
 * for foreign URLs.
 */
export function deriveSlug(url) {
	const match = String(url ?? "")
		.trim()
		.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(?:pull|issues)\/\d+/i);
	if (!match) return undefined;
	return { owner: match[1], repo: match[2] };
}

/** Repo display name `owner/repo` derived from an item URL (null otherwise). */
export function slugLabelOf(url) {
	const slug = deriveSlug(url);
	return slug ? `${slug.owner}/${slug.repo}` : null;
}

/**
 * Normalize one raw `gh search` entry into the stable wire shape used by the
 * browser half: `{kind, number, title, url, repo, updatedAt, labels,
 * isDraft, checkStatus, reviewDecision}`. Unknown fields degrade to null so
 * older `gh` versions stay usable.
 */
export function normalizeSearchItem(raw, kind) {
	if (!raw || typeof raw !== "object") return undefined;
	const url = typeof raw.url === "string" ? raw.url : null;
	const number =
		typeof raw.number === "number"
			? raw.number
			: Number.parseInt(String(raw.number ?? ""), 10);
	if (!Number.isFinite(number) || number <= 0 || !url) return undefined;
	const labels = Array.isArray(raw.labels)
		? raw.labels
				.map((label) =>
					typeof label === "string" ? label : typeof label?.name === "string" ? label.name : null,
				)
				.filter(Boolean)
				.slice(0, 8)
		: [];
	return {
		kind,
		number,
		title: String(raw.title ?? "").slice(0, 300),
		url,
		repo: slugLabelOf(url),
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
		labels,
		isDraft: raw.isDraft === true ? true : raw.isDraft === false ? false : null,
		checkStatus: typeof raw.checkStatus === "string" ? raw.checkStatus.toUpperCase() : null,
		reviewDecision:
			typeof raw.reviewDecision === "string" ? raw.reviewDecision.toUpperCase() : null,
	};
}

/** Sort key putting the most recently touched items first. */
export function byRecency(a, b) {
	const ta = Date.parse(a.updatedAt ?? "") || 0;
	const tb = Date.parse(b.updatedAt ?? "") || 0;
	return tb - ta;
}

/**
 * Frame the opening prompt of a handed-off session. Pure code.
 * @param {{kind: 'issue'|'pr', number: number, title: string, url?: string|null, body?: string, headRefName?: string|null}} item
 * @param {string} worktreePath
 */
export function buildHandoffPrompt(item, worktreePath) {
	const body = String(item.body ?? "").slice(0, PROMPT_BODY_CHARS);
	const header =
		item.kind === "pr"
			? [
					`You are taking over GitHub pull request #${item.number}: “${item.title}”.`,
					item.headRefName ? `Its work lives on branch \`${item.headRefName}\`.` : null,
				]
			: [`You are taking over GitHub issue #${item.number}: “${item.title}”.`];
	return [
		...header,
		item.url ? `Reference: ${item.url}` : null,
		"",
		item.kind === "pr" ? "Pull request description:" : "Issue body:",
		"```",
		body || "(empty)",
		"```",
		"",
		`Work autonomously inside ${worktreePath} (this isolated git worktree is already checked out on its own branch).`,
		item.kind === "pr"
			? [
					"Understand the change under review, finish whatever remains incomplete,",
					"and make sure the project's checks pass.",
				].join(" ")
			: "Understand the request, implement it, and make sure the project's checks pass.",
		"Commit your work with conventional-commit messages as you go.",
		"Do NOT push and do NOT open pull requests yourself.",
	]
		.filter((line) => line !== null && line !== "")
		.join("\n");
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
 * Build the mission-control controller. Factored out of {@link apply} so the
 * behavior is testable against a stubbed subprocess service and a fake
 * `agents` service.
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable - ctx.subprocess.resolveExecutable.
 * @param {object | undefined} deps.agents - ctx.get("agents"); absent → handoff refuses with 501.
 * @param {string} [deps.defaultCwd] - repository used when a request omits cwd.
 * @param {string} [deps.ghPath] - explicit `gh` binary instead of PATH lookup.
 * @param {() => Date} [deps.now] - injectable clock for stamps.
 * @param {number} [deps.maxRuns] - FIFO cap on retained handoff records.
 * @param {number} [deps.limit] - per-section inbox cap.
 */
export function createMissionControl(deps) {
	const spawn = deps.spawn;
	const resolveExecutable = deps.resolveExecutable;
	const agents = deps.agents;
	const defaultCwd = deps.defaultCwd ?? process.cwd();
	const ghPath = deps.ghPath;
	const now = typeof deps.now === "function" ? deps.now : () => new Date();
	const maxRuns =
		Number.isFinite(deps.maxRuns) && deps.maxRuns > 0 ? deps.maxRuns : 20;
	const limit =
		Number.isFinite(deps.limit) && deps.limit > 0 ? Math.min(deps.limit, 50) : DEFAULT_LIMIT;

	/** sessionId -> record (+ private handle) */
	const runs = new Map();

	// ---------------------------------------------------------------- helpers

	function publicRun(record) {
		return {
			id: record.id,
			kind: record.kind,
			item: record.item,
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
			cwd: options.cwd ?? defaultCwd,
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

	async function resolveGhPath() {
		return ghPath ?? (await resolveExecutable("gh"));
	}

	async function ghJson(args, options = {}) {
		const gh = await resolveGhPath();
		const answer = await run([gh, ...args], {
			cwd: options.cwd ?? defaultCwd,
			timeoutMs: GH_TIMEOUT_MS,
		});
		if (answer.code !== 0) {
			throw httpError(
				502,
				`gh ${args[0]} ${args[1] ?? ""} failed: ${(answer.err || answer.out || "gh error").trim().slice(0, 300)}`,
			);
		}
		try {
			return JSON.parse(answer.out);
		} catch {
			throw httpError(502, `gh ${args[0]} returned unparsable JSON`);
		}
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
		const topResult = await run(["git", "rev-parse", "--show-toplevel"], { cwd }).catch(
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

	async function revParse(ref, top) {
		const probe = await run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd: top });
		if (probe.code !== 0) return undefined;
		return probe.out.split("\n")[0]?.trim() || undefined;
	}

	async function detectBase(top) {
		for (const candidate of ["refs/heads/main", "refs/heads/master"]) {
			const sha = await revParse(candidate, top);
			if (sha) return { branch: candidate.replace("refs/heads/", ""), sha };
		}
		const head = await run(
			["git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
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
		const originUrl = await run(["git", "config", "--get", "remote.origin.url"], {
			cwd: top,
		}).catch(() => ({ code: 1, out: "" }));
		if (originUrl.code !== 0 || !originUrl.out.trim()) {
			return { note: "no origin remote; based on local tip" };
		}
		const fetched = await run(["git", "fetch", "origin", branch], { cwd: top }).catch(
			(error) => ({ code: 1, err: error.message }),
		);
		if (fetched.code !== 0) {
			return { note: `fetch failed (${oneLine(fetched.err)}); based on local tip` };
		}
		return { note: null };
	}

	async function ensureIgnoreRule(top) {
		try {
			const commonDir = await run(
				["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
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

	// ----------------------------------------------------------- inbox reads

	/**
	 * One fail-soft section read: resolves `{items, error}` — never throws.
	 * @param {string} name - section label for error notes.
	 * @param {string[]} argv - full `gh search …` argument vector.
	 * @param {'issue'|'pr'} kind - normalization flavor.
	 */
	async function readSection(name, argv, kind, top) {
		try {
			const parsed = await ghJson(argv, { cwd: top });
			const list = Array.isArray(parsed) ? parsed : [];
			return {
				name,
				items: list
					.map((entry) => normalizeSearchItem(entry, kind))
					.filter(Boolean)
					.sort(byRecency)
					.slice(0, limit),
				error: null,
			};
		} catch (error) {
			return { name, items: [], error: oneLine(error?.message ?? error) };
		}
	}

	async function fetchInbox(body) {
		// Inbox reads are pure `gh search` calls: no local repository required,
		// just an optional working directory for the gh process itself.
		const top =
			typeof body?.cwd === "string" && body.cwd.trim().length > 0
				? resolve(body.cwd)
				: defaultCwd;
		const jsonPrFields = "number,title,url,updatedAt,isDraft,checkStatus,reviewDecision";
		const jsonIssueFields = "number,title,url,updatedAt,labels";
		const [reviews, authored, assigned] = await Promise.all([
			readSection(
				"Review requests",
				["search", "prs", "--review-requested=@me", "--state=open", "--limit", String(limit), "--json", jsonPrFields],
				"pr",
				top,
			),
			readSection(
				"Your open PRs",
				["search", "prs", "--author=@me", "--state=open", "--limit", String(limit), "--json", jsonPrFields],
				"pr",
				top,
			),
			readSection(
				"Issues assigned to you",
				["search", "issues", "is:issue", "--assignee=@me", "--state=open", "--limit", String(limit), "--json", jsonIssueFields],
				"issue",
				top,
			),
		]);
		return {
			status: 200,
			payload: {
				sections: [reviews, authored, assigned],
				launchable: Boolean(agents),
				generatedAt: Date.now(),
			},
		};
	}

	// ------------------------------------------------------------ operations

	/**
	 * Resolve the handoff target into `{kind, number, repoFlag, url}` from the
	 * request item `{kind, url?, repo?, number?}`.
	 */
	function parseHandoffTarget(body) {
		const kind = body?.item?.kind === "pr" ? "pr" : body?.item?.kind === "issue" ? "issue" : null;
		if (!kind) throw httpError(400, "field 'item.kind' must be \"issue\" or \"pr\"");
		const url = typeof body.item.url === "string" && body.item.url.trim() ? body.item.url.trim() : null;
		const repo = typeof body.item.repo === "string" && body.item.repo.trim() ? body.item.repo.trim() : null;
		const numberRaw = Number.parseInt(String(body.item.number ?? ""), 10);
		const number = Number.isFinite(numberRaw) && numberRaw > 0 ? numberRaw : NaN;
		if (url) {
			const slug = deriveSlug(url);
			if (!slug) throw httpError(400, `cannot derive a GitHub repository from url: ${url}`);
			const urlNumber = Number.parseInt(url.match(/\/(?:pull|issues)\/(\d+)/)?.[1] ?? "", 10);
			if (!Number.isFinite(number) && !Number.isFinite(urlNumber)) {
				throw httpError(400, `cannot derive an item number from url: ${url}`);
			}
			return { kind, number: Number.isFinite(number) ? number : urlNumber, repoFlag: `${slug.owner}/${slug.repo}`, url };
		}
		if (repo && Number.isFinite(number)) {
			return { kind, number, repoFlag: repo.includes("/") ? repo : undefined, url: null };
		}
		throw httpError(400, "provide item.url, or both item.repo and item.number");
	}

	async function fetchDetail(target, top) {
		if (target.kind === "issue") {
			const argv = ["issue", "view", String(target.number)];
			if (target.repoFlag) argv.push("-R", target.repoFlag);
			argv.push("--json", "number,title,body,url,state");
			const parsed = await ghJson(argv, { cwd: top });
			if (parsed.state === "CLOSED") throw httpError(409, `issue #${target.number} is already closed`);
			return {
				number: typeof parsed.number === "number" ? parsed.number : target.number,
				title: String(parsed.title ?? "").slice(0, 300),
				body: String(parsed.body ?? "").slice(0, PREVIEW_BODY_CHARS),
				url: typeof parsed.url === "string" ? parsed.url : target.url,
			};
		}
		const argv = ["pr", "view", String(target.number)];
		if (target.repoFlag) argv.push("-R", target.repoFlag);
		argv.push("--json", "number,title,body,url,state,headRefName");
		const parsed = await ghJson(argv, { cwd: top });
		if (parsed.state === "CLOSED" || parsed.state === "MERGED") {
			throw httpError(409, `pull request #${target.number} is ${parsed.state.toLowerCase()}`);
		}
		return {
			number: typeof parsed.number === "number" ? parsed.number : target.number,
			title: String(parsed.title ?? "").slice(0, 300),
			body: String(parsed.body ?? "").slice(0, PREVIEW_BODY_CHARS),
			url: typeof parsed.url === "string" ? parsed.url : target.url,
			headRefName: typeof parsed.headRefName === "string" ? parsed.headRefName : null,
		};
	}

	async function handoff(body) {
		if (!agents || typeof agents.create !== "function") {
			throw httpError(
				501,
				"the harness 'agents' service is unavailable in this composition; sessions cannot be launched",
			);
		}
		const target = parseHandoffTarget(body);
		const top = await verifyRepository(body?.cwd);
		const detail = await fetchDetail(target, top);

		// Base: up-to-date main/master when possible, degrading gracefully.
		const detected = await detectBase(top);
		let baseNote = null;
		let baseSha;
		if (detected) {
			const tip = await updateBaseTip(top, detected.branch);
			baseNote = tip.note;
			baseSha =
				(await revParse(`refs/remotes/origin/${detected.branch}`, top)) ?? detected.sha;
		} else {
			baseSha = await revParse("HEAD", top);
			baseNote = "no main/master found; based on HEAD";
		}
		if (!baseSha) throw httpError(500, "could not resolve a base commit");

		const stampText = stamp(now());
		const branch = `mc-${detail.number}-${stampText}`;
		const worktreePath = join(top, ".dsh", "worktrees", branch);
		const added = await run(["git", "worktree", "add", "-b", branch, worktreePath, baseSha], {
			cwd: top,
		});
		if (added.code !== 0) {
			throw httpError(500, `git worktree add failed: ${oneLine(added.err || added.out)}`);
		}
		await ensureIgnoreRule(top);

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
			content: [{ type: "text", text: buildHandoffPrompt({ ...detail, kind: target.kind }, worktreePath) }],
			source: { kind: "plugin", plugin: "@dsh-plugins/mission-control" },
		});

		const record = {
			id: sessionId,
			kind: target.kind,
			item: {
				number: detail.number,
				title: detail.title,
				url: detail.url,
				repo: target.repoFlag ?? null,
			},
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
			source: { kind: "plugin", plugin: "@dsh-plugins/mission-control" },
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
	 * Owns the full response lifecycle of every `/mission-control/api/*` request.
	 */
	async function handle(req, res) {
		if (!isLocalHost(req)) {
			sendJson(res, 403, { error: "mission-control: local connections only" });
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
			if (method === "GET" && pathname === `${API_PREFIX}/inbox`) {
				const result = await fetchInbox({});
				sendJson(res, result.status, result.payload);
				return;
			}
			if (method === "POST" && pathname === `${API_PREFIX}/handoff`) {
				const body = await readBody(req);
				const result = await handoff(body);
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
			sendJson(res, 404, {
				error: `no such mission-control endpoint: ${method} ${pathname}`,
			});
		} catch (error) {
			sendJson(res, error.status ?? 500, { error: String(error?.message ?? error) });
		}
	}

	return {
		handle,
		fetchInbox,
		handoff,
		nudgeRun,
		listRuns,
		discardRun,
		parseHandoffTarget,
		fetchDetail,
	};
}

/**
 * Cordis plugin body: wire the controller to the harness services.
 * @param {object} ctx - host cordis context (`webServer` + `subprocess` injected).
 * @param {object} [config] - row config `{ cwd?, ghPath?, maxRuns?, limit? }`.
 */
export function apply(ctx, config) {
	const options = config ?? {};
	const controller = createMissionControl({
		spawn: (spec) => ctx.subprocess.spawn(spec),
		resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
		agents: ctx.get("agents"),
		defaultCwd: typeof options.cwd === "string" ? options.cwd : undefined,
		ghPath: typeof options.ghPath === "string" ? options.ghPath : undefined,
		maxRuns: typeof options.maxRuns === "number" ? options.maxRuns : undefined,
		limit: typeof options.limit === "number" ? options.limit : undefined,
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
