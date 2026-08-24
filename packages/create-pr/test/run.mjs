/**
 * Standalone functional test for the @dsh-plugins/create-pr host half.
 * Runs without cordis: drives `createPrLauncher` against a stubbed subprocess
 * service implemented over node:child_process, through mock req/res objects,
 * exercising REAL temporary git repositories (local bare origin) plus a FAKE
 * `gh` executable whose behavior is scripted by state files — so the whole
 * pipeline (commit -> push -> pr create -> CI watchdog -> followup wake) runs
 * offline and deterministically.
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONVENTIONAL_SUBJECT_RE,
	classifyChecks,
	createPrLauncher,
	deterministicFallbackMessage,
	extractPrUrl,
	parseConventionalMessage,
	parseGitHubOwnerRepo,
} from "../lib/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- git fixture

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "cpr-test",
	GIT_AUTHOR_EMAIL: "cpr@test.local",
	GIT_COMMITTER_NAME: "cpr-test",
	GIT_COMMITTER_EMAIL: "cpr@test.local",
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

/** A scratch project cloned from a local bare origin. */
async function makeProject({ branch = "feat/widget" } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "cpr-fixture-"));
	const origin = join(dir, "origin.git");
	try {
		git(["init", "--quiet", "--bare", "--initial-branch=main", origin], dir);
	} catch {
		git(["init", "--quiet", "--bare", origin], dir);
		git(["symbolic-ref", "HEAD", "refs/heads/main"], origin);
	}
	const root = join(dir, "project");
	git(["clone", "--quiet", origin, root], dir);
	// Present a GitHub-shaped origin to the plugin while every fetch/push still
	// hits the local bare repo (git url.<base>.insteadOf rewrite).
	git(["remote", "set-url", "origin", "https://github.com/acme/widget.git"], root);
	git(["config", `url.${origin}.insteadOf`, "https://github.com/acme/widget.git"], root);
	git(["config", "user.email", "cpr@test.local"], root);
	git(["config", "user.name", "cpr-test"], root);
	await writeFile(join(root, "README.md"), "# fixture\n", "utf8");
	git(["add", "."], root);
	git(["commit", "-q", "-m", "seed"], root);
	git(["push", "-q", "-u", "origin", "main"], root);
	if (branch !== "main") git(["checkout", "-q", "-b", branch], root);
	return { dir, root, origin, branch };
}

async function makeStateDir() {
	return mkdtemp(join(tmpdir(), "cpr-ghstate-"));
}

// -------------------------------------------------------------- fake gh fixture

/**
 * A deterministic gh stand-in. Behavior is driven by files inside
 * $CREATE_PR_FAKE_STATE (passed through the stubbed spawn env):
 *   checks.json    — answer body for `gh pr view` (rollup snapshots)
 *   pr-list.json   — answer body for `gh pr list --head …` (PR adoption)
 *   runs.json      — answer body for `gh run list`
 *   fail-log.txt   — answer body for `gh run view --log-failed`
 * Every invocation is appended to calls.log for assertions.
 */
function installFakeGh(dir) {
	const script = join(dir, "fake-gh");
	writeFileSync(
		script,
		[
			"#!/bin/bash",
			'STATE="${CREATE_PR_FAKE_STATE:?}"',
			'mkdir -p "$STATE"',
			'log() { echo "$*" >> "$STATE/calls.log"; }',
			'cmd="$1"; shift',
			'case "$cmd" in',
			"  pr)",
			'    sub="$1"; shift',
			'    case "$sub" in',
			"      create)",
					'log "pr create";',
			'        n=$(cat "$STATE/next-pr" 2>/dev/null || echo 1)',
			'        echo $((n+1)) > "$STATE/next-pr"',
			'        echo "https://github.com/acme/widget/pull/$n"',
			'        exit 0;;',
			"      list)",
			'        log "pr list";',
			'        if [ -f "$STATE/pr-list.json" ]; then cat "$STATE/pr-list.json"; else echo "[]"; fi',
			'        exit 0;;',
			"      view)",
			'        log "pr view";',
			'        if [ -f "$STATE/checks.json" ]; then cat "$STATE/checks.json";',
			'          else echo \'{"url":"https://github.com/acme/widget/pull/1","number":1,"statusCheckRollup":[]}\'; fi',
			'        exit 0;;',
			"      *) echo \"unexpected pr sub: $sub\" >&2; exit 64;;",
			"    esac;;",
			"  run)",
			'    sub="$1"; shift',
			'    case "$sub" in',
			'      list) log "run list"; if [ -f "$STATE/runs.json" ]; then cat "$STATE/runs.json"; else echo "[]"; fi; exit 0;;',
			'      view) log "run view"; if [ -f "$STATE/fail-log.txt" ]; then cat "$STATE/fail-log.txt"; else echo "(no log)"; fi; exit 0;;',
			"      *) echo \"unexpected run sub: $sub\" >&2; exit 64;;",
			"    esac;;",
			'  *) echo "unexpected command: $cmd $*" >&2; exit 64;;',
			"esac",
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(script, 0o755);
	return script;
}

function writeState(stateDir, file, content) {
	return writeFile(join(stateDir, file), typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

async function readCalls(stateDir) {
	try {
		const { readFile } = await import("node:fs/promises");
		return (await readFile(join(stateDir, "calls.log"), "utf8")).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

// ------------------------------------------------------------------- stubs

let fakeGhPath = "";
let fakeStateDir = "";

function spawnStub(spec) {
	const child = spawn(spec.argv[0], spec.argv.slice(1), {
		cwd: spec.cwd,
		env: { ...GIT_ENV, CREATE_PR_FAKE_STATE: fakeStateDir },
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

function resolveExecutableStub(command) {
	if (command === "gh") return Promise.resolve(fakeGhPath);
	return Promise.resolve(command);
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

function llmStub(subject, body) {
	const text = [subject, "", body ?? ""].join("\n");
	return {
		stream: async function* () {
			yield { type: "text-delta", index: 0, text };
			yield { type: "finish", index: 0, reason: { kind: "stop" } };
		},
	};
}

function agentRecorder(sessionId) {
	const recorder = {
		sessionId,
		followups: [],
		followup(message) {
			recorder.followups.push(message);
		},
	};
	return recorder;
}

/** Build a launcher wired to the current fake gh + state dir. */
function makeLauncher(options = {}) {
	return createPrLauncher({
		spawn: (spec) => spawnStub(spec),
		resolveExecutable: resolveExecutableStub,
		pollIntervalMs: options.pollIntervalMs ?? 20,
		checksGracePolls: options.checksGracePolls ?? 2,
		maxFixRounds: options.maxFixRounds ?? 2,
		maxWatchMs: options.maxWatchMs ?? 60_000,
		llm: options.llm,
		modelSelection: options.llm ? () => ({ provider: "stub", model: "stub-model" }) : () => undefined,
		resolveAgent: (sessionId) =>
			options.agent && sessionId === options.agent.sessionId ? options.agent : undefined,
		warn: (message) => options.warnings?.push(message),
	});
}

async function waitFor(launcher, runId, statuses, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const record = launcher.runRecord(runId);
		if (record && statuses.includes(record.status)) return record;
		if (Date.now() > deadline) {
			throw new Error(
				`timeout waiting for ${JSON.stringify(statuses)}; last=${record && record.status}`,
			);
		}
		await sleep(20);
	}
}

const ROLLUP_PENDING = {
	url: "https://github.com/acme/widget/pull/1",
	number: 1,
	statusCheckRollup: [
		{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: "" },
	],
};
const ROLLUP_SUCCESS = {
	url: "https://github.com/acme/widget/pull/1",
	number: 1,
	statusCheckRollup: [
		{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
		{ __typename: "StatusContext", context: "lint", state: "SUCCESS" },
	],
};
const ROLLUP_FAILURE = {
	url: "https://github.com/acme/widget/pull/1",
	number: 1,
	statusCheckRollup: [
		{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" },
	],
};

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

// Pure helpers first.
await test("pure helpers: slug parsing, rollup classification, message parsing", async () => {
	assert.deepEqual(parseGitHubOwnerRepo("https://github.com/acme/widget.git"), {
		owner: "acme",
		repo: "widget",
	});
	assert.deepEqual(parseGitHubOwnerRepo("git@github.com:acme/widget.git"), {
		owner: "acme",
		repo: "widget",
	});
	assert.equal(parseGitHubOwnerRepo("https://gitlab.com/acme/widget.git"), undefined);

	assert.equal(classifyChecks([]).outcome, "empty");
	assert.equal(
		classifyChecks([{ status: "IN_PROGRESS", conclusion: "" }, { state: "SUCCESS" }]).outcome,
		"pending",
	);
	const failed = classifyChecks([
		{ name: "ok", status: "COMPLETED", conclusion: "SUCCESS" },
		{ name: "bad", status: "COMPLETED", conclusion: "TIMED_OUT" },
	]);
	assert.equal(failed.outcome, "failed");
	assert.equal(failed.checks[1].name, "bad");
	assert.equal(classifyChecks([{ state: "SUCCESS" }, { state: "EXPECTED" }]).outcome, "pending");

	const good = parseConventionalMessage("```\nfeat(core): add thing\n\n- one\n- two\n```");
	assert.ok(good, "fenced conventional subject must parse");
	assert.equal(good.subject, "feat(core): add thing");
	assert.match(good.body, /- one/);
	assert.equal(parseConventionalMessage("looks like prose"), undefined);

	assert.match(deterministicFallbackMessage({ mode: "commit", statText: "a.md | 2 ++\nb.md | 3 ++" }).subject, /^docs:/);
	assert.match(deterministicFallbackMessage({ mode: "commit", statText: "src/x.ts | 4 ++" }).subject, /^(chore|feat):/);
	assert.match(deterministicFallbackMessage({ mode: "pr", statText: "s1---s2---" }).subject, /land 2 commits/);

	const url = extractPrUrl("some noise\nhttps://github.com/acme/widget/pull/42\nnoise");
	assert.equal(url.number, 42);
});

await test("answers unknown endpoints with 404 and rejects foreign hosts with 403", async () => {
	fakeStateDir = await makeStateDir();
	fakeGhPath = installFakeGh(await mkdtemp(join(tmpdir(), "cpr-bin-")));
	const launcher = makeLauncher();
	const missing = await call(launcher, { method: "GET", url: "/create-pr/api/nope" });
	assert.equal(missing.status, 404);
	const evil = await call(launcher, {
		method: "GET",
		url: "/create-pr/api/runs",
		host: "evil.example:3080",
	});
	assert.equal(evil.status, 403);
	launcher.shutdown();
});

await test("refuses to resolve a repository without any input", async () => {
	const launcher = makeLauncher();
	const refused = await call(launcher, {
		method: "POST",
		url: "/create-pr/api/create",
		body: {},
	});
	assert.equal(refused.status, 400);
	assert.ok(refused.payload.error.includes("cannot resolve"));
	launcher.shutdown();
});

// Happy path: dirty tree -> LLM commit -> push -> pr create -> CI passes.
{
	const project = await makeProject();
	const agent = agentRecorder("session-happy");
	const warnings = [];
	const launcher = makeLauncher({
		llm: llmStub("feat(widget): add sparkle engine", "- adds sparkle"),
		agent,
		warnings,
	});

	await test("happy path: commit, push, PR, CI pass — with one LLM call only", async () => {
		fakeStateDir = await makeStateDir();
		await writeState(fakeStateDir, "checks.json", ROLLUP_PENDING);

		await writeFile(join(project.root, "sparkle.ts"), "export const sparkle = 1;\n", "utf8");
		const created = await call(launcher, {
			method: "POST",
			url: "/create-pr/api/create",
			body: { sessionId: agent.sessionId, root: project.root },
		});
		assert.equal(created.status, 202);
		assert.ok(
			!["passed", "failed", "expired", "cancelled", "error"].includes(created.payload.status),
			"202 must return the freshly started, still-running record",
		);

		const record = await waitFor(launcher, created.payload.id, ["waiting-ci"]);
		assert.equal(record.prNumber, 1, "first run creates PR #1");
		assert.equal(record.prUrl, "https://github.com/acme/widget/pull/1");
		assert.equal(record.commitSubject, "feat(widget): add sparkle engine");
		assert.match(record.commitSubject, CONVENTIONAL_SUBJECT_RE);

		// The LLM-generated commit really landed with that exact subject.
		const logSubject = git(["log", "-1", "--format=%s"], project.root).trim();
		assert.equal(logSubject, "feat(widget): add sparkle engine");
		// ...and was pushed to the bare origin on the feature branch.
		const remoteSha = git(["ls-remote", project.origin, project.branch], project.dir).trim();
		const localSha = git(["rev-parse", "HEAD"], project.root).trim();
		assert.ok(remoteSha.startsWith(localSha), "branch pushed to origin");

		// Deterministic plumbing only — exactly one pr create, no second PR.
		const calls = await readCalls(fakeStateDir);
		assert.equal(
			calls.filter((line) => line.startsWith("pr create")).length,
			1,
			"gh pr create called exactly once",
		);

		// CI turns green -> watchdog flips the run to passed.
		await writeState(fakeStateDir, "checks.json", ROLLUP_SUCCESS);
		const doneRecord = await waitFor(launcher, record.id, ["passed"]);
		assert.equal(doneRecord.prNumber, 1);
		assert.equal(doneRecord.fixRounds, 0);
		assert.equal(agent.followups.length, 0, "no wake needed when CI passes");
		assert.equal(warnings.length, 0);
	});

	await test("GET /runs lists the finished run; GET /runs/<id> agrees", async () => {
		const listed = await call(launcher, { method: "GET", url: "/create-pr/api/runs" });
		assert.equal(listed.status, 200);
		assert.ok(listed.payload.runs.length >= 1);
	});
	launcher.shutdown();
	await rm(project.dir, { recursive: true, force: true }).catch(() => {});
}

// CI failure flow: watchdog collects logs and wakes the owning session.
{
	const project = await makeProject();
	const agent = agentRecorder("session-fix");
	const warnings = [];
	const launcher = makeLauncher({
		llm: llmStub("fix(widget): correct rendering path", "- fixes it"),
		agent,
		warnings,
	});

	await test("CI failure wakes the owning session, then confirms after the fix", async () => {
		fakeStateDir = await makeStateDir();
		await writeState(fakeStateDir, "checks.json", ROLLUP_FAILURE);
		await writeState(fakeStateDir, "runs.json", [
			{ databaseId: 501, conclusion: "failure", status: "COMPLETED" },
		]);
		await writeState(
			fakeStateDir,
			"fail-log.txt",
			"##[error]Process completed with exit code 1.\nError: boom at src/render.ts:42",
		);

		await writeFile(join(project.root, "render.ts"), "export const render = () => 1;\n", "utf8");
		const created = await call(launcher, {
			method: "POST",
			url: "/create-pr/api/create",
			body: { sessionId: agent.sessionId, root: project.root },
		});
		const record = await waitFor(launcher, created.payload.id, ["waiting-ci"]);

		// Watchdog sees the failure, fetches logs and wakes the session.
		const fixing = await waitFor(launcher, record.id, ["fixing"]);
		assert.equal(fixing.fixRounds, 1);
		assert.match(fixing.note ?? "", /fix round 1\/2/);
		assert.equal(agent.followups.length, 1);
		const message = agent.followups[0];
		assert.equal(message.role, "user");
		assert.equal(message.source.kind, "plugin");
		assert.equal(message.source.plugin, "@dsh-plugins/create-pr");
		const text = message.content[0].text;
		assert.match(text, /pull\/1/);
		assert.match(text, /render\.ts:42/, "the failed-step log tail rides along");
		assert.match(text, new RegExp(project.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(text, /fix:/);
		assert.match(text, new RegExp(project.root.slice(0, 20)));

		// The woken session pushes a fix; CI goes green; watchdog confirms.
		await writeState(fakeStateDir, "checks.json", ROLLUP_SUCCESS);
		const passedRecord = await waitFor(launcher, record.id, ["passed"]);
		assert.equal(passedRecord.fixRounds, 1, "exactly one fix round consumed");
	});

	launcher.shutdown();
	await rm(project.dir, { recursive: true, force: true }).catch(() => {});
}

// Auto-fix budget exhaustion.
{
	const project = await makeProject();
	const agent = agentRecorder("session-tired");
	const launcher = makeLauncher({
		llm: llmStub("feat(widget): another try", ""),
		agent,
		maxFixRounds: 1,
	});

	await test("auto-fix budget exhausted -> terminal failed", async () => {
		fakeStateDir = await makeStateDir();
		await writeState(fakeStateDir, "checks.json", ROLLUP_FAILURE);
		await writeState(fakeStateDir, "runs.json", [{ databaseId: 7, conclusion: "failure" }]);
		await writeState(fakeStateDir, "fail-log.txt", "still broken");

		const created = await call(launcher, {
			method: "POST",
			url: "/create-pr/api/create",
			body: { sessionId: agent.sessionId, root: project.root },
		});
		const fixing = await waitFor(launcher, created.payload.id, ["fixing"]);
		assert.equal(fixing.fixRounds, 1);
		// Still failing at the next poll: budget spent.
		const failed = await waitFor(launcher, created.payload.id, ["failed"]);
		assert.match(failed.note ?? "", /budget/);
		assert.equal(agent.followups.length, 1);
	});

	launcher.shutdown();
	await rm(project.dir, { recursive: true, force: true }).catch(() => {});
}

// Existing PR adoption: never calls pr create again.
{
	const project = await makeProject();
	const launcher = makeLauncher({ llm: llmStub("chore(widget): sync", "") });

	await test("adopts an existing PR for the branch instead of failing", async () => {
		fakeStateDir = await makeStateDir();
		const adoptedRollup = {
			url: "https://github.com/acme/widget/pull/9",
			number: 9,
			statusCheckRollup: ROLLUP_SUCCESS.statusCheckRollup,
		};
		await writeState(fakeStateDir, "checks.json", adoptedRollup);
		// A PR already exists for this branch.
		await writeState(fakeStateDir, "pr-list.json", [
			{ number: 9, url: "https://github.com/acme/widget/pull/9", state: "OPEN" },
		]);

		const created = await call(launcher, {
			method: "POST",
			url: "/create-pr/api/create",
			body: { sessionId: "session-adopt", root: project.root },
		});
		const record = await waitFor(launcher, created.payload.id, ["passed"]);
		assert.equal(record.prNumber, 9);
		assert.equal(record.prUrl, "https://github.com/acme/widget/pull/9");
		const calls = await readCalls(fakeStateDir);
		assert.ok(
			!calls.some((line) => line.startsWith("pr create")),
			"must not create a second PR",
		);
	});

	launcher.shutdown();
	await rm(project.dir, { recursive: true, force: true }).catch(() => {});
}

// Validation guards.
{
	const launcher = makeLauncher({ llm: llmStub("feat(x): y", "") });

	await test("guards: base branch refusal and non-GitHub remote", async () => {
		const mainProject = await makeProject({ branch: "main" });
		const refused = await call(launcher, {
			method: "POST",
			url: "/create-pr/api/create",
			body: { root: mainProject.root },
		});
		assert.equal(refused.status, 400);
		assert.match(refused.payload.error, /base branch/);
		await rm(mainProject.dir, { recursive: true, force: true }).catch(() => {});

		const gitlabProject = await makeProject();
		git(["remote", "set-url", "origin", "https://gitlab.com/acme/widget.git"], gitlabProject.root);
		const rejected = await call(launcher, {
			method: "POST",
			url: "/create-pr/api/create",
			body: { root: gitlabProject.root },
		});
		assert.equal(rejected.status, 400);
		assert.match(rejected.payload.error, /not a GitHub remote/);
		await rm(gitlabProject.dir, { recursive: true, force: true }).catch(() => {});
	});

	await test("deterministic fallback message when the llm service answers off-format", async () => {
		fakeStateDir = await makeStateDir();
		await writeState(fakeStateDir, "checks.json", ROLLUP_SUCCESS);
		const fallbackLauncher = makeLauncher({
			llm: llmStub("I think this change looks nice!", ""), // not conventional -> fallback
		});
		const project = await makeProject();
		await writeFile(join(project.root, "notes.md"), "# notes\n", "utf8");
		const created = await call(fallbackLauncher, {
			method: "POST",
			url: "/create-pr/api/create",
			body: { sessionId: "session-fallback", root: project.root },
		});
		const record = await waitFor(fallbackLauncher, created.payload.id, ["passed"]);
		assert.match(record.commitSubject, /^docs: update 1 file/);
		assert.match(record.commitSubject, CONVENTIONAL_SUBJECT_RE);
		const logSubject = git(["log", "-1", "--format=%s"], project.root).trim();
		assert.equal(logSubject, record.commitSubject);
		fallbackLauncher.shutdown();
		await rm(project.dir, { recursive: true, force: true }).catch(() => {});
	});

	launcher.shutdown();
}

// Cancel + shutdown semantics.
{
	const project = await makeProject();
	const launcher = makeLauncher({ llm: llmStub("feat(x): pending forever", "") });

	await test("cancel stops the watchdog; shutdown stops every watcher", async () => {
		fakeStateDir = await makeStateDir();
		await writeState(fakeStateDir, "checks.json", ROLLUP_PENDING);
		const created = await call(launcher, {
			method: "POST",
			url: "/create-pr/api/create",
			body: { sessionId: "session-cancel", root: project.root },
		});
		await waitFor(launcher, created.payload.id, ["waiting-ci"]);

		const cancelled = await call(launcher, {
			method: "POST",
			url: `/create-pr/api/runs/${created.payload.id}/cancel`,
		});
		assert.equal(cancelled.status, 200);
		assert.equal(cancelled.payload.status, "cancelled");

		// Even a green rollup afterwards must NOT resurrect the cancelled run.
		await writeState(fakeStateDir, "checks.json", ROLLUP_SUCCESS);
		await sleep(120);
		assert.equal(launcher.runRecord(created.payload.id).status, "cancelled");

		const unknownCancel = await call(launcher, {
			method: "POST",
			url: "/create-pr/api/runs/nope/cancel",
		});
		assert.equal(unknownCancel.status, 404);
	});

	await test("shutdown clears watchers (no further polls)", async () => {
		fakeStateDir = await makeStateDir();
		await writeState(fakeStateDir, "checks.json", ROLLUP_PENDING);
		const created = await call(launcher, {
			method: "POST",
			url: "/create-pr/api/create",
			body: { sessionId: "session-shutdown", root: project.root },
		});
		await waitFor(launcher, created.payload.id, ["waiting-ci"]);
		const before = (await readCalls(fakeStateDir)).length;
		launcher.shutdown();
		// Tolerate one in-flight poll crossing the shutdown boundary, then the
		// call stream must go silent for good (two samples, >2 poll periods apart).
		await sleep(150);
		const settledA = (await readCalls(fakeStateDir)).length;
		await sleep(250);
		const settledB = (await readCalls(fakeStateDir)).length;
		assert.ok(settledA - before <= 1, `at most one boundary poll (${settledA - before})`);
		assert.equal(settledB, settledA, "no gh invocations after shutdown");
	});

	await rm(project.dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} tests passed`);
