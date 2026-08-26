/**
 * Standalone functional test for the @dsh-plugins/merge-pilot host half.
 * Runs without cordis: drives `createMergePilot` against a stubbed subprocess
 * service implemented over node:child_process, through mock req/res objects,
 * with a FAKE `gh` executable whose behavior is scripted by state files — so
 * the whole supervisor loop (poll -> classify -> wake -> merge) runs offline
 * and deterministically.
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyChecks,
	createMergePilot,
	decideNextStatus,
	mergeMethodFlag,
	normalizeCheck,
	parseGitHubOwnerRepo,
	parsePullRequestRef,
	summarizeChecks,
} from "../lib/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -------------------------------------------------------------- fake gh fixture

/**
 * A deterministic gh stand-in driven by files inside $MP_FAKE_STATE:
 *   view.json     — answer for `gh pr view … --json <standard fields>`
 *   reviews.json  — answer for `gh pr view … --json latestReviews`
 *   runs.json     — answer for `gh run list`
 *   fail-log.txt  — answer for `gh run view --log-failed`
 *   merge-fails   — when present, `gh pr merge` exits non-zero
 * Every invocation is appended to calls.log for assertions.
 */
function installFakeGh(dir) {
	const script = join(dir, "fake-gh");
	writeFileSync(
		script,
		[
			"#!/bin/bash",
			'STATE="${MP_FAKE_STATE:?}"',
			'mkdir -p "$STATE"',
			'log() { echo "$*" >> "$STATE/calls.log"; }',
			'cmd="$1"; shift',
			"case \"$cmd\" in",
			"  pr)",
			'    sub="$1"; shift',
			"    case \"$sub\" in",
			'      view) if [[ "$*" == *latestReviews* ]]; then log "pr view reviews"; cat "$STATE/reviews.json" 2>/dev/null || echo \'{"latestReviews":[]}\'; else log "pr view"; if [ -f "$STATE/view.json" ]; then cat "$STATE/view.json"; else echo "{}"; fi; fi; exit 0;;',
			'      merge) log "pr merge"; if [ -f "$STATE/merge-fails" ]; then echo "required status checks not met" >&2; exit 1; fi; exit 0;;',
			"    esac;;",
			"  run)",
			'    sub="$1"; shift',
			"    case \"$sub\" in",
			'      list) log "run list"; if [ -f "$STATE/runs.json" ]; then cat "$STATE/runs.json"; else echo "[]"; fi; exit 0;;',
			'      view) log "run view"; if [ -f "$STATE/fail-log.txt" ]; then cat "$STATE/fail-log.txt"; else echo "(no log)"; fi; exit 0;;',
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

async function writeState(stateDir, file, content) {
	await writeFile(
		join(stateDir, file),
		typeof content === "string" ? content : JSON.stringify(content),
		"utf8",
	);
}

// ------------------------------------------------------------------- stubs

let fakeGhPath = "";
let fakeStateDir = "";

function spawnStub(spec) {
	const child = spawn(spec.argv[0], spec.argv.slice(1), {
		cwd: spec.cwd,
		env: { ...process.env, MP_FAKE_STATE: fakeStateDir },
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

const resolveExecutableStub = (command) =>
	command === "gh" ? Promise.resolve(fakeGhPath) : Promise.resolve(command);

/** Scripted agents resolver capturing followup wakes per session id. */
function makeAgentResolver() {
	const wakes = [];
	return {
		wakes,
		resolve(sessionId) {
			return {
				followup(message) {
					wakes.push({ sessionId, message });
				},
			};
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

async function call(controller, options) {
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
	await controller.handle(req, fake);
	assert.notEqual(fake.status, null, "handler must answer every request");
	return { status: fake.status, payload: JSON.parse(fake.body) };
}

// ----------------------------------------------------------------- pure units

{
	console.log("— pure helpers —");

	assert.deepEqual(parsePullRequestRef("https://github.com/acme/widget/pull/12"), {
		number: 12,
		repoFlag: "acme/widget",
	});
	assert.deepEqual(parsePullRequestRef("octo/tools#7"), { number: 7, repoFlag: "octo/tools" });
	assert.deepEqual(parsePullRequestRef("#42"), { number: 42 });
	assert.deepEqual(parsePullRequestRef(" 12 "), { number: 12 });
	assert.ok(parsePullRequestRef("nonsense").error);
	assert.deepEqual(parseGitHubOwnerRepo("git@github.com:acme/widget.git"), {
		owner: "acme",
		repo: "widget",
	});

	assert.deepEqual(normalizeCheck({ name: "ci", conclusion: "SUCCESS" }), {
		name: "ci",
		conclusion: "SUCCESS",
	});
	assert.equal(
		normalizeCheck({ context: "lint", state: "failure" }).conclusion,
		"FAILURE",
	);
	assert.equal(normalizeCheck({ status: "IN_PROGRESS" }).conclusion, "PENDING");
	assert.deepEqual(classifyChecks([]), { outcome: "empty", checks: [] });
	assert.equal(classifyChecks([{ conclusion: "FAILURE" }]).outcome, "failed");
	assert.deepEqual(summarizeChecks([
		{ name: "a", conclusion: "SUCCESS" },
		{ name: "b", conclusion: "TIMED_OUT" },
		{ name: "c", conclusion: "QUEUED" },
	]), { passed: 1, failed: 1, pending: 1 });

	assert.equal(mergeMethodFlag("rebase").flag, "--rebase");
	assert.ok(mergeMethodFlag("fast-forward").error);

	assert.equal(
		decideNextStatus({
			state: "OPEN",
			isDraft: false,
			mergeable: true,
			reviewDecision: "APPROVED",
			checksOutcome: "passed",
		}),
		"ready",
	);
	assert.equal(
		decideNextStatus({
			state: "MERGED",
			isDraft: false,
			mergeable: null,
			reviewDecision: "APPROVED",
			checksOutcome: "passed",
		}),
		"merged",
	);
	assert.equal(
		decideNextStatus({
			state: "OPEN",
			isDraft: false,
			mergeable: true,
			reviewDecision: "CHANGES_REQUESTED",
			checksOutcome: "passed",
		}),
		"fix-review",
	);
	assert.equal(
		decideNextStatus({
			state: "OPEN",
			isDraft: true,
			mergeable: true,
			reviewDecision: "APPROVED",
			checksOutcome: "passed",
		}),
		"watching",
	);
	console.log("  parsePullRequestRef / classify / summarize / decide OK");
}

// ------------------------------------------------------------ handler suites

async function suiteLifecycle() {
	console.log("— supervisor lifecycle over scripted gh states —");
	fakeStateDir = await mkdtemp(join(tmpdir(), "mp-state-"));
	mkdirSync(fakeStateDir, { recursive: true });
	fakeGhPath = installFakeGh(fakeStateDir);

	// A scratch dir standing in for the pilot cwd (origin-derived slugs are not
	// needed here: every request carries an explicit o/r reference).
	const cwd = await mkdtemp(join(tmpdir(), "mp-cwd-"));

	const GREEN = {
		url: "https://github.com/acme/widget/pull/9",
		number: 9,
		title: "Add retry with backoff",
		state: "OPEN",
		isDraft: false,
		headRefName: "feat/retry",
		baseRefName: "main",
		reviewDecision: "APPROVED",
		statusCheckRollup: [
			{ name: "build", conclusion: "SUCCESS" },
			{ name: "unit", conclusion: "SUCCESS" },
		],
		mergeable: true,
	};
	const RED = {
		...GREEN,
		reviewDecision: "REVIEW_REQUIRED",
		mergeable: false,
		statusCheckRollup: [
			{ name: "build", conclusion: "SUCCESS" },
			{ name: "unit", conclusion: "FAILURE" },
		],
	};

	const controller = createMergePilot({
		spawn: (spec) => spawnStub(spec),
		resolveExecutable: resolveExecutableStub,
		defaultCwd: cwd,
		pollMs: 15,
		maxWatchMs: 30_000,
	});

	// Host allowlist blunts DNS rebinding.
	assert.equal(
		(await call(controller, { url: "/merge-pilot/api/pilots", host: "evil.example:3080" })).status,
		403,
	);

	// Validation: bogus references answer 400 before any gh call.
	{
		const bad = await call(controller, {
			method: "POST",
			url: "/merge-pilot/api/pilots",
			body: { pullRequest: "definitely not a ref" },
		});
		assert.equal(bad.status, 400);
	}

	// --- Scenario A: green + approved + mergeable + autoMerge -> merged.
	await writeState(fakeStateDir, "view.json", GREEN);
	{
		const created = await call(controller, {
			method: "POST",
			url: "/merge-pilot/api/pilots",
			body: { pullRequest: "acme/widget#9", mode: "squash", autoMerge: true },
		});
		assert.equal(created.status, 201, JSON.stringify(created.payload));
		const pilotId = created.payload.id;
		assert.equal(created.payload.status, "watching");
		assert.equal(created.payload.title, "Add retry with backoff");

		await sleep(400);
		const after = await call(controller, { url: `/merge-pilot/api/pilots/${pilotId}` });
		assert.equal(after.payload.status, "merged", JSON.stringify(after.payload));
		assert.match(after.payload.note, /gh pr merge/);
		const calls = (await readFileSafe(join(fakeStateDir, "calls.log"))).split("\n");
		assert.ok(calls.some((line) => line.startsWith("pr merge")), "gh pr merge must have run");
	}

	// --- Scenario B: CI fails -> session woken with logs -> green again -> ready.
	await writeState(fakeStateDir, "view.json", RED);
	await writeState(fakeStateDir, "runs.json", [
		{ databaseId: 77, conclusion: "failure" },
		{ databaseId: 70, conclusion: "success" },
	]);
	await writeState(fakeStateDir, "fail-log.txt", "##[error] 3 tests failed in retry.test.ts");
	const agents = makeAgentResolver();
	const controllerB = createMergePilot({
		spawn: (spec) => spawnStub(spec),
		resolveExecutable: resolveExecutableStub,
		defaultCwd: cwd,
		pollMs: 250,
		maxFixRounds: 2,
		maxWatchMs: 60_000,
		resolveAgent: (sessionId) => agents.resolve(sessionId),
		autoMerge: false,
	});
	let pilotId;
	{
		const created = await call(controllerB, {
			method: "POST",
			url: "/merge-pilot/api/pilots",
			body: { pullRequest: "#9", repo: "acme/widget", sessionId: "session-fix" },
		});
		assert.equal(created.status, 201);
		pilotId = created.payload.id;

		// One poll period (250 ms) has fired by now: exactly one CI-failure wake.
		await sleep(430);
		const mid = await call(controllerB, { url: `/merge-pilot/api/pilots/${pilotId}` });
		assert.equal(mid.payload.status, "fixing", JSON.stringify(mid.payload));
		assert.equal(mid.payload.fixRounds, 1);
		assert.equal(agents.wakes.length, 1);
		assert.equal(agents.wakes[0].sessionId, "session-fix");
		const text = agents.wakes[0].message.content[0].text;
		assert.match(text, /CI failed on PR #9/);
		assert.match(text, /retry\.test\.ts/, "wake must embed the failed-step log tail");
		assert.match(text, /feat\/retry/, "wake must name the branch to push to");

		// The session pushes a fix; CI turns green but review is still pending.
		await writeState(fakeStateDir, "view.json", {
			...GREEN,
			reviewDecision: "REVIEW_REQUIRED",
			mergeable: false,
		});
		await sleep(600);
		const waiting = await call(controllerB, { url: `/merge-pilot/api/pilots/${pilotId}` });
		assert.equal(waiting.payload.status, "watching");

		// Approval lands: ready-to-merge, no auto-merge configured.
		await writeState(fakeStateDir, "view.json", GREEN);
		await sleep(600);
		const ready = await call(controllerB, { url: `/merge-pilot/api/pilots/${pilotId}` });
		assert.equal(ready.payload.status, "ready", JSON.stringify(ready.payload));

		// Manual merge endpoint closes the loop.
		const merged = await call(controllerB, {
			method: "POST",
			url: `/merge-pilot/api/pilots/${pilotId}/merge`,
			body: {},
		});
		assert.equal(merged.payload.status, "merged");
	}

	// --- Scenario C: changes requested with NO session -> blocked, then expiry.
	await writeState(fakeStateDir, "view.json", {
		...GREEN,
		reviewDecision: "CHANGES_REQUESTED",
		mergeable: false,
		statusCheckRollup: [],
	});
	await writeState(fakeStateDir, "reviews.json", {
		latestReviews: [
			{ author: { login: "ada" }, state: "CHANGES_REQUESTED" },
			{ author: { login: "grace" }, state: "APPROVED" },
		],
	});
	const controllerC = createMergePilot({
		spawn: (spec) => spawnStub(spec),
		resolveExecutable: resolveExecutableStub,
		defaultCwd: cwd,
		pollMs: 15,
		maxWatchMs: 200,
	});
	{
		const created = await call(controllerC, {
			method: "POST",
			url: "/merge-pilot/api/pilots",
			body: { pullRequest: "https://github.com/acme/widget/pull/9" },
		});
		assert.equal(created.status, 201);
		const pilotIdC = created.payload.id;
		await sleep(120);
		const blocked = await call(controllerC, { url: `/merge-pilot/api/pilots/${pilotIdC}` });
		assert.equal(blocked.payload.status, "blocked", JSON.stringify(blocked.payload));
		assert.match(blocked.payload.note, /ada/);
		await sleep(400);
		const expired = await call(controllerC, { url: `/merge-pilot/api/pilots/${pilotIdC}` });
		assert.equal(expired.payload.status, "expired");
	}

	// --- Merge failure path surfaces gh's error as 409.
	await writeState(fakeStateDir, "view.json", GREEN);
	await writeState(fakeStateDir, "merge-fails", "1");
	const controllerD = createMergePilot({
		spawn: (spec) => spawnStub(spec),
		resolveExecutable: resolveExecutableStub,
		defaultCwd: cwd,
		pollMs: 3600_000, // effectively one initial seed poll only
	});
	{
		const created = await call(controllerD, {
			method: "POST",
			url: "/merge-pilot/api/pilots",
			body: { pullRequest: "#9", repo: "acme/widget" },
		});
		const pilotIdD = created.payload.id;
		const failed = await call(controllerD, {
			method: "POST",
			url: `/merge-pilot/api/pilots/${pilotIdD}/merge`,
			body: {},
		});
		assert.equal(failed.status, 409);
		assert.match(failed.payload.error, /required status checks/);
	}

	// --- Cancel + discard + unknown ids.
	{
		const created = await call(controllerD, {
			method: "POST",
			url: "/merge-pilot/api/pilots",
			body: { pullRequest: "#9", repo: "acme/widget" },
		});
		const id = created.payload.id;
		const cancelled = await call(controllerD, {
			method: "POST",
			url: `/merge-pilot/api/pilots/${id}/cancel`,
			body: {},
		});
		assert.equal(cancelled.payload.status, "cancelled");
		const discarded = await call(controllerD, {
			method: "DELETE",
			url: `/merge-pilot/api/pilots/${id}`,
		});
		assert.equal(discarded.payload.discarded, id);
		const missing = await call(controllerD, { url: `/merge-pilot/api/pilots/${id}` });
		assert.equal(missing.status, 404);
		assert.equal((await call(controllerD, { url: "/merge-pilot/api/nope" })).status, 404);
	}

	controller.shutdown();
	controllerB.shutdown();
	controllerC.shutdown();
	controllerD.shutdown();
	await rm(cwd, { recursive: true, force: true });
	await rm(fakeStateDir, { recursive: true, force: true });
	console.log("  auto-merge / CI wake / review block / manual merge OK");
}

async function readFileSafe(path) {
	try {
		const { readFile } = await import("node:fs/promises");
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

await suiteLifecycle();
console.log("merge-pilot host half OK");
