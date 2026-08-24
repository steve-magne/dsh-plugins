/**
 * Standalone functional test for the @dsh-plugins/scheduled-tasks host half.
 *
 * Runs without cordis: drives `createScheduledTasks` through mock req/res,
 * against REAL temporary git repositories (local bare origin so fetch/push
 * work offline), a stub `agents`/`sessions` pair simulating one unattended
 * LLM iteration, and FAKE `gh` executables answering without any network.
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduledTasks } from "../lib/index.js";

// ---------------------------------------------------------------- git fixture

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "stq-test",
	GIT_AUTHOR_EMAIL: "stq@test.local",
	GIT_COMMITTER_NAME: "stq-test",
	GIT_COMMITTER_EMAIL: "stq@test.local",
};

function git(args, cwd) {
	const result = spawnSync("git", args, {
		cwd,
		env: GIT_ENV,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
	}
	return result.stdout;
}

/** Scratch project cloned from a local bare origin masquerading as GitHub. */
async function makeProject() {
	const dir = await mkdtemp(join(tmpdir(), "stq-fixture-"));
	const origin = join(dir, "origin.git");
	const GH_URL = "https://github.com/acme/widget.git";
	git(["init", "--quiet", "--bare", "--initial-branch=main", origin], dir);
	const root = join(dir, "project");
	git(["clone", "--quiet", origin, root], dir);
	// The remote URL LOOKS like GitHub (the plugin parses owner/repo from it)
	// while every network operation is rewritten to the local bare repo.
	git(["remote", "set-url", "origin", GH_URL], root);
	git(["config", `url.${origin}.insteadOf`, GH_URL], root);
	git(["config", "user.email", "stq@test.local"], root);
	git(["config", "user.name", "stq-test"], root);
	writeFileSync(join(root, "README.md"), "# fixture\n", "utf8");
	git(["add", "."], root);
	git(["commit", "-q", "-m", "seed"], root);
	// A project-level skill, deliberately left UNCOMMITTED: it exists in the
	// original checkout only, pinning the contract that firings read skills
	// from the task's workspace — never from the fresh worktree.
	mkdirSync(join(root, ".agents", "skills", "review"), { recursive: true });
	writeFileSync(
		join(root, ".agents", "skills", "review", "SKILL.md"),
		'---\nname: review\ndescription: "Review the code carefully."\n---\nALWAYS review the full diff before committing.\n',
		"utf8",
	);
	git(["push", "-q", "-u", "origin", "main"], root);
	return {
		dir,
		root,
		origin,
		upstreamMainSha: () => git(["rev-parse", "main"], origin).trim(),
		localMainSha: () => git(["rev-parse", "main"], root).trim(),
		pushUpstreamCommit() {
			const drive = join(dir, "drive");
			git(["clone", "--quiet", origin, drive], dir);
			git(["config", "user.email", "stq@test.local"], drive);
			git(["config", "user.name", "stq-test"], drive);
			writeFileSync(join(drive, "upstream.txt"), "landed upstream\n", "utf8");
			git(["add", "."], drive);
			git(["commit", "-q", "-m", "upstream work"], drive);
			git(["push", "-q", "origin", "main"], drive);
		},
		async cleanup() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

// ------------------------------------------------------------------- fakes

/**
 * Fake `gh`: `pr list` answers an empty array, `pr create` answers a PR URL.
 * mode "broken" simulates a failing GitHub CLI.
 */
async function makeFakeGh(mode) {
	const dir = await mkdtemp(join(tmpdir(), "stq-gh-"));
	const path = join(dir, "gh");
	const body =
		mode === "broken"
			? "#!/bin/sh\necho 'gh: simulated outage' >&2\nexit 1\n"
			: [
					"#!/bin/sh",
					'for arg in "$@"; do',
					'  case "$arg" in',
					'    list) echo "[]"; exit 0 ;;',
					'    create) echo "https://github.com/acme/widget/pull/77"; exit 0 ;;',
					"  esac",
					"done",
					'echo "{}"',
					"",
				].join("\n");
	writeFileSync(path, body, "utf8");
	chmodSync(path, 0o755);
	return path;
}

function spawnStub(spec) {
	const child = spawn(spec.argv[0], spec.argv.slice(1), {
		cwd: spec.cwd,
		env: GIT_ENV,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let stdoutBuf = Buffer.alloc(0);
	let stderrBuf = Buffer.alloc(0);
	child.stdout.on("data", (chunk) => {
		stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
	});
	child.stderr.on("data", (chunk) => {
		stderrBuf = Buffer.concat([stderrBuf, chunk]);
	});
	let settled = false;
	let resolveDone;
	let rejectDone;
	const done = new Promise((res, rej) => {
		resolveDone = res;
		rejectDone = rej;
	});
	child.on("error", (error) => {
		if (!settled) {
			settled = true;
			rejectDone(error);
		}
	});
	child.on("close", (code, signal) => {
		if (!settled) {
			settled = true;
			resolveDone({ exitCode: code ?? 1, signal });
		}
	});
	return {
		pid: child.pid ?? -1,
		done,
		collected: {
			stdout: {
				readFrom(fromByte) {
					const text = stdoutBuf.toString("utf8").slice(fromByte);
					return { text, nextOffset: fromByte + text.length, lossy: false };
				},
			},
			stderr: {
				readFrom(fromByte) {
					const text = stderrBuf.toString("utf8").slice(fromByte);
					return { text, nextOffset: fromByte + text.length, lossy: false };
				},
			},
		},
		terminate() {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		},
	};
}

/**
 * Agents stand-in. `create()` yields an idle agent whose single followup
 * plays one completed turn; with `simulateWork`, the "model" leaves a real
 * commit inside its working directory before summarizing.
 */
function makeAgentsStub(simulateWork) {
	const creations = [];
	return {
		creations,
		async create(options) {
			assert.equal(typeof options.setup, "function", "runner must install scoped listeners");
			const registered = [];
			options.setup({
				on(event, _listener) {
					registered.push(event);
					return () => {};
				},
			});
			assert.ok(
				registered.includes("system-prompt/assemble") && registered.includes("agent/request"),
				"setup must pin the model through both waterfall listeners",
			);
			const agent = {
				id: options.sessionId,
				session: { id: options.sessionId, seq: 1, events: [], header: { cwd: options.meta?.cwd } },
				followups: [],
				whenIdle: async () => {},
				followup(message) {
					this.followups.push(message);
					if (simulateWork) {
						const cwd = options.meta.cwd;
						writeFileSync(join(cwd, "generated.txt"), `work of ${options.sessionId}\n`, "utf8");
						git(["add", "-A"], cwd);
						git(["commit", "-q", "-m", "feat: simulated scheduled work"], cwd);
					}
					this.session.events.push({
						seq: this.session.seq++,
						type: "assistant/message",
						data: { message: { content: [{ type: "text", text: "Simulated summary: did the thing." }] } },
					});
					this.session.events.push({
						seq: this.session.seq++,
						type: "turn/end",
						data: { reason: { kind: "completed" } },
					});
					options.promptText = message.content?.[0]?.text ?? "";
				},
			};
			creations.push(options);
			return { agent };
		},
	};
}

function makeSessionsStub() {
	const flushed = [];
	return {
		flushed,
		async flush(session) {
			flushed.push(session.id);
			return true;
		},
	};
}

// ------------------------------------------------------------------ harness

function makeReq({ method = "GET", url = "/", body = undefined, host = "127.0.0.1:3080" }) {
	const payload = body === undefined ? null : JSON.stringify(body);
	const chunks = payload ? [Buffer.from(payload, "utf8")] : [];
	return {
		method,
		url,
		headers: { host },
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		},
	};
}

async function call(controller, options) {
	const req = makeReq(options);
	const fake = {
		status: null,
		bodyText: null,
		writeHead(statusCode) {
			this.status = statusCode;
		},
		end(bodyText) {
			this.bodyText = bodyText;
		},
	};
	await controller.handle(req, fake);
	assert.notEqual(fake.status, null, "handler must answer every request");
	return { status: fake.status, payload: JSON.parse(fake.bodyText) };
}

async function waitFor(predicate, label, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timeout waiting for ${label}`);
}

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

const scratchRoot = await mkdtemp(join(tmpdir(), "stq-stores-"));
const fakeNow = { value: new Date(2026, 2, 2, 8, 30, 0).getTime() }; // Monday 08:30
const API = "/scheduled-tasks/api";
const ghPaths = {};
async function ghPathFor(mode) {
	if (!ghPaths[mode]) ghPaths[mode] = await makeFakeGh(mode);
	return ghPaths[mode];
}

/** Fake DSH profile skills root: `<DSH_HOME>/skills` with one skill. */
const profileSkillsRoot = join(scratchRoot, "dsh-home", "skills");
await mkdir(join(profileSkillsRoot, "profile-skill"), { recursive: true });
await writeFile(
	join(profileSkillsRoot, "profile-skill", "SKILL.md"),
	"---\nname: profile-skill\ndescription: Skill living in the DSH profile.\n---\nPROFILE SKILL BODY v1\n",
	"utf8",
);

async function buildController({ agents, sessions, ghMode, llm, skillsRoot } = {}) {
	return createScheduledTasks({
		spawn: spawnStub,
		resolveExecutable: async (command) => (command === "gh" ? ghPathFor(ghMode) : command),
		agents,
		sessions,
		llm,
		defaultModel: () => ({ provider: "deepseek", model: "stub-model" }),
		storePath: join(scratchRoot, `store-${Math.random().toString(36).slice(2)}.json`),
		skillsRoot: skillsRoot ?? profileSkillsRoot,
		pollMs: 60_000, // the scheduler is driven manually through tick()
		maxRunMs: 180_000,
		warn: () => {},
		now: () => fakeNow.value,
	});
}

// -------------------------------------------------------------------- tests

await test("answers unknown endpoints with 404 and rejects foreign hosts with 403", async () => {
	const controller = await buildController();
	const missing = await call(controller, { method: "GET", url: `${API}/nope` });
	assert.equal(missing.status, 404);
	const evil = await call(controller, { method: "GET", url: `${API}/tasks`, host: "evil.example:3080" });
	assert.equal(evil.status, 403);
});

await test("/meta mirrors the chat catalog: routable ids, per-provider groups, tolerant failures", async () => {
	const controller = await buildController({
		llm: {
			listProviders: async () => [
				{ id: "deepseek", name: "DeepSeek" },
				{ id: "openai", name: "OpenAI" },
				"bare-id-provider",
			],
			listModels: async (providerId) => {
				if (providerId === "deepseek") {
					return [
						{ provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
						{ id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
					];
				}
				throw new Error(`discovery down for ${providerId}`);
			},
		},
	});
	const meta = await call(controller, { method: "GET", url: `${API}/meta` });
	assert.equal(meta.status, 200);
	assert.deepEqual(meta.payload.defaults, { provider: "deepseek", model: "stub-model" });

	// Providers carry routable IDS (never display names — that mismatch used to
	// make listModels throw and the form's model list render empty), with the
	// name kept aside for presentation.
	assert.deepEqual(
		meta.payload.providers,
		[
			{ id: "deepseek", name: "DeepSeek" },
			{ id: "openai", name: "OpenAI" },
			{ id: "bare-id-provider", name: "bare-id-provider" },
		],
	);

	// One group per provider whose catalog answered, models keyed by id; a
	// failing provider degrades out of the groups instead of blanking them all.
	assert.deepEqual(meta.payload.groups, [
		{
			provider: { id: "deepseek", name: "DeepSeek" },
			models: [
				{ id: "deepseek-chat", name: "DeepSeek Chat" },
				{ id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
			],
		},
	]);
});

await test("/meta stays usable without an llm service (free-text form fallback)", async () => {
	const controller = await buildController();
	const meta = await call(controller, { method: "GET", url: `${API}/meta` });
	assert.equal(meta.status, 200);
	assert.deepEqual(meta.payload.defaults, { provider: "deepseek", model: "stub-model" });
	assert.deepEqual(meta.payload.providers, []);
	assert.deepEqual(meta.payload.groups, []);
});

await test("task CRUD validates input; cron preview reports next occurrences", async () => {
	const controller = await buildController();
	const badCron = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: { workspace: "/tmp/x", cron: "nope", prompt: "p", model: "d/m" },
	});
	assert.equal(badCron.status, 400);
	assert.match(badCron.payload.error, /cron/i);

	const relative = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: { workspace: "relative/path", cron: "* * * * *", prompt: "p", model: "d/m" },
	});
	assert.equal(relative.status, 400);
	assert.match(relative.payload.error, /absolute/);

	const created = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: { workspace: "/tmp/x", cron: "0 9 * * 1-5", prompt: "work hard", model: "deepseek/stub-model" },
	});
	assert.equal(created.status, 201);

	const listed = await call(controller, { method: "GET", url: `${API}/tasks` });
	assert.equal(listed.payload.tasks.length, 1);
	assert.ok(listed.payload.tasks[0].nextRunAt > fakeNow.value, "nextRunAt projected for the UI");

	const preview = await call(controller, {
		method: "GET",
		url: `${API}/cron-preview?expr=*/10%20*%20*%20*%20*`,
	});
	assert.equal(preview.status, 200);
	assert.equal(preview.payload.next.length, 3);
	const badPreview = await call(controller, { method: "GET", url: `${API}/cron-preview?expr=garbage` });
	assert.equal(badPreview.status, 400);

	const taskId = created.payload.id;
	const updated = await call(controller, {
		method: "PUT",
		url: `${API}/tasks/${taskId}`,
		body: { enabled: false },
	});
	assert.equal(updated.status, 200);
	assert.equal(updated.payload.enabled, false);

	const removed = await call(controller, { method: "DELETE", url: `${API}/tasks/${taskId}` });
	assert.equal(removed.status, 200);
	const gone = await call(controller, { method: "DELETE", url: `${API}/tasks/${taskId}` });
	assert.equal(gone.status, 404);
});

await test("/skills feeds the form selector from the project and the profile", async () => {
	const project = await makeProject();
	const controller = await buildController();

	const listed = await call(controller, {
		method: "GET",
		url: `${API}/skills?workspace=${encodeURIComponent(project.root)}`,
	});
	assert.equal(listed.status, 200);
	assert.deepEqual(
		listed.payload.project.map((skill) => `${skill.source}:${skill.id}`),
		["project:review"],
	);
	assert.equal(listed.payload.project[0].name, "review");
	assert.match(listed.payload.project[0].description, /Review the code/);
	assert.deepEqual(
		listed.payload.profile.map((skill) => `${skill.source}:${skill.id}`),
		["profile:profile-skill"],
	);
	assert.match(listed.payload.profile[0].description, /DSH profile/);

	// Without (or with a relative) workspace: profile only, never an error.
	for (const query of ["", `?workspace=relative/path`]) {
		const bare = await call(controller, { method: "GET", url: `${API}/skills${query}` });
		assert.equal(bare.status, 200);
		assert.deepEqual(bare.payload.project, []);
		assert.equal(bare.payload.profile.length, 1);
	}

	await project.cleanup();
});

await test("an attached skill is re-read at firing time and injected as context", async () => {
	const project = await makeProject();
	const agents = makeAgentsStub(true);
	const sessions = makeSessionsStub();
	const controller = await buildController({ agents, sessions });

	const created = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: {
			workspace: project.root,
			cron: "0 0 31 12 *",
			prompt: "Harden the parser",
			model: { provider: "deepseek", model: "stub-model" },
			skill: { source: "project", id: "review" },
		},
	});
	assert.equal(created.status, 201);
	assert.deepEqual(created.payload.skill, { source: "project", id: "review" }, "the stored view echoes the skill");
	const taskId = created.payload.id;

	// Editing the skill between creation and firing must reach the NEXT run:
	// content is read at firing time, never cached in the task.
	await writeFile(
		join(project.root, ".agents", "skills", "review", "SKILL.md"),
		"---\nname: review\ndescription: updated\n---\nREVISED REVIEW CHECKLIST v2\n",
		"utf8",
	);

	const fired = await call(controller, { method: "POST", url: `${API}/tasks/${taskId}/run` });
	assert.equal(fired.status, 202);
	const runs = await waitFor(async () => {
		const listing = await call(controller, { method: "GET", url: `${API}/runs?taskId=${taskId}` });
		const run = listing.payload.runs[0];
		return run && ["done", "error"].includes(run.status) ? listing.payload.runs : undefined;
	}, "terminal run status");
	assert.equal(runs[0].status, "done", runs[0].error ?? "");

	const promptText = agents.creations[0].promptText;
	assert.match(promptText, /\[APPLIED SKILL: review\]/);
	assert.ok(promptText.includes("REVISED REVIEW CHECKLIST v2"), "firing-time content is embedded verbatim");
	assert.ok(promptText.indexOf("[APPLIED SKILL") < promptText.indexOf("TASK:"), "skill precedes the task");
	assert.match(runs[0].note ?? "", /skill 'project:review' applied/);

	await call(controller, { method: "DELETE", url: `${API}/tasks/${taskId}` });
	await project.cleanup();
});

await test("a vanished skill degrades to a note and never fails the run", async () => {
	const project = await makeProject();
	const agents = makeAgentsStub(true);
	const controller = await buildController({ agents });

	// The store validates the reference's SHAPE, not its existence on disk.
	const created = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: {
			workspace: project.root,
			cron: "@daily",
			prompt: "still runs",
			model: "deepseek/stub-model",
			skill: "profile:ghost-skill",
		},
	});
	assert.equal(created.status, 201);
	const taskId = created.payload.id;
	await call(controller, { method: "POST", url: `${API}/tasks/${taskId}/run` });

	const runs = await waitFor(async () => {
		const listing = await call(controller, { method: "GET", url: `${API}/runs?taskId=${taskId}` });
		const run = listing.payload.runs[0];
		return run && ["done", "error"].includes(run.status) ? listing.payload.runs : undefined;
	}, "terminal run status");
	assert.equal(runs[0].status, "done", runs[0].error ?? "");
	assert.doesNotMatch(agents.creations[0].promptText ?? "", /APPLIED SKILL/, "no phantom context is injected");
	assert.match(runs[0].note ?? "", /skill 'profile:ghost-skill' not loaded.*ran without it/);

	// Clearing the skill via PUT removes it from the stored view too.
	const cleared = await call(controller, {
		method: "PUT",
		url: `${API}/tasks/${taskId}`,
		body: { skill: null },
	});
	assert.equal(cleared.status, 200);
	assert.equal(cleared.payload.skill, null);

	await call(controller, { method: "DELETE", url: `${API}/tasks/${taskId}` });
	await project.cleanup();
});

await test("run-now: worktree from up-to-date main, pinned-model iteration, push + PR", async () => {
	const project = await makeProject();
	project.pushUpstreamCommit(); // teammate lands work AFTER the clone
	const upstreamSha = project.upstreamMainSha();

	const agents = makeAgentsStub(true);
	const sessions = makeSessionsStub();
	const controller = await buildController({ agents, sessions });

	const created = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: {
			workspace: project.root,
			cron: "0 0 31 12 *", // far away: only the manual firing matters here
			prompt: "Fix the flaky widget test",
			model: { provider: "deepseek", model: "stub-model" },
		},
	});
	assert.equal(created.status, 201);
	const taskId = created.payload.id;

	const fired = await call(controller, { method: "POST", url: `${API}/tasks/${taskId}/run` });
	assert.equal(fired.status, 202);
	assert.equal(fired.payload.queued, true);

	const runs = await waitFor(async () => {
		const listing = await call(controller, { method: "GET", url: `${API}/runs?taskId=${taskId}` });
		const run = listing.payload.runs[0];
		return run && ["done", "error"].includes(run.status) ? listing.payload.runs : undefined;
	}, "terminal run status");
	const run = runs[0];
	assert.equal(run.status, "done", `unexpected error: ${run.error ?? "(none)"}`);

	// Worktree shape: sched-* branch under <repo>/.dsh/worktrees, based on the
	// fetched upstream tip, with local main fast-forwarded.
	assert.match(run.branch, /^sched-[0-9a-f]{6,8}-\d{8}-\d{6}$/);
	const realRoot = realpathSync(project.root);
	assert.ok(run.worktreePath.startsWith(join(realRoot, ".dsh", "worktrees") + "/"));
	const headInside = git(["rev-parse", "HEAD"], run.worktreePath).trim();
	assert.equal(git(["rev-parse", `${headInside}^`], run.worktreePath).trim(), upstreamSha);
	assert.equal(project.localMainSha(), upstreamSha);

	// The agent ran INSIDE the worktree with the pinned provider/model and the
	// framed prompt carrying the user's task verbatim.
	assert.equal(agents.creations.length, 1);
	const creation = agents.creations[0];
	assert.equal(creation.meta.cwd, run.worktreePath);
	assert.deepEqual(creation.agentOptions, { provider: "deepseek", model: "stub-model" });
	assert.match(creation.promptText, /\[SCHEDULED TASK\]/);
	assert.ok(creation.promptText.includes("Fix the flaky widget test"));

	// Landing: pushed branch + adopted fake PR.
	assert.equal(run.prUrl, "https://github.com/acme/widget/pull/77");
	assert.equal(run.prNumber, 77);
	assert.match(run.note ?? "", /branch pushed/);
	const remoteHead = git(["rev-parse", `refs/heads/${run.branch}`], project.origin).trim();
	assert.equal(remoteHead, headInside);
	assert.equal(remoteHead, headInside);
	assert.ok(run.sessionId, "the run carries the created session id");
	assert.ok(sessions.flushed.includes(run.sessionId));

	const tasks = await call(controller, { method: "GET", url: `${API}/tasks` });
	const taskView = tasks.payload.tasks.find((entry) => entry.id === taskId);
	assert.equal(taskView.lastStatus, "done");

	await call(controller, { method: "DELETE", url: `${API}/tasks/${taskId}` });
	await project.cleanup();
});

await test("an idle iteration finishes cleanly without pushing anything", async () => {
	const project = await makeProject();
	const controller = await buildController({ agents: makeAgentsStub(false) });

	const created = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: { workspace: project.root, cron: "@daily", prompt: "audit docs", model: "deepseek/stub-model" },
	});
	const taskId = created.payload.id;
	await call(controller, { method: "POST", url: `${API}/tasks/${taskId}/run` });

	const run = await waitFor(async () => {
		const listing = await call(controller, { method: "GET", url: `${API}/runs?taskId=${taskId}` });
		const candidate = listing.payload.runs[0];
		return candidate && ["done", "error"].includes(candidate.status) ? candidate : undefined;
	}, "terminal run status");
	assert.equal(run.status, "done", run.error ?? "");
	assert.match(run.note ?? "", /produced no changes/);
	assert.equal(run.prUrl, null);

	await call(controller, { method: "DELETE", url: `${API}/tasks/${taskId}` });
	await project.cleanup();
});

await test("a missing agents service surfaces as a failed run, not a crash", async () => {
	const project = await makeProject();
	const controller = await buildController({});
	const created = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: { workspace: project.root, cron: "@daily", prompt: "p", model: "deepseek/stub-model" },
	});
	const taskId = created.payload.id;
	await call(controller, { method: "POST", url: `${API}/tasks/${taskId}/run` });
	const run = await waitFor(async () => {
		const listing = await call(controller, { method: "GET", url: `${API}/runs?taskId=${taskId}` });
		const candidate = listing.payload.runs[0];
		return candidate && candidate.status === "error" ? candidate : undefined;
	}, "failed run status");
	assert.match(run.error, /agents/);
	await call(controller, { method: "DELETE", url: `${API}/tasks/${taskId}` });
	await project.cleanup();
});

await test("gh failures degrade into notes instead of losing the run", async () => {
	const project = await makeProject();
	const controller = await buildController({ agents: makeAgentsStub(true), ghMode: "broken" });
	const created = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: { workspace: project.root, cron: "@daily", prompt: "p", model: "deepseek/stub-model" },
	});
	const taskId = created.payload.id;
	await call(controller, { method: "POST", url: `${API}/tasks/${taskId}/run` });
	const run = await waitFor(async () => {
		const listing = await call(controller, { method: "GET", url: `${API}/runs?taskId=${taskId}` });
		const candidate = listing.payload.runs[0];
		return candidate && ["done", "error"].includes(candidate.status) ? candidate : undefined;
	}, "terminal run status");
	assert.equal(run.status, "done", `unexpected error: ${run.error ?? ""}`);
	assert.match(run.note ?? "", /gh pr create failed/);
	assert.equal(run.prUrl, null);
	await call(controller, { method: "DELETE", url: `${API}/tasks/${taskId}` });
	await project.cleanup();
});

await test("the scheduler fires due tasks once, never early, never for paused ones", async () => {
	const project = await makeProject();
	const agents = makeAgentsStub(true);
	const controller = await buildController({ agents });

	const due = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: { workspace: project.root, cron: "45 8 * * *", prompt: "tick me", model: "deepseek/stub-model" },
	});
	const paused = await call(controller, {
		method: "POST",
		url: `${API}/tasks`,
		body: {
			workspace: project.root,
			cron: "45 8 * * *",
			prompt: "paused",
			model: "deepseek/stub-model",
			enabled: false,
		},
	});
	const dueId = due.payload.id;
	const pausedId = paused.payload.id;

	// First tick projects the next occurrence at 08:45 today.
	await controller.tick();
	let view = (await call(controller, { method: "GET", url: `${API}/tasks` })).payload.tasks;
	const nowDate = new Date(fakeNow.value);
	const expectedNext = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 8, 45).getTime();
	assert.equal(view.find((t) => t.id === dueId).nextRunAt, expectedNext);

	// Not due yet: nothing fires.
	fakeNow.value += 5 * 60_000; // 08:35
	await controller.tick();
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal((await call(controller, { method: "GET", url: `${API}/runs?taskId=${dueId}` })).payload.runs.length, 0);

	// Due: exactly one firing.
	fakeNow.value += 15 * 60_000; // 08:50
	await controller.tick();
	await waitFor(async () => {
		const runs = (await call(controller, { method: "GET", url: `${API}/runs?taskId=${dueId}` })).payload.runs;
		return runs.length > 0;
	}, "scheduler-fired run");

	// Repeat ticks at the same instant never double-fire.
	await controller.tick();
	await controller.tick();
	await new Promise((resolve) => setTimeout(resolve, 500));
	const finalRuns = (await call(controller, { method: "GET", url: `${API}/runs?taskId=${dueId}` })).payload.runs;
	assert.equal(finalRuns.length, 1, "no duplicate firing per occurrence");
	assert.equal(finalRuns[0].status, "done", finalRuns[0].error ?? "");

	const pausedRuns = (await call(controller, { method: "GET", url: `${API}/runs?taskId=${pausedId}` })).payload.runs;
	assert.equal(pausedRuns.length, 0, "paused tasks never fire");
	void view;

	await call(controller, { method: "DELETE", url: `${API}/tasks/${dueId}` });
	await call(controller, { method: "DELETE", url: `${API}/tasks/${pausedId}` });
	await project.cleanup();
});

// ------------------------------------------------------------------ cleanup

for (const path of Object.values(ghPaths)) {
	await rm(path.split("/gh")[0] ? path.slice(0, path.lastIndexOf("/")) : path, { recursive: true, force: true }).catch(() => {});
}
await rm(scratchRoot, { recursive: true, force: true });
console.log(`\n${passed} tests passed`);
