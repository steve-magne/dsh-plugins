/**
 * Standalone functional test for the @dsh-plugins/mission-control host half.
 * Runs without cordis: drives `createMissionControl` against a stubbed
 * subprocess service implemented over node:child_process, through mock
 * req/res objects, with a FAKE `gh` executable whose behavior is scripted by
 * state files, and REAL temporary git repositories (local bare origin) for
 * the hand-off pipeline (worktree cut -> agents launch -> nudge).
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildHandoffPrompt,
	byRecency,
	createMissionControl,
	deriveSlug,
	normalizeSearchItem,
	slugLabelOf,
} from "../lib/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- git fixture

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "mc-test",
	GIT_AUTHOR_EMAIL: "mc@test.local",
	GIT_COMMITTER_NAME: "mc-test",
	GIT_COMMITTER_EMAIL: "mc@test.local",
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

/** A scratch project cloned from a local bare origin with a GitHub-shaped URL. */
async function makeProject() {
	const dir = await mkdtemp(join(tmpdir(), "mc-fixture-"));
	const origin = join(dir, "origin.git");
	try {
		git(["init", "--quiet", "--bare", "--initial-branch=main", origin], dir);
	} catch {
		git(["init", "--quiet", "--bare", origin], dir);
		git(["symbolic-ref", "HEAD", "refs/heads/main"], origin);
	}
	const root = join(dir, "project");
	git(["clone", "--quiet", origin, root], dir);
	git(["remote", "set-url", "origin", "https://github.com/acme/widget.git"], root);
	git(["config", `url.${origin}.insteadOf`, "https://github.com/acme/widget.git"], root);
	git(["config", "user.email", "mc@test.local"], root);
	git(["config", "user.name", "mc-test"], root);
	await writeFile(join(root, "README.md"), "# fixture\n", "utf8");
	git(["add", "."], root);
	git(["commit", "-q", "-m", "seed"], root);
	git(["push", "-q", "-u", "origin", "main"], root);
	return { dir, root, origin };
}

// -------------------------------------------------------------- fake gh fixture

/**
 * A deterministic gh stand-in driven by files inside $MC_FAKE_STATE:
 *   reviews.json / authored.json / issues.json — `gh search …` answers
 *   issue-view.json / pr-view.json — `gh issue view` / `gh pr view` answers
 *   search-fails — when present, every `search` exits non-zero
 * Every invocation is appended to calls.log for assertions.
 */
function installFakeGh(dir) {
	const script = join(dir, "fake-gh");
	writeFileSync(
		script,
		[
			"#!/bin/bash",
			'STATE="${MC_FAKE_STATE:?}"',
			'mkdir -p "$STATE"',
			'log() { echo "$*" >> "$STATE/calls.log"; }',
			'cmd="$1"; shift',
			"case \"$cmd\" in",
			"  search)",
			'    log "search $1";',
			'    if [ -f "$STATE/search-fails" ]; then echo "search exploded" >&2; exit 1; fi',
			"    case \"$1\" in",
			'      prs) if [[ "$*" == *"--review-requested"* ]]; then cat "$STATE/reviews.json"; else cat "$STATE/authored.json"; fi; exit 0;;',
			'      issues) cat "$STATE/issues.json"; exit 0;;',
			"    esac;;",
			"  issue)",
			'    sub="$1"; shift',
			"    case \"$sub\" in",
			'      view) log "issue view"; if [ -f "$STATE/issue-view.json" ]; then cat "$STATE/issue-view.json"; else echo "{}"; fi; exit 0;;',
			"    esac;;",
			"  pr)",
			'    sub="$1"; shift',
			"    case \"$sub\" in",
			'      view) log "pr view"; if [ -f "$STATE/pr-view.json" ]; then cat "$STATE/pr-view.json"; else echo "{}"; fi; exit 0;;',
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
		env: { ...GIT_ENV, MC_FAKE_STATE: fakeStateDir },
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

/** A scripted `agents` service capturing created sessions and followups. */
function makeAgentsStub() {
	const created = [];
	const followups = [];
	return {
		created,
		followups,
		launchable: true,
		async create(options) {
			assert.equal(typeof options.sessionId, "string");
			created.push(options);
			const agent = {
				followup(message) {
					followups.push({ sessionId: options.sessionId, message });
				},
			};
			return { agent };
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

	assert.deepEqual(deriveSlug("https://github.com/acme/widget/pull/12"), {
		owner: "acme",
		repo: "widget",
	});
	assert.deepEqual(deriveSlug("https://github.com/acme/widget/issues/7#x"), {
		owner: "acme",
		repo: "widget",
	});
	assert.equal(deriveSlug("https://gitlab.com/a/b/issues/1"), undefined);
	assert.equal(slugLabelOf("https://github.com/acme/widget/pull/12"), "acme/widget");
	assert.equal(slugLabelOf("https://example.com/x"), null);

	const item = normalizeSearchItem(
		{
			number: 5,
			title: "Fix the flux capacitor",
			url: "https://github.com/acme/widget/pull/5",
			updatedAt: "2026-05-14T10:00:00Z",
			isDraft: true,
			checkStatus: "SUCCESS",
			reviewDecision: "CHANGES_REQUESTED",
		},
		"pr",
	);
	assert.equal(item.kind, "pr");
	assert.equal(item.repo, "acme/widget");
	assert.equal(item.isDraft, true);
	assert.equal(item.checkStatus, "SUCCESS");
	assert.equal(normalizeSearchItem({ url: "nope" }, "pr"), undefined);

	assert.deepEqual(
		[
			{ updatedAt: "2026-01-01T00:00:00Z" },
			{ updatedAt: "2026-06-01T00:00:00Z" },
			{ updatedAt: null },
		].sort(byRecency)[0],
		{ updatedAt: "2026-06-01T00:00:00Z" },
	);

	const prompt = buildHandoffPrompt(
		{
			kind: "issue",
			number: 9,
			title: "Crash on empty input",
			url: "https://github.com/acme/widget/issues/9",
			body: "Steps to reproduce…",
		},
		"/repo/.dsh/worktrees/mc-9-x",
	);
	assert.match(prompt, /GitHub issue #9/);
	assert.match(prompt, /Crash on empty input/);
	assert.match(prompt, /\/repo\/\.dsh\/worktrees\/mc-9-x/);
	assert.match(prompt, /Do NOT push/);
	const prPrompt = buildHandoffPrompt(
		{ kind: "pr", number: 3, title: "Add retry", headRefName: "feat/retry" },
		"/wt",
	);
	assert.match(prPrompt, /pull request #3/);
	assert.match(prPrompt, /branch `feat\/retry`/);
	console.log("  deriveSlug / normalizeSearchItem / byRecency / buildHandoffPrompt OK");
}

// ------------------------------------------------------------ handler suites

async function suiteInboxAndHandoff() {
	console.log("— inbox reads + hand-off pipeline —");
	const project = await makeProject();
	fakeStateDir = await mkdtemp(join(tmpdir(), "mc-state-"));
	fakeGhPath = installFakeGh(fakeStateDir);

	await writeState(fakeStateDir, "reviews.json", [
		{
			number: 21,
			title: "Review me please",
			url: "https://github.com/octo/tools/pull/21",
			updatedAt: "2026-05-20T08:00:00Z",
			isDraft: false,
			checkStatus: "FAILURE",
			reviewDecision: "REVIEW_REQUIRED",
		},
	]);
	await writeState(fakeStateDir, "authored.json", [
		{
			number: 30,
			title: "My open feature",
			url: "https://github.com/acme/widget/pull/30",
			updatedAt: "2026-05-21T08:00:00Z",
			isDraft: true,
			checkStatus: "PENDING",
			reviewDecision: null,
		},
	]);
	await writeState(fakeStateDir, "issues.json", [
		{
			number: 9,
			title: "Assigned bug",
			url: "https://github.com/acme/widget/issues/9",
			updatedAt: "2026-05-19T08:00:00Z",
			labels: [{ name: "bug" }],
		},
	]);
	await writeState(fakeStateDir, "issue-view.json", {
		number: 9,
		title: "Assigned bug",
		body: "It crashes when the widget is empty.",
		url: "https://github.com/acme/widget/issues/9",
		state: "OPEN",
	});

	const agents = makeAgentsStub();
	const controller = createMissionControl({
		spawn: (spec) => spawnStub(spec),
		resolveExecutable: resolveExecutableStub,
		agents,
		defaultCwd: project.root,
		now: () => new Date(2026, 4, 22, 10, 30, 0),
	});

	// Host allowlist blunts DNS rebinding.
	{
		const answer = await call(controller, { url: "/mission-control/api/inbox", host: "evil.example:3080" });
		assert.equal(answer.status, 403);
	}

	// Aggregated inbox: three sections in order, normalized items.
	{
		const answer = await call(controller, { url: "/mission-control/api/inbox" });
		assert.equal(answer.status, 200);
		assert.equal(answer.payload.sections.length, 3);
		const [reviews, authored, assigned] = answer.payload.sections;
		assert.equal(reviews.error, null);
		assert.equal(reviews.items[0].number, 21);
		assert.equal(reviews.items[0].checkStatus, "FAILURE");
		assert.equal(authored.items[0].isDraft, true);
		assert.deepEqual(assigned.items[0].labels, ["bug"]);
		assert.equal(answer.payload.launchable, true);
	}

	// Fail-soft sections: one exploding read leaves an error note, others pass.
	await writeFile(join(fakeStateDir, "search-fails"), "1", "utf8");
	{
		const answer = await call(controller, { url: "/mission-control/api/inbox" });
		assert.equal(answer.status, 200);
		for (const section of answer.payload.sections) {
			assert.match(section.error, /search exploded|failed/);
			assert.deepEqual(section.items, []);
		}
	}
	await rm(join(fakeStateDir, "search-fails"), { force: true });

	// Hand-off: cuts the worktree, frames the prompt from the issue detail,
	// launches exactly one session through the agents service.
	{
		const answer = await call(controller, {
			method: "POST",
			url: "/mission-control/api/handoff",
			body: { item: { kind: "issue", url: "https://github.com/acme/widget/issues/9" }, cwd: project.root },
		});
		assert.equal(answer.status, 201);
		assert.equal(answer.payload.item.number, 9);
		assert.match(answer.payload.branch, /^mc-9-\d{8}-\d{6}$/);
		const worktreePath = answer.payload.worktreePath;
		assert.ok(existsSync(worktreePath), "worktree directory must exist");
		assert.equal(agents.created.length, 1);
		assert.equal(agents.followups.length, 1);
		const text = agents.followups[0].message.content[0].text;
		assert.match(text, /GitHub issue #9/);
		assert.match(text, /crashes when the widget is empty/);
		assert.match(text, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		// The worktree sits under .dsh/worktrees and is ignored via info/exclude.
		const exclude = await readFile(
			join(project.root, ".git", "info", "exclude"),
			"utf8",
		).catch(() => "");
		if (!existsSync(join(project.origin, "info"))) {
			/* bare repos have no info/exclude requirement — main checkout only */
		}
		assert.ok(exclude.includes(".dsh/worktrees/") || exclude === "");

		// Registry + nudge + discard round-trip.
		const listed = await call(controller, { url: "/mission-control/api/runs" });
		assert.equal(listed.status, 200);
		assert.equal(listed.payload.runs.length, 1);
		const runId = listed.payload.runs[0].id;
		const nudged = await call(controller, {
			method: "POST",
			url: `/mission-control/api/runs/${runId}/nudge`,
			body: { message: "focus on the parser first" },
		});
		assert.equal(nudged.status, 200);
		assert.equal(agents.followups.length, 2);
		assert.equal(agents.followups[1].message.content[0].text, "focus on the parser first");
		const removed = await call(controller, {
			method: "DELETE",
			url: `/mission-control/api/runs/${runId}`,
		});
		assert.equal(removed.status, 200);
		assert.equal((await call(controller, { url: "/mission-control/api/runs" })).payload.runs.length, 0);
	}

	// PR hand-off refuses closed pull requests.
	await writeState(fakeStateDir, "pr-view.json", {
		number: 30,
		title: "Already merged",
		state: "MERGED",
		headRefName: "feat/x",
	});
	{
		const answer = await call(controller, {
			method: "POST",
			url: "/mission-control/api/handoff",
			body: { item: { kind: "pr", url: "https://github.com/acme/widget/pull/30" }, cwd: project.root },
		});
		assert.equal(answer.status, 409);
	}

	// Validation errors surface as 400s.
	{
		const bad = await call(controller, {
			method: "POST",
			url: "/mission-control/api/handoff",
			body: { item: { kind: "gist", url: "https://github.com/acme/widget/pull/1" } },
		});
		assert.equal(bad.status, 400);
		const badUrl = await call(controller, {
			method: "POST",
			url: "/mission-control/api/handoff",
			body: { item: { kind: "issue", url: "https://gitlab.com/a/b/issues/2" } },
		});
		assert.equal(badUrl.status, 400);
	}

	// Unknown endpoints answer 404.
	{
		const answer = await call(controller, { url: "/mission-control/api/nope" });
		assert.equal(answer.status, 404);
	}

	await rm(project.dir, { recursive: true, force: true });
	await sleep(50);
}

async function suiteWithoutAgents() {
	console.log("— degraded composition without the 'agents' service —");
	fakeStateDir = await mkdtemp(join(tmpdir(), "mc-state2-"));
	fakeGhPath = installFakeGh(fakeStateDir);
	await writeState(fakeStateDir, "reviews.json", []);
	await writeState(fakeStateDir, "authored.json", []);
	await writeState(fakeStateDir, "issues.json", []);

	const controller = createMissionControl({
		spawn: (spec) => spawnStub(spec),
		resolveExecutable: resolveExecutableStub,
		agents: undefined,
	});
	const inbox = await call(controller, { url: "/mission-control/api/inbox" });
	assert.equal(inbox.status, 200);
	assert.equal(inbox.payload.launchable, false);
	const handoff = await call(controller, {
		method: "POST",
		url: "/mission-control/api/handoff",
		body: { item: { kind: "issue", url: "https://github.com/a/b/issues/1" } },
	});
	assert.equal(handoff.status, 501);
	await rm(fakeStateDir, { recursive: true, force: true });
}

await suiteInboxAndHandoff();
await suiteWithoutAgents();
console.log("mission-control host half OK");
