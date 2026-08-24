/**
 * Execution pipeline for one firing of a scheduled task.
 *
 * Three phases, each reflected in the run record's `status`:
 *
 *   1. `worktree` — materialize an isolated git worktree under
 *      `<repo>/.dsh/worktrees/` on a fresh branch based on an up-to-date
 *      `main` (best-effort `git fetch` + fast-forward of the LOCAL main,
 *      never an unsafe pull — same contract as @dsh-plugins/worktree-launcher);
 *   2. `running` — drive ONE unattended LLM iteration in that worktree
 *      through the harness's own `agents` service (the exact pattern of
 *      `dsh-headless`: `agents.create()` -> `followup()` -> `whenIdle()` ->
 *      `sessions.flush()`), with the task's provider/model pinned through
 *      scoped waterfall listeners (the same two waterfalls
 *      `installModelSelection` installs, without importing product code);
 *   3. `landing` — commit anything left uncommitted, push the branch and
 *      open (or adopt) a GitHub pull request via `gh`, degrading with an
 *      explicit note when no GitHub remote exists.
 *
 * Everything is factored behind injectable deps so tests run against real
 * temporary repositories plus stub services, without cordis.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const TERMINAL_RUN_STATUSES = new Set(["done", "error"]);
export const WORKTREE_DIR_PARTS = [".dsh", "worktrees"];
export const IGNORE_PATH = ".dsh/worktrees";
export const IGNORE_LINE = `${IGNORE_PATH}/`;

const GIT_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 60_000;
const GH_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RUN_MS = 30 * 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const SUMMARY_TAIL_CHARS = 4_000;

function oneLine(text) {
	return String(text ?? "").replace(/\s+/g, " ").trim();
}

function tail(text, maxChars) {
	const raw = String(text ?? "");
	return raw.length <= maxChars ? raw : raw.slice(raw.length - maxChars);
}

/**
 * The framing wrapped around the user's prompt for every scheduled run:
 * unattended execution rules + the verbatim task.
 */
export function buildScheduledPrompt(taskPrompt, worktreePath) {
	return [
		"[SCHEDULED TASK]",
		"This iteration runs unattended: nobody will answer questions, so make reasonable decisions and carry on.",
		`Work ONLY inside this session's working directory (${worktreePath}) — an isolated git worktree based on up-to-date main.`,
		"When you are done:",
		"- stage and commit ALL the changes you produced with clear conventional-commit message(s) on the current branch;",
		"- do NOT push, do NOT open a pull request, do NOT modify the original checkout;",
		"- finish with a short summary of what you did and what you deliberately left out.",
		"",
		"TASK:",
		String(taskPrompt ?? "").trim(),
	].join("\n");
}

/** Deterministic commit/PR title for the landing phase. */
export function scheduledCommitSubject(taskShort, stamp) {
	return `chore(sched-${taskShort}): apply scheduled iteration ${stamp}`;
}

/** Extract the first GitHub PR URL (+number) from gh output. */
export function extractPrUrl(text) {
	const match = String(text ?? "").match(
		/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/,
	);
	if (!match) return undefined;
	return { url: match[0], number: Number(match[1]) };
}

/** Parse `{owner, repo}` from a GitHub remote URL; undefined when not GitHub. */
export function parseGitHubOwnerRepo(remoteUrl) {
	const match = String(remoteUrl ?? "")
		.trim()
		.match(/github\.com[/:]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/i);
	if (!match) return undefined;
	return { owner: match[1], repo: match[2] };
}

/**
 * Fold one owned event interval into `{text, reasonKind}` — the last
 * non-empty assistant text plus the closing `turn/end` reason kind
 * (same summarization contract as dsh-headless).
 */
export function summarizeInterval(events, firstSeq) {
	let started = false;
	let text = "";
	let reasonKind;
	for (const event of Array.isArray(events) ? events : []) {
		if (typeof event?.seq === "number" && event.seq < firstSeq) continue;
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = (event.data?.message?.content ?? [])
				.filter((block) => block?.type === "text")
				.map((block) => block.text ?? "")
				.join("");
			if (joined.trim() !== "") text = joined;
		}
		if (event.type === "turn/end") reasonKind = event.data?.reason?.kind;
	}
	return { text, reasonKind };
}

// ------------------------------------------------------------------ factory

/**
 * Build the runner.
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable.
 * @param {{create?: Function}} [deps.agents] - optional ctx.agents service.
 * @param {{flush?: Function}} [deps.sessions] - optional ctx.sessions service.
 * @param {(record: object) => Promise<void>} [deps.recordRun] - progress sink.
 * @param {string} [deps.baseBranch] - force the base branch (default main/master detection).
 * @param {string} [deps.ghPath] - explicit gh executable.
 * @param {number} [deps.maxRunMs] - whole-iteration budget before teardown.
 * @param {number} [deps.fetchTimeoutMs] - budget for git fetch/pull.
 * @param {(message: string) => void} [deps.warn].
 * @param {{setTimeout?: Function, clearTimeout?: Function}} [deps.timers].
 * @param {() => number} [deps.now] - injectable clock.
 */
export function createScheduledRunner(deps) {
	const spawn = deps.spawn;
	const resolveExecutable = deps.resolveExecutable;
	const agents = typeof deps.agents?.create === "function" ? deps.agents : undefined;
	const sessions =
		deps.sessions && typeof deps.sessions.flush === "function" ? deps.sessions : undefined;
	const recordRun = typeof deps.recordRun === "function" ? deps.recordRun : async () => {};
	const warn = typeof deps.warn === "function" ? deps.warn : () => {};
	const now = typeof deps.now === "function" ? deps.now : Date.now;
	const scheduleTimeout =
		typeof deps.timers?.setTimeout === "function"
			? deps.timers.setTimeout.bind(deps.timers)
			: (fn, ms) => setTimeout(fn, ms);
	const cancelTimeout =
		typeof deps.timers?.clearTimeout === "function"
			? deps.timers.clearTimeout.bind(deps.timers)
			: (handle) => clearTimeout(handle);
	const maxRunMs =
		Number.isFinite(deps.maxRunMs) && deps.maxRunMs > 60_000 ? deps.maxRunMs : DEFAULT_MAX_RUN_MS;
	const fetchTimeoutMs =
		Number.isFinite(deps.fetchTimeoutMs) && deps.fetchTimeoutMs > 0
			? deps.fetchTimeoutMs
			: DEFAULT_FETCH_TIMEOUT_MS;
	const baseBranchOverride =
		typeof deps.baseBranch === "string" && deps.baseBranch.trim()
			? deps.baseBranch.trim()
			: undefined;
	/** repo top -> tail promise serializing git mutations per repository. */
	const chains = new Map();

	const executables = new Map();
	async function executable(kind) {
		if (!executables.has(kind)) {
			const wanted = kind === "gh" && typeof deps.ghPath === "string" && deps.ghPath.trim()
				? deps.ghPath.trim()
				: kind;
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

	async function runProc(kind, argv, options = {}) {
		const bin = await executable(kind);
		const handle = spawn({
			argv: [bin, ...argv],
			cwd: options.cwd,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: options.stdoutMaxBytes ?? 512 * 1024 },
				stderr: { maxBytes: 256 * 1024 },
			},
			graceMs: 1_000,
		});
		let timedOut = false;
		const timerHandle = scheduleTimeout(() => {
			timedOut = true;
			handle.terminate();
		}, options.timeoutMs ?? GIT_TIMEOUT_MS);
		let outcome;
		try {
			outcome = await handle.done;
		} finally {
			cancelTimeout(timerHandle);
		}
		if (timedOut) throw new Error(`${kind} ${argv[0]} timed out`);
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

	const runGit = (argv, options) => runProc("git", argv, options);

	async function gitOut(argv, cwd, options) {
		const result = await runGit(argv, { ...options, cwd });
		if (result.code !== 0) {
			throw new Error(`git ${argv[0]} failed:${result.err ? ` ${oneLine(result.err)}` : ""}`);
		}
		return result.out;
	}

	async function revParse(revision, cwd) {
		try {
			const result = await runGit(["rev-parse", "--verify", "--quiet", revision], { cwd });
			return result.code === 0 && result.out ? result.out.split("\n")[0].trim() : undefined;
		} catch {
			return undefined;
		}
	}

	async function resolveRepoTop(workspace) {
		let info;
		try {
			info = await stat(workspace);
		} catch {
			throw new Error(`workspace is not accessible: ${workspace}`);
		}
		if (!info.isDirectory()) throw new Error(`workspace is not a directory: ${workspace}`);
		const topResult = await runGit(["rev-parse", "--show-toplevel"], { cwd: workspace });
		const top = topResult.out.split("\n")[0]?.trim();
		if (!top) {
			throw new Error(`not a git repository: ${workspace}${topResult.err ? ` (${oneLine(topResult.err)})` : ""}`);
		}
		return top;
	}

	async function detectBaseBranch(top) {
		if (baseBranchOverride) return baseBranchOverride;
		for (const candidate of ["main", "master"]) {
			if (await revParse(`refs/heads/${candidate}`, top)) return candidate;
		}
		const head = await runGit(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { cwd: top }).catch(
			() => ({ out: "" }),
		);
		const name = head.out.replace(/^origin\//, "").trim();
		return name || undefined;
	}

	async function findCheckoutPath(top, branch) {
		try {
			const listing = await runGit(["branch", "--list", branch, "--format=%(worktreepath)"], { cwd: top });
			if (listing.code !== 0) return undefined;
			return listing.out.split("\n").map((l) => l.trim()).filter(Boolean)[0] || undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Fast-forward the LOCAL base branch to its fetched remote tip without
	 * ever rebasing or overwriting: `git pull --ff-only` where checked out,
	 * else a non-forced refspec. Every failure degrades to a note.
	 */
	async function updateBaseBranch(top, branch) {
		const url = await runGit(["config", "--get", "remote.origin.url"], { cwd: top }).catch(() => ({ code: 1, out: "" }));
		const hasOrigin = url.code === 0 && Boolean(url.out);
		if (!hasOrigin) return { updated: false, note: "no origin remote" };
		let fetched;
		try {
			fetched = await runGit(["fetch", "origin", branch], { cwd: top, timeoutMs: fetchTimeoutMs });
		} catch (error) {
			return { updated: false, note: `fetch failed: ${oneLine(error.message)}` };
		}
		if (fetched.code !== 0) {
			return { updated: false, note: `fetch failed: ${oneLine(fetched.err || fetched.out) || "git error"}` };
		}
		const remoteSha = await revParse(`refs/remotes/origin/${branch}`, top);
		const localSha = await revParse(`refs/heads/${branch}`, top);
		if (!remoteSha || remoteSha === localSha) return { updated: false, note: null };
		const checkoutPath = await findCheckoutPath(top, branch);
		if (checkoutPath) {
			try {
				const pulled = await runGit(["pull", "--ff-only", "origin", branch], {
					cwd: checkoutPath,
					timeoutMs: fetchTimeoutMs,
				});
				if (pulled.code !== 0) {
					return { updated: false, note: `local ${branch} not pulled (${oneLine(pulled.err || pulled.out)})` };
				}
				return { updated: true, note: null };
			} catch (error) {
				return { updated: false, note: `local ${branch} not pulled (${oneLine(error.message)})` };
			}
		}
		try {
			const refspec = await runGit(["fetch", ".", `refs/remotes/origin/${branch}:refs/heads/${branch}`], { cwd: top });
			if (refspec.code !== 0) {
				return { updated: false, note: `local ${branch} not fast-forwarded (${oneLine(refspec.err)})` };
			}
			return { updated: true, note: null };
		} catch (error) {
			return { updated: false, note: `local ${branch} not fast-forwarded (${oneLine(error.message)})` };
		}
	}

	async function ensureIgnoreRule(top) {
		try {
			const probe = await runGit(["check-ignore", "-q", "--", IGNORE_PATH], { cwd: top });
			if (probe.code === 0) return;
		} catch {
			/* fall through to the exclude file */
		}
		try {
			const commonDirResult = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: top });
			const raw = commonDirResult.out || ".git";
			const excludePath = join(raw, "info", "exclude");
			let current = "";
			try {
				current = await readFile(excludePath, "utf8");
			} catch {
				current = "";
			}
			const lines = current.split("\n");
			if (lines.includes(IGNORE_LINE)) return;
			const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
			await mkdir(dirname(excludePath), { recursive: true });
			await writeFile(excludePath, `${current}${prefix}${IGNORE_LINE}\n`, "utf8");
		} catch (error) {
			warn(`scheduled-tasks: could not update info/exclude: ${error?.message ?? error}`);
		}
	}

	function taskShort(taskId) {
		return String(taskId ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8) || "task";
	}

	function localStamp(date) {
		const pad = (n, w = 2) => String(n).padStart(w, "0");
		return (
			`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
			`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
		);
	}

	// ------------------------------------------------------------ phases

	async function prepareWorktree(record, task) {
		record.status = "worktree";
		await recordRun(snapshot(record));
		const top = await resolveRepoTop(task.workspace);
		const previous = chains.get(top) ?? Promise.resolve();
		const run = previous.catch(() => {}).then(() => prepareLocked(record, task, top));
		chains.set(top, run.catch(() => {}));
		return run;
	}

	async function prepareLocked(record, task, top) {
		const worktreeDir = join(top, ...WORKTREE_DIR_PARTS);
		await mkdir(worktreeDir, { recursive: true });
		await ensureIgnoreRule(top);
		const branch = await detectBaseBranch(top);
		if (!branch) throw new Error(`no main/master branch found in ${top}; set the row config 'baseBranch'`);
		const update = await updateBaseBranch(top, branch);
		const baseSha =
			(await revParse(`refs/remotes/origin/${branch}`, top)) ??
			(await revParse(`refs/heads/${branch}`, top)) ??
			(await revParse("HEAD", top));
		if (!baseSha) throw new Error(`cannot resolve a base commit for '${branch}'`);

		const stamp = localStamp(new Date(now()));
		const short = taskShort(task.id);
		let newBranch;
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const suffix = attempt === 0 ? "" : `-${attempt}`;
			const candidate = `sched-${short}-${stamp}${suffix}`;
			if (!(await revParse(`refs/heads/${candidate}`, top))) {
				newBranch = candidate;
				break;
			}
		}
		if (!newBranch) throw new Error("could not mint a free sched-* branch name");
		const worktreePath = join(worktreeDir, newBranch);
		const added = await runGit(["worktree", "add", "-b", newBranch, worktreePath, baseSha], { cwd: top });
		if (!existsSync(worktreePath)) {
			throw new Error(`git worktree add failed:${added.err ? ` ${oneLine(added.err)}` : ""}`);
		}
		record.branch = newBranch;
		record.worktreePath = worktreePath;
		record.note = update.note;
		return { top, branch, baseSha, worktreePath };
	}

	/**
	 * Pin the task's provider/model onto ONE agent scope: the same two
	 * scoped waterfall listeners `installModelSelection` installs, written
	 * directly so this plugin imports nothing from product packages.
	 */
	function pinModelSelection(agentCtx, selection) {
		try {
			agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
				const assembled = await next();
				if (!assembled || typeof assembled !== "object") return assembled;
				return {
					...assembled,
					variables: {
						...(assembled.variables ?? {}),
						provider: selection.provider,
						model: selection.model,
					},
				};
			});
			agentCtx.on("agent/request", async (_payload, next) => {
				const resolved = await next();
				if (!resolved || typeof resolved !== "object") return resolved;
				const { reasoningEffort: _inherited, ...rest } = resolved;
				return { ...rest, provider: selection.provider, model: selection.model };
			});
		} catch (error) {
			warn(`scheduled-tasks: could not pin the model (${error?.message ?? error}); host default applies`);
		}
	}

	function teardownHandle(handle) {
		for (const candidate of [handle?.dispose, handle?.agent?.dispose]) {
			if (typeof candidate === "function") {
				try {
					const result = candidate.call(handle);
					if (result && typeof result.catch === "function") result.catch(() => {});
					return true;
				} catch {
					/* try the next shape */
				}
			}
		}
		return false;
	}

	async function runIteration(record, task, worktreePath) {
		if (!agents) throw new Error("the harness 'agents' service is unavailable in this composition");
		record.status = "running";
		await recordRun(snapshot(record));
		const selection = { provider: String(task.model.provider), model: String(task.model.model) };
		const sessionId = `session-${randomUUID()}`;
		let settled = false;
		let timeoutHandle;
		// Resolves (never rejects) only when the budget expires first.
		const budget = new Promise((resolveBudget) => {
			timeoutHandle = scheduleTimeout(() => {
				if (!settled) {
					resolveBudget({
						ok: false,
						error: new Error(`iteration exceeded its ${Math.round(maxRunMs / 60_000)}min budget`),
					});
				}
			}, maxRunMs);
		});

		const drive = (async () => {
			const handle = await agents.create({
				sessionId,
				meta: { cwd: worktreePath },
				agentOptions: { provider: selection.provider, model: selection.model },
				setup: (agentCtx) => pinModelSelection(agentCtx, selection),
			});
			record.sessionId = sessionId;
			const agent = handle?.agent ?? handle;
			if (!agent || typeof agent.followup !== "function" || typeof agent.whenIdle !== "function") {
				throw new Error("agents.create returned an unexpected handle shape");
			}
			record.handle = handle;
			await agent.whenIdle();
			const firstSeq = agent.session.seq;
			agent.followup({
				id: randomUUID(),
				role: "user",
				content: [{ type: "text", text: buildScheduledPrompt(task.prompt, worktreePath) }],
				source: { kind: "plugin", plugin: "@dsh-plugins/scheduled-tasks" },
			});
			await agent.whenIdle();
			if (sessions && agent.session) await sessions.flush(agent.session);
			const outcome = summarizeInterval(agent.session?.events, firstSeq);
			return outcome;
		})();

		try {
			const outcome = await Promise.race([
				drive.then(
					(value) => ({ ok: true, value }),
					(error) => ({ ok: false, error }),
				),
				budget,
			]);
			settled = true;
			cancelTimeout(timeoutHandle);
			if (!outcome.ok) throw outcome.error;
			return outcome.value;
		} catch (error) {
			settled = true;
			cancelTimeout(timeoutHandle);
			teardownHandle(record.handle);
			throw error;
		} finally {
			delete record.handle;
		}
	}

	async function landPr(record, task, prepared, iteration) {
		record.status = "landing";
		await recordRun(snapshot(record));
		// NOTE: prepared carries the worktree path + base info; the RUN's branch
		// is record.branch (the minted sched-* name), never the base branch.
		const { top, baseSha, worktreePath } = prepared;
		const branch = record.branch;
		const notes = [];
		if (iteration?.text) record.summaryTail = tail(iteration.text, SUMMARY_TAIL_CHARS);

		const status = await runGit(["status", "--porcelain"], { cwd: worktreePath });
		const dirty = status.out.trim().length > 0;
		const headSha = await revParse("HEAD", worktreePath);
		const stamp = (record.branch ?? "").replace(/^sched-/, "");
		if (dirty) await runGit(["add", "-A"], { cwd: worktreePath });
		const stagedEmpty = dirty
			? (await runGit(["diff", "--cached", "--quiet"], { cwd: worktreePath })).code === 0
			: true;

		if (!dirty && headSha === baseSha) {
			notes.push("the iteration produced no changes; nothing to push or merge");
			record.note = notes.join("; ");
			return;
		}
		if (dirty && !stagedEmpty && headSha === baseSha) {
			const subject = scheduledCommitSubject(taskShort(task.id), stamp);
			const body = [
				tail(String(task.prompt ?? ""), 300),
				"",
				`Scheduled task \`${task.id}\` — unattended iteration of ${new Date(now()).toISOString()}.`,
				"_Landed by @dsh-plugins/scheduled-tasks._",
			]
				.filter((part) => part !== "")
				.join("\n");
			await runGit(["commit", "-m", subject, "-m", body], { cwd: worktreePath });
			notes.push("uncommitted work committed by the plugin");
		}

		const remote = await runGit(["config", "--get", "remote.origin.url"], { cwd: worktreePath }).catch(() => ({ code: 1, out: "" }));
		if (!remote.out) {
			notes.push("no origin remote: branch kept local, no PR opened");
			record.note = notes.join("; ");
			return;
		}
		const pushed = await runProc("git", ["push", "-u", "origin", branch], {
			cwd: worktreePath,
			timeoutMs: PUSH_TIMEOUT_MS,
		}).catch((error) => ({ code: -1, err: oneLine(error.message), out: "" }));
		if (pushed.code !== 0) {
			throw new Error(`push failed:${pushed.err ? ` ${pushed.err}` : ""}`);
		}
		notes.push("branch pushed");

		const slug = parseGitHubOwnerRepo(remote.out);
		let ghBin;
		try {
			ghBin = await executable("gh");
		} catch {
			ghBin = undefined;
		}
		if (!slug || !ghBin) {
			notes.push(slug ? "gh CLI unavailable: no PR opened" : "origin is not a GitHub remote: no PR opened");
			record.note = notes.join("; ");
			return;
		}
		const repoFlag = `${slug.owner}/${slug.repo}`;
		let existing;
		try {
			const listed = await runProc("gh", ["pr", "list", "--head", branch, "-R", repoFlag, "--limit", "1", "--json", "url,number,state"], {
				timeoutMs: GH_TIMEOUT_MS,
			});
			const parsed = JSON.parse(listed.out || "[]");
			existing = Array.isArray(parsed) ? parsed[0] : undefined;
		} catch {
			existing = undefined;
		}
		if (existing && existing.url && Number.isFinite(existing.number)) {
			record.prUrl = existing.url;
			record.prNumber = existing.number;
			notes.push("existing PR adopted");
		} else {
			const title = scheduledCommitSubject(taskShort(task.id), stamp);
			const body = [
				"## Scheduled iteration",
				"",
				tail(String(task.prompt ?? ""), 800),
				"",
				iteration?.text ? `## Agent summary\n\n${tail(iteration.text, 2_000)}` : "",
				"",
				`Task \`${task.id}\` · cron \`${task.cron}\` · model \`${selectionLabel(task)}\`.`,
				"_Opened automatically by @dsh-plugins/scheduled-tasks._",
			]
				.filter((part) => part !== "")
				.join("\n");
			const created = await runProc("gh", ["pr", "create", "-R", repoFlag, "--head", branch, "--title", title, "--body", body], {
				timeoutMs: GH_TIMEOUT_MS,
			}).catch((error) => ({ code: -1, out: "", err: oneLine(error.message) }));
			const extracted = extractPrUrl(`${created.out}\n${created.err}`);
			if (extracted) {
				record.prUrl = extracted.url;
				record.prNumber = extracted.number;
			} else {
				notes.push(`gh pr create failed: ${created.err || "no PR URL produced"}`);
			}
		}
		record.note = notes.join("; ");
	}

	function selectionLabel(task) {
		return `${task.model?.provider ?? "?"}/${task.model?.model ?? "?"}`;
	}

	function snapshot(record) {
		return {
			id: record.id,
			taskId: record.taskId,
			status: record.status,
			branch: record.branch ?? null,
			worktreePath: record.worktreePath ?? null,
			sessionId: record.sessionId ?? null,
			prUrl: record.prUrl ?? null,
			prNumber: record.prNumber ?? null,
			note: record.note ?? null,
			error: record.error ?? null,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt ?? null,
		};
	}

	/**
	 * Execute one firing of `task` end-to-end and return the final run view.
	 */
	async function execute(task) {
		const record = {
			id: randomUUID(),
			taskId: task.id,
			status: "preparing",
			branch: null,
			worktreePath: null,
			sessionId: null,
			prUrl: null,
			prNumber: null,
			note: null,
			error: null,
			startedAt: now(),
			finishedAt: null,
		};
		await recordRun(snapshot(record));
		try {
			const prepared = await prepareWorktree(record, task);
			const iteration = await runIteration(record, task, prepared.worktreePath);
			await landPr(record, task, prepared, iteration);
			record.status = "done";
			record.finishedAt = now();
		} catch (error) {
			record.status = "error";
			record.error = oneLine(error?.message ?? error).slice(0, 500) || "unknown error";
			record.finishedAt = now();
			warn(`scheduled-tasks: run ${record.id} failed: ${record.error}`);
		}
		await recordRun(snapshot(record));
		return snapshot(record);
	}

	async function quiesce() {
		const tails = [...chains.values()];
		if (tails.length === 0) return;
		await Promise.allSettled(tails);
	}

	return { execute, quiesce };
}
