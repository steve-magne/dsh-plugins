/**
 * Standalone functional test for the @dsh-plugins/worktree-launcher host half.
 * Runs without cordis: drives `createWorktreeLauncher` against a stubbed
 * subprocess service implemented over node:child_process, through mock req/res
 * objects, and exercises REAL temporary git repositories (including a local
 * bare origin, so fetch/fast-forward paths run without any network).
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRANCH_PATTERN, classifyChecks, createSessionTitleLister, createWorktreeLauncher, deriveBadgeState } from "../lib/index.js";

// ---------------------------------------------------------------- git fixture

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "wtl-test",
	GIT_AUTHOR_EMAIL: "wtl@test.local",
	GIT_COMMITTER_NAME: "wtl-test",
	GIT_COMMITTER_EMAIL: "wtl@test.local",
};

function git(args, cwd) {
	const result = spawnSync("git", args, {
		cwd,
		env: GIT_ENV,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
		);
	}
	return result.stdout;
}

/** A scratch project cloned from a local bare origin, on branch main. */
async function makeProject(options = {}) {
	const dir = await mkdtemp(join(tmpdir(), "wtl-fixture-"));
	const cleanupFns = [];
	const origin = join(dir, "origin.git");
	try {
		git(["init", "--quiet", "--bare", "--initial-branch=main", origin], dir);
	} catch {
		git(["init", "--quiet", "--bare", origin], dir);
		git(["symbolic-ref", "HEAD", "refs/heads/main"], origin);
	}
	const root = join(dir, "project");
	git(["clone", "--quiet", origin, root], dir);
	git(["config", "user.email", "wtl@test.local"], root);
	git(["config", "user.name", "wtl-test"], root);
	await writeFile(join(root, "README.md"), "# fixture\n", "utf8");
	git(["add", "."], root);
	git(["commit", "-q", "-m", "seed"], root);
	git(["push", "-q", "-u", "origin", "main"], root);
	if (options.breakOrigin) {
		await rm(origin, { recursive: true, force: true });
	}
	if (options.dropOrigin) {
		git(["remote", "remove", "origin"], root);
	}
	return {
		dir,
		root,
		origin,
		bareMainSha: () => git(["rev-parse", "main"], origin).trim(),
		localMainSha: () => git(["rev-parse", "main"], root).trim(),
	};
}

/** Advance the bare origin's main (simulating teammates landing commits). */
function pushCommitToOrigin(project) {
	const drive = join(project.dir, "drive");
	git(["clone", "--quiet", project.origin, drive], project.dir);
	git(["config", "user.email", "wtl@test.local"], drive);
	git(["config", "user.name", "wtl-test"], drive);
	writeFileSync(join(drive, "feature.txt"), "upstream work\n", "utf8");
	git(["add", "."], drive);
	git(["commit", "-q", "-m", "upstream"], drive);
	git(["push", "-q", "origin", "main"], drive);
	return drive;
}

// ------------------------------------------------------------------- stubs

/** Minimal SubprocessRuntime stand-in over node:child_process. */
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
	let doneResolve;
	let doneReject;
	const done = new Promise((res, rej) => {
		doneResolve = res;
		doneReject = rej;
	});
	child.on("error", (error) => {
		if (!settled) {
			settled = true;
			doneReject(error);
		}
	});
	child.on("close", (code, signal) => {
		if (!settled) {
			settled = true;
			doneResolve({ exitCode: code, signal });
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
		async waitForExit() {
			await done.catch(() => {});
			return true;
		},
	};
}

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

async function call(launcher, options) {
	const req = makeReq(options);
	const fake = {
		status: null,
		body: null,
		writeHead(statusCode) {
			this.status = statusCode;
		},
		end(bodyText) {
			this.body = bodyText;
		},
	};
	await launcher.handle(req, fake);
	assert.notEqual(fake.status, null, "handler must answer every request");
	return { status: fake.status, payload: JSON.parse(fake.body) };
}

/** Pre-settled subprocess handle for intercepted gh calls. */
function fakeHandle({ code, out = "", err = "" }) {
	const text = out;
	return {
		pid: -1,
		done: Promise.resolve({ exitCode: code, signal: null }),
		collected: {
			stdout: {
				readFrom(fromByte) {
					return { text: text.slice(fromByte), nextOffset: text.length, lossy: false };
				},
			},
			stderr: {
				readFrom(fromByte) {
					return { text: err.slice(fromByte), nextOffset: err.length, lossy: false };
				},
			},
		},
		terminate() {},
		async waitForExit() {
			return true;
		},
	};
}

/**
 * Launcher over real git plus an in-memory fake `gh`: branch -> PR JSON (or
 * absence) is decided by the mutable `prConfig` map, and every gh invocation
 * is recorded so tests can assert the TTL cache.
 */
function makeGhLauncher({ prConfig, titles, prTtlMs = 60 }) {
	const ghCalls = [];
	const launcher = createWorktreeLauncher({
		spawn: (spec) => {
			if (spec.argv[0] === "gh") {
				ghCalls.push(spec.argv.slice(1));
				const view = argvBranch(spec.argv);
				const json = prConfig.get(view);
				if (!json) return fakeHandle({ code: 1, err: `no pull request for ${view}` });
				return fakeHandle({ code: 0, out: json });
			}
			return spawnStub(spec);
		},
		resolveExecutable: async (command) => command,
		listSessionTitles: titles,
		prTtlMs,
		warn: (message) => warnings.push(message),
	});
	return { launcher, ghCalls };
}

function argvBranch(argv) {
	const index = argv.indexOf("view");
	return index >= 0 ? argv[index + 1] : "";
}

function prView(payload) {
	return JSON.stringify({
		number: 7,
		url: "https://github.com/ex/repo/pull/7",
		state: "OPEN",
		statusCheckRollup: [],
		...payload,
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const byTitle = (states, title) => states.find((entry) => entry.title === title);

// -------------------------------------------------------------------- tests

let passed = 0;
let current = "";
async function test(name, fn) {
	current = name;
	try {
		await fn();
		passed += 1;
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

const warnings = [];
const launcher = createWorktreeLauncher({
	spawn: (spec) => spawnStub(spec),
	resolveExecutable: async (command) => command,
	warn: (message) => warnings.push(message),
});

const projectA = await makeProject();
// Offline simulation: an upstream commit lands, then the origin disappears
// before the plugin ever fetches it.
const projectOffline = await makeProject();
pushCommitToOrigin(projectOffline);
await rm(join(projectOffline.dir, "origin.git"), { recursive: true, force: true });
const projectNoRemote = await makeProject({ dropOrigin: true });
const projectPr = await makeProject();

await test("answers unknown endpoints with 404 and rejects foreign hosts with 403", async () => {
	const missing = await call(launcher, {
		method: "GET",
		url: "/worktree-launcher/api/nope",
	});
	assert.equal(missing.status, 404);
	assert.ok(missing.payload.error.includes("no such worktree-launcher endpoint"));
	const evil = await call(launcher, {
		method: "GET",
		url: "/worktree-launcher/api/worktrees",
		host: "evil.example:3080",
	});
	assert.equal(evil.status, 403);
});

await test("preference defaults ON and round-trips through PUT", async () => {
	const initial = await call(launcher, { method: "GET", url: "/worktree-launcher/api/pref" });
	assert.deepEqual(initial.payload, { enabled: true });
	const flipped = await call(launcher, {
		method: "PUT",
		url: "/worktree-launcher/api/pref",
		body: { enabled: false },
	});
	assert.deepEqual(flipped.payload, { enabled: false });
	const invalid = await call(launcher, {
		method: "PUT",
		url: "/worktree-launcher/api/pref",
		body: { enabled: "yes" },
	});
	assert.equal(invalid.status, 400);
	await call(launcher, { method: "PUT", url: "/worktree-launcher/api/pref", body: { enabled: true } });
});

await test("creates an isolated dsh-* worktree based on an up-to-date main", async () => {
	// A teammate lands a commit on the bare origin AFTER the clone: the plugin
	// must fetch it and base the worktree on the updated tip ("pull au besoin").
	pushCommitToOrigin(projectA);
	const upstreamSha = projectA.bareMainSha();

	const created = await call(launcher, {
		method: "POST",
		url: "/worktree-launcher/api/worktrees",
		body: { root: projectA.root, sessionId: "session-a" },
	});
	assert.equal(created.status, 201);
	const rec = created.payload;
	assert.match(rec.branch, BRANCH_PATTERN, `branch shape: ${rec.branch}`);
	assert.ok(rec.branch.startsWith("dsh-"), "branch must be prefixed dsh-");
	assert.equal(rec.branch.split("-").length, 4, "exactly three words after dsh-");
	assert.ok(
		rec.path.startsWith(join(realpathSync(projectA.root), ".dsh", "worktrees") + "/"),
		`path under <repo>/.dsh/worktrees: ${rec.path}`,
	);
	assert.ok(existsSync(rec.path), "worktree directory must exist");
	assert.equal(rec.mainUpdated, true, "local main must have been fast-forwarded");
	assert.equal(rec.baseBranch, "main");
	assert.equal(rec.baseSha, upstreamSha, "worktree must base on the fetched tip");

	// The worktree is checked out at exactly that commit.
	const headInside = git(["rev-parse", "HEAD"], rec.path).trim();
	assert.equal(headInside, upstreamSha);

	// Local main moved too (fast-forwarded without checkout).
	assert.equal(projectA.localMainSha(), upstreamSha);

	// .dsh/worktrees stays invisible to git status (info/exclude).
	const status = git(["status", "--porcelain"], projectA.root);
	assert.equal(status.trim(), "", "repo status must stay clean");
	const exclude = await readFile(
		join(projectA.root, ".git", "info", "exclude"),
		"utf8",
	);
	assert.ok(exclude.includes(".dsh/worktrees/"), "exclude rule recorded");

	// Session binding is idempotent.
	const again = await call(launcher, {
		method: "POST",
		url: "/worktree-launcher/api/worktrees",
		body: { root: projectA.root, sessionId: "session-a" },
	});
	assert.equal(again.status, 200);
	assert.equal(again.payload.created, false);
	assert.equal(again.payload.branch, rec.branch);

	// Lookup endpoints agree.
	const bySession = await call(launcher, {
		method: "GET",
		url: "/worktree-launcher/api/by-session/session-a",
	});
	assert.equal(bySession.status, 200);
	assert.equal(bySession.payload.branch, rec.branch);
	const listed = await call(launcher, {
		method: "GET",
		url: "/worktree-launcher/api/worktrees",
	});
	assert.ok(listed.payload.worktrees.some((entry) => entry.branch === rec.branch));

	// Sibling contract: @dsh-plugins/create-pr reads this index to route its
	// pipeline at the session's OWN worktree.
	const bindingsIndex = JSON.parse(
		await readFile(join(projectA.root, ".dsh", "worktrees", "bindings.json"), "utf8"),
	);
	assert.equal(bindingsIndex.version, 1);
	assert.ok(
		bindingsIndex.bindings.some(
			(entry) =>
				entry.sessionId === "session-a" &&
				entry.branch === rec.branch &&
				entry.path === rec.path,
		),
		`binding index must map session-a -> ${rec.branch}`,
	);
});

await test("still creates a worktree when the origin is unreachable (offline)", async () => {
	const created = await call(launcher, {
		method: "POST",
		url: "/worktree-launcher/api/worktrees",
		body: { root: projectOffline.root, sessionId: "session-offline" },
	});
	assert.equal(created.status, 201);
	assert.equal(created.payload.mainUpdated, false);
	assert.ok(
		created.payload.note.startsWith("fetch failed"),
		`note: ${created.payload.note}`,
	);
	// Graceful degradation: the worktree bases on the last known remote tip.
	const staleSha = git(
		["rev-parse", "refs/remotes/origin/main"],
		projectOffline.root,
	).trim();
	assert.equal(created.payload.baseSha, staleSha);
	assert.ok(existsSync(created.payload.path));
});

await test("handles repositories without any origin remote", async () => {
	const created = await call(launcher, {
		method: "POST",
		url: "/worktree-launcher/api/worktrees",
		body: { root: projectNoRemote.root, sessionId: "session-noremote" },
	});
	assert.equal(created.status, 201);
	assert.equal(created.payload.mainUpdated, false);
	assert.equal(created.payload.note, "no origin remote configured");
	assert.ok(existsSync(created.payload.path));
});

await test("validates input: missing root, non-repo root, unknown session", async () => {
	const noRoot = await call(launcher, {
		method: "POST",
		url: "/worktree-launcher/api/worktrees",
		body: {},
	});
	assert.equal(noRoot.status, 400);
	const notARepo = await call(launcher, {
		method: "POST",
		url: "/worktree-launcher/api/worktrees",
		body: { root: tmpdir(), sessionId: "session-bad" },
	});
	assert.equal(notARepo.status, 400);
	assert.ok(notARepo.payload.error.includes("not a git repository"));
	const unknown = await call(launcher, {
		method: "GET",
		url: "/worktree-launcher/api/by-session/nobody",
	});
	assert.equal(unknown.status, 404);
});

await test("agent wiring: startup+turn1 auto-creates; resumes, subagents and later turns do not", async () => {
	const header = { cwd: projectA.root };
	const agent = { id: "session-auto", session: { header } };

	// Not eligible yet: nothing happens even on turn 1.
	await launcher.maybeCreateForTurn({ agent, turn: 1 });
	assert.equal(launcher.recordForSession("session-auto"), undefined);

	// Resume-style lifecycles never become eligible.
	launcher.markEligible({ agent, source: "resume" });
	await launcher.maybeCreateForTurn({ agent, turn: 1 });
	assert.equal(launcher.recordForSession("session-auto"), undefined);

	// Subagents/forks are refused even with source startup.
	const subAgent = {
		id: "session-sub",
		session: { header: { cwd: projectA.root, origin: "subagent" } },
	};
	launcher.markEligible({ agent: subAgent, source: "startup" });
	await launcher.maybeCreateForTurn({ agent: subAgent, turn: 1 });
	assert.equal(launcher.recordForSession("session-sub"), undefined);

	const forked = {
		id: "session-fork",
		session: { header: { cwd: projectA.root, parentSession: "session-a" } },
	};
	launcher.markEligible({ agent: forked, source: "startup" });
	await launcher.maybeCreateForTurn({ agent: forked, turn: 1 });
	assert.equal(launcher.recordForSession("session-fork"), undefined);

	// Fresh root session: eligible, but turn 2 alone does nothing...
	launcher.markEligible({ agent, source: "startup" });
	await launcher.maybeCreateForTurn({ agent, turn: 2 });
	assert.equal(launcher.recordForSession("session-auto"), undefined);

	// ...the first real message materializes the worktree.
	await launcher.maybeCreateForTurn({ agent, turn: 1 });
	const record = launcher.recordForSession("session-auto");
	assert.ok(record, "auto-created worktree must bind to the session");
	assert.match(record.branch, BRANCH_PATTERN);
	assert.ok(existsSync(record.path));

	// Second message on the same session never duplicates.
	await launcher.maybeCreateForTurn({ agent, turn: 2 });
	assert.equal(launcher.recordForSession("session-auto").branch, record.branch);

	// Disabled preference gates creation.
	await call(launcher, { method: "PUT", url: "/worktree-launcher/api/pref", body: { enabled: false } });
	const gated = { id: "session-gated", session: { header } };
	launcher.markEligible({ agent: gated, source: "startup" });
	await launcher.maybeCreateForTurn({ agent: gated, turn: 1 });
	assert.equal(launcher.recordForSession("session-gated"), undefined);
	await call(launcher, { method: "PUT", url: "/worktree-launcher/api/pref", body: { enabled: true } });

	// The scoped prompt section describes exactly this session's worktree.
	const sectionText = launcher.promptSectionText({ scope: agent });
	assert.ok(sectionText.includes(record.branch), "section names the branch");
	assert.ok(sectionText.includes(record.path), "section names the path");
	assert.equal(launcher.promptSectionText({ scope: { id: "nobody" } }), "");
	assert.equal(launcher.promptSectionText(undefined), "");
});

await test("concurrent turn-1 triggers bind ONE worktree; creationOf exposes the prompt gate", async () => {
	const header = { cwd: projectNoRemote.root };

	// Two simultaneous triggers for one eligible session (racing events or a
	// double click): the per-repo chain plus the under-lock re-check must
	// yield exactly one bound worktree.
	const raceAgent = { id: "session-race", session: { header } };
	launcher.markEligible({ agent: raceAgent, source: "startup" });
	await Promise.all([
		launcher.maybeCreateForTurn({ agent: raceAgent, turn: 1 }),
		launcher.maybeCreateForTurn({ agent: raceAgent, turn: 1 }),
	]);
	const record = launcher.recordForSession("session-race");
	assert.ok(record, "the race must still bind a worktree");
	assert.match(record.branch, BRANCH_PATTERN);
	const mine = launcher
		.listWorktrees()
		.filter((entry) => entry.sessionId === "session-race");
	assert.equal(mine.length, 1, `one worktree per session, got ${mine.length}`);

	// An in-flight creation is observable so the system-prompt assembly can
	// hold turn 1 until the worktree exists; the gate clears once settled.
	const gateAgent = { id: "session-gate", session: { header } };
	launcher.markEligible({ agent: gateAgent, source: "startup" });
	const inflight = launcher.maybeCreateForTurn({ agent: gateAgent, turn: 1 });
	for (let attempt = 0; attempt < 100 && !launcher.creationOf("session-gate"); attempt += 1) {
		await sleep(5);
	}
	assert.ok(launcher.creationOf("session-gate"), "in-flight creation exposes a gate");
	await inflight;
	assert.equal(launcher.creationOf("session-gate"), undefined, "gate clears when settled");
	assert.ok(launcher.recordForSession("session-gate"), "gated creation completed");
	assert.equal(launcher.creationOf("nobody"), undefined);

	// Cleanup both.
	for (const branch of [record.branch, launcher.recordForSession("session-gate").branch]) {
		await call(launcher, {
			method: "DELETE",
			url: `/worktree-launcher/api/worktrees/${branch}?force=1`,
		});
	}
});

await test("removes a clean worktree, refuses a dirty one without force", async () => {
	const dirty = await call(launcher, {
		method: "POST",
		url: "/worktree-launcher/api/worktrees",
		body: { root: projectNoRemote.root, sessionId: "session-dirty" },
	});
	assert.equal(dirty.status, 201);
	await writeFile(join(dirty.payload.path, "scratch.txt"), "dirty\n", "utf8");

	const refused = await call(launcher, {
		method: "DELETE",
		url: `/worktree-launcher/api/worktrees/${dirty.payload.branch}`,
	});
	assert.equal(refused.status, 409, "dirty worktree removal must be refused");
	assert.ok(existsSync(dirty.payload.path), "dirty worktree must survive");

	const forced = await call(launcher, {
		method: "DELETE",
		url: `/worktree-launcher/api/worktrees/${dirty.payload.branch}?force=1`,
	});
	assert.equal(forced.status, 200);
	assert.equal(existsSync(dirty.payload.path), false, "forced removal deletes the tree");
	assert.equal(
		(await call(launcher, { method: "GET", url: "/worktree-launcher/api/by-session/session-dirty" }))
			.status,
		404,
		"binding must be dropped with the worktree",
	);
	const prunedIndex = JSON.parse(
		await readFile(join(projectNoRemote.root, ".dsh", "worktrees", "bindings.json"), "utf8"),
	);
	assert.ok(
		!prunedIndex.bindings.some((entry) => entry.sessionId === "session-dirty"),
		"removal must also drop the session from the binding index",
	);

	// Clean removal path + guards.
	const victim = launcher.listWorktrees()[0];
	const removed = await call(launcher, {
		method: "DELETE",
		url: `/worktree-launcher/api/worktrees/${victim.branch}`,
	});
	assert.equal(removed.status, 200);
	assert.equal(existsSync(victim.path), false);
	const repeat = await call(launcher, {
		method: "DELETE",
		url: `/worktree-launcher/api/worktrees/${victim.branch}`,
	});
	assert.equal(repeat.status, 404);
	const badName = await call(launcher, {
		method: "DELETE",
		url: "/worktree-launcher/api/worktrees/not-a-dsh-branch!",
	});
	assert.equal(badName.status, 400);
});

await test("minted branch names are unique under repetition pressure", async () => {
	const seen = new Set();
	for (let index = 0; index < 25; index += 1) {
		const created = await call(launcher, {
			method: "POST",
			url: "/worktree-launcher/api/worktrees",
			body: { root: projectNoRemote.root },
		});
		assert.equal(created.status, 201);
		assert.ok(!seen.has(created.payload.branch), "no branch collision");
		seen.add(created.payload.branch);
	}
	// Cleanup so later suites start lean.
	for (const branch of seen) {
		await call(launcher, {
			method: "DELETE",
			url: `/worktree-launcher/api/worktrees/${branch}?force=1`,
		});
	}
});

await test("badge derivation: check vocabulary and PR states map onto the four colors", () => {
	assert.equal(deriveBadgeState(null), "created");
	assert.equal(deriveBadgeState(undefined), "created");
	assert.equal(deriveBadgeState({ state: "MERGED" }), "merged");
	assert.equal(deriveBadgeState({ state: "CLOSED" }), "problem");
	assert.equal(deriveBadgeState({ state: "OPEN", statusCheckRollup: [] }), "pr");
	assert.equal(
		deriveBadgeState({
			state: "OPEN",
			statusCheckRollup: [{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }],
		}),
		"pr",
	);
	assert.equal(
		deriveBadgeState({
			state: "OPEN",
			statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }],
		}),
		"problem",
	);
	assert.equal(
		deriveBadgeState({ state: "OPEN", statusCheckRollup: [{ state: "ERROR" }] }),
		"problem",
	);
	assert.equal(classifyChecks([]).outcome, "empty");
	assert.equal(classifyChecks([{ conclusion: "SUCCESS" }]).outcome, "passed");
	assert.equal(classifyChecks([{ status: "QUEUED" }]).outcome, "pending");
	assert.equal(classifyChecks([{ conclusion: "TIMED_OUT" }]).outcome, "failed");
});

await test("title lister tolerates sessionQuery shapes; absent service yields empty", async () => {
	const viaSnapshots = createSessionTitleLister({
		readTitleSnapshots: async (ids) =>
			ids.map((id, index) =>
				index % 2 === 0
					? { sessionId: id, title: `  Title ${id}  ` }
					: { snapshot: { title: `Title ${id}` } },
			),
	});
	assert.deepEqual(await viaSnapshots(["a", "b"]), [
		{ sessionId: "a", title: "Title a" },
		{ sessionId: "b", title: "Title b" },
	]);

	let queried = null;
	const viaList = createSessionTitleLister({
		listSessions: async () => {
			queried = "called";
			return [
				{ sessionId: "a", title: "Alpha" },
				{ id: "b", displayTitle: "Beta" },
				{ sessionId: "outsider", title: "Nope" },
			];
		},
	});
	assert.deepEqual(await viaList(["a", "b"]), [
		{ sessionId: "a", title: "Alpha" },
		{ sessionId: "b", title: "Beta" },
	]);
	assert.equal(queried, "called");

	const none = createSessionTitleLister(undefined, { warn: (message) => warnings.push(message) });
	assert.deepEqual(await none(["a"]), []);
});

await test("session-states joins titles with live PR states behind a TTL cache", async () => {
	const prConfig = new Map();
	const titles = async (ids) => ids.map((id) => ({ sessionId: id, title: `Session ${id}` }));
	const ttlMs = 60;
	const { launcher: lp, ghCalls } = makeGhLauncher({ prConfig, titles, prTtlMs: ttlMs });

	await call(lp, {
		method: "POST",
		url: "/worktree-launcher/api/worktrees",
		body: { root: projectPr.root, sessionId: "session-red" },
	});
	await call(lp, {
		method: "POST",
		url: "/worktree-launcher/api/worktrees",
		body: { root: projectPr.root, sessionId: "session-green" },
	});
	const redBranch = lp.recordForSession("session-red").branch;
	const greenBranch = lp.recordForSession("session-green").branch;
	assert.notEqual(redBranch, greenBranch);

	// No PR configured yet: every session is a plain created worktree (green).
	const fresh = await call(lp, {
		method: "GET",
		url: "/worktree-launcher/api/session-states",
	});
	assert.equal(fresh.status, 200);
	assert.deepEqual(fresh.payload.states.map((entry) => entry.sessionId).sort(), [
		"session-green",
		"session-red",
	]);
	assert.equal(byTitle(fresh.payload.states, "Session session-red").state, "created");
	assert.equal(byTitle(fresh.payload.states, "Session session-green").state, "created");
	assert.match(byTitle(fresh.payload.states, "Session session-red").branch, BRANCH_PATTERN);
	const callsAfterFresh = ghCalls.length;
	assert.equal(callsAfterFresh, 2);

	// Within the TTL no new gh process runs.
	await call(lp, { method: "GET", url: "/worktree-launcher/api/session-states" });
	assert.equal(ghCalls.length, callsAfterFresh, "TTL cache must absorb repeat polls");

	// CI turns failing on the red session's branch -> problem (red).
	prConfig.set(
		redBranch,
		prView({ statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] }),
	);
	await sleep(ttlMs + 60);
	const failing = await call(lp, {
		method: "GET",
		url: "/worktree-launcher/api/session-states",
	});
	assert.equal(byTitle(failing.payload.states, "Session session-red").state, "problem");
	assert.equal(byTitle(failing.payload.states, "Session session-red").prNumber, 7);
	assert.equal(
		byTitle(failing.payload.states, "Session session-red").prUrl,
		"https://github.com/ex/repo/pull/7",
	);
	assert.equal(byTitle(failing.payload.states, "Session session-green").state, "created");

	// Recovered CI -> open PR (blue).
	prConfig.set(redBranch, prView({}));
	await sleep(ttlMs + 60);
	const recovered = await call(lp, {
		method: "GET",
		url: "/worktree-launcher/api/session-states",
	});
	assert.equal(byTitle(recovered.payload.states, "Session session-red").state, "pr");

	// Merged -> purple.
	prConfig.set(redBranch, prView({ state: "MERGED" }));
	await sleep(ttlMs + 60);
	const merged = await call(lp, {
		method: "GET",
		url: "/worktree-launcher/api/session-states",
	});
	assert.equal(byTitle(merged.payload.states, "Session session-red").state, "merged");

	// Closed without merging stays a problem.
	prConfig.set(redBranch, prView({ state: "CLOSED" }));
	await sleep(ttlMs + 60);
	const closed = await call(lp, {
		method: "GET",
		url: "/worktree-launcher/api/session-states",
	});
	assert.equal(byTitle(closed.payload.states, "Session session-red").state, "problem");

	// Sessions whose title never resolves never reach the feed.
	const untitled = makeGhLauncher({ prConfig, titles: async () => [] });
	await call(untitled.launcher, {
		method: "POST",
		url: "/worktree-launcher/api/worktrees",
		body: { root: projectPr.root, sessionId: "session-x" },
	});
	const hidden = await call(untitled.launcher, {
		method: "GET",
		url: "/worktree-launcher/api/session-states",
	});
	assert.deepEqual(hidden.payload.states, []);
	assert.ok(untitled.ghCalls.length === 0, "no gh call without a matchable row");
});

await test("shutdown drops all state", async () => {
	launcher.shutdown();
	const listed = await call(launcher, {
		method: "GET",
		url: "/worktree-launcher/api/worktrees",
	});
	assert.equal(listed.payload.worktrees.length, 0);
});

// Leave no scratch behind on success.
for (const project of [projectA, projectOffline, projectNoRemote, projectPr]) {
	await rm(project.dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} tests passed`);
