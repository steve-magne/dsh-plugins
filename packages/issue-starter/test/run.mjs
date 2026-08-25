/**
 * Standalone functional test for the @dsh-plugins/issue-starter host half.
 * Runs without cordis: drives `createIssueStarter` against a scripted fake
 * subprocess service (git + gh command table) and a fake `agents` service,
 * through mock req/res objects.
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIssueStarter, parseIssueReference, buildIssuePrompt } from "../lib/index.js";

// The controller stats the requested cwd against the REAL filesystem before
// trusting git; tests hand it a genuine temp directory and let the scripted
// subprocess answer everything else.
const realWorkdir = await mkdtemp(join(tmpdir(), "issue-starter-test-"));

// ---------------------------------------------------------------- helpers

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
	return { status: fake.status, body: JSON.parse(fake.body ?? "{}") };
}

/** Fake collect-mode subprocess: answers from a command table. */
function makeScriptedSubprocess(table) {
	const executed = [];
	function spawn(spec) {
		executed.push({ argv: [...spec.argv], cwd: spec.cwd });
		const answer = table(spec.argv);
		const text = typeof answer === "string" ? answer : answer?.out ?? "";
		const code = typeof answer === "string" ? 0 : answer?.code ?? 0;
		const errText = typeof answer === "string" ? "" : answer?.err ?? "";
		return {
			pid: 4321,
			done: Promise.resolve({ exitCode: code, signal: null }),
			collected: {
				stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
				stderr: {
					readFrom: () => ({ text: errText, nextOffset: errText.length, lossy: false }),
				},
			},
		};
	}
	return { spawn, executed };
}

function resolveStub(command) {
	if (command === "git") return "/usr/bin/git";
	if (command === "gh") return "/opt/homebrew/bin/gh";
	return command;
}

function buildTable(options = {}) {
	return (argv) => {
		const joined = argv.join(" ");
		if (joined.includes("rev-parse --show-toplevel")) {
			return options.repoBroken
				? { code: 1, err: "fatal: not a git repository" }
				: "/repo/top\n";
		}
		if (joined.includes("rev-parse --verify --quiet refs/heads/main")) return "aaa1111111111111111111111111111111111111\n";
		if (joined.includes("rev-parse --verify --quiet refs/heads/master")) return { code: 1 };
		if (joined.includes("config --get remote.origin.url"))
			return options.noOrigin ? { code: 1 } : "https://github.com/acme/widget.git\n";
		if (joined.includes("fetch origin main")) {
			if (options.fetchFails) return { code: 128, err: "network unreachable" };
			return "";
		}
		if (joined.includes("refs/remotes/origin/main"))
			return "bbb2222222222222222222222222222222222222\n";
		if (joined.includes("worktree add -b")) return options.worktreeFails ? { code: 1, err: "branch exists" } : "";
		if (joined.includes("--git-common-dir")) return "/repo/top/.git\n";
		if (argv[0] === "/opt/homebrew/bin/gh" && argv[1] === "issue") {
			const number = Number.parseInt(argv[3], 10);
			if (options.ghFails || number === 777) {
				return { code: 1, err: "GraphQL: Could not resolve to an Issue" };
			}
			return JSON.stringify({
				number,
				title: `Fix the flux capacitor (#${number})`,
				body: "The capacitor over-fluxes when the DeLorean hits 88 mph.\nSteps to reproduce…",
				url: `https://github.com/acme/widget/issues/${number}`,
				labels: ["bug", { name: "priority:high" }],
			});
		}
		return { code: 1, err: `unexpected command in test table: ${joined}` };
	};
}

function makeFakeAgents() {
	const created = [];
	const messages = [];
	return {
		created,
		messages,
		create: async (options) => {
			created.push(options);
			const handle = {
				followup: (message) => messages.push(message),
				whenIdle: async () => {},
				session: { seq: 0 },
			};
			return { agent: handle, dispose: async () => {} };
		},
	};
}

// ---------------------------------------------------------------- units

console.log("units — reference parsing and prompt framing");
{
	assert.deepEqual(parseIssueReference("42"), { number: 42 });
	assert.deepEqual(parseIssueReference(" https://github.com/acme/widget/issues/99/ "), {
		number: 99,
	});
	assert.ok(parseIssueReference("").error);
	assert.ok(parseIssueReference("abc").error);
	assert.ok(parseIssueReference("/pulls/12").error);

	const prompt = buildIssuePrompt(
		{
			number: 7,
			title: "Add telemetry",
			body: "Track launches.",
			url: "https://github.com/acme/widget/issues/7",
			labels: ["feat", { name: "infra" }],
		},
		"/wt/path",
	);
	assert.match(prompt, /issue #7: “Add telemetry”/);
	assert.match(prompt, /Labels: feat, infra\./);
	assert.match(prompt, /Track launches\./);
	assert.match(prompt, /\/wt\/path/);
	assert.match(prompt, /Do NOT push/);
	const longBody = "x".repeat(50_000);
	assert.ok(
		buildIssuePrompt({ number: 1, title: "t", body: longBody, labels: [] }, "/p")
			.length < longBody.length,
		"prompt bodies are truncated",
	);
	console.log("  - parsing, framing, truncation: OK");
}

// ---------------------------------------------------------------- suite A

console.log("suite A — happy path (preview → launch → nudge)");
{
	const subprocess = makeScriptedSubprocess(buildTable());
	const agentsService = makeFakeAgents();
	const controller = createIssueStarter({
		spawn: subprocess.spawn,
		resolveExecutable: resolveStub,
		agents: agentsService,
		defaultCwd: realWorkdir,
		now: () => new Date(2026, 5, 14, 9, 30, 0),
	});

	const forbidden = await call(controller, {
		method: "POST",
		url: "/issue-starter/api/issues/preview",
		host: "evil.example:3080",
	});
	assert.equal(forbidden.status, 403);

	const badRef = await call(controller, {
		method: "POST",
		url: "/issue-starter/api/issues/preview",
		body: { issue: "not-a-ref" },
	});
	assert.equal(badRef.status, 400);

	const preview = await call(controller, {
		method: "POST",
		url: "/issue-starter/api/issues/preview",
		body: { issue: "https://github.com/acme/widget/issues/42" },
	});
	assert.equal(preview.status, 200);
	assert.equal(preview.body.issue.number, 42);
	assert.match(preview.body.issue.title, /flux capacitor/);
	assert.deepEqual(preview.body.issue.labels, ["bug", { name: "priority:high" }]);
	assert.ok(
		subprocess.executed.some((call) => call.argv.slice(0, 3).join(" ") === "/opt/homebrew/bin/gh issue view"),
		"preview goes through gh issue view",
	);

	const started = await call(controller, {
		method: "POST",
		url: "/issue-starter/api/issues/start",
		body: { issue: 42, model: { provider: "deepseek", model: "deepseek-chat" } },
	});
	assert.equal(started.status, 201);
	assert.match(started.body.branch, /^issue-42-\d{8}-\d{6}$/);
	assert.equal(started.body.worktreePath, `/repo/top/.dsh/worktrees/${started.body.branch}`);
	assert.ok(started.body.sessionId.startsWith("session-"));

	const worktreeCall = subprocess.executed.find((call) =>
		call.argv.includes("worktree"),
	);
	assert.deepEqual(
		worktreeCall.argv,
		[
			"/usr/bin/git",
			"worktree",
			"add",
			"-b",
			started.body.branch,
			started.body.worktreePath,
			"bbb2222222222222222222222222222222222222",
		],
		"worktree is cut from the fetched remote tip",
	);

	assert.equal(agentsService.created.length, 1);
	assert.equal(agentsService.created[0].sessionId, started.body.sessionId);
	assert.equal(agentsService.created[0].meta.cwd, started.body.worktreePath);
	assert.deepEqual(agentsService.created[0].agentOptions, {
		provider: "deepseek",
		model: "deepseek-chat",
	});

	assert.equal(agentsService.messages.length, 1);
	assert.equal(agentsService.messages[0].role, "user");
	assert.match(agentsService.messages[0].content[0].text, /issue #42/);
	assert.equal(agentsService.messages[0].source.plugin, "@dsh-plugins/issue-starter");

	const listed = await call(controller, {
		method: "GET",
		url: "/issue-starter/api/runs",
	});
	assert.equal(listed.body.runs.length, 1);
	assert.equal(listed.body.launchable, true);

	const nudged = await call(controller, {
		method: "POST",
		url: `/issue-starter/api/runs/${started.body.sessionId}/nudge`,
		body: { message: "Focus on the tests first." },
	});
	assert.equal(nudged.status, 200);
	assert.equal(agentsService.messages.length, 2);
	assert.equal(agentsService.messages[1].content[0].text, "Focus on the tests first.");

	const badNudge = await call(controller, {
		method: "POST",
		url: `/issue-starter/api/runs/${started.body.sessionId}/nudge`,
		body: { message: "  " },
	});
	assert.equal(badNudge.status, 400);

	const discarded = await call(controller, {
		method: "DELETE",
		url: `/issue-starter/api/runs/${started.body.sessionId}`,
	});
	assert.equal(discarded.status, 200);
	const afterDiscard = await call(controller, {
		method: "GET",
		url: "/issue-starter/api/runs",
	});
	assert.equal(afterDiscard.body.runs.length, 0);
	console.log("  - preview, worktree plumbing, launch, nudge, registry: OK");
}

// ---------------------------------------------------------------- suite B

console.log("suite B — degradation paths");
{
	const missingAgents = createIssueStarter({
		spawn: makeScriptedSubprocess(buildTable()).spawn,
		resolveExecutable: resolveStub,
		defaultCwd: realWorkdir,
	});
	const refusedLaunch = await call(missingAgents, {
		method: "POST",
		url: "/issue-starter/api/issues/start",
		body: { issue: 42 },
	});
	assert.equal(refusedLaunch.status, 501);
	const stillListable = await call(missingAgents, {
		method: "GET",
		url: "/issue-starter/api/runs",
	});
	assert.equal(stillListable.body.launchable, false);

	const brokenRepo = createIssueStarter({
		spawn: makeScriptedSubprocess(buildTable({ repoBroken: true })).spawn,
		resolveExecutable: resolveStub,
		agents: makeFakeAgents(),
		defaultCwd: realWorkdir,
	});
	const notARepo = await call(brokenRepo, {
		method: "POST",
		url: "/issue-starter/api/issues/preview",
		body: { issue: 42 },
	});
	assert.equal(notARepo.status, 400);
	assert.match(notARepo.body.error, /not a git repository/);

	const ghFailure = createIssueStarter({
		spawn: makeScriptedSubprocess(buildTable()).spawn,
		resolveExecutable: resolveStub,
		agents: makeFakeAgents(),
		defaultCwd: realWorkdir,
	});
	const badIssue = await call(ghFailure, {
		method: "POST",
		url: "/issue-starter/api/issues/start",
		body: { issue: 777 },
	});
	assert.equal(badIssue.status, 502);
	assert.match(badIssue.body.error, /gh issue view failed/);

	const fetchDegrades = createIssueStarter({
		spawn: makeScriptedSubprocess(buildTable({ fetchFails: true })).spawn,
		resolveExecutable: resolveStub,
		agents: makeFakeAgents(),
		defaultCwd: realWorkdir,
		now: () => new Date(2026, 0, 2, 3, 4, 5),
	});
	const offline = await call(fetchDegrades, {
		method: "POST",
		url: "/issue-starter/api/issues/start",
		body: { issue: 42 },
	});
	assert.equal(offline.status, 201, "offline fetch degrades instead of failing");
	assert.match(offline.body.baseNote, /fetch failed/);

	const worktreeBoom = createIssueStarter({
		spawn: makeScriptedSubprocess(buildTable({ worktreeFails: true })).spawn,
		resolveExecutable: resolveStub,
		agents: makeFakeAgents(),
		defaultCwd: realWorkdir,
	});
	const boom = await call(worktreeBoom, {
		method: "POST",
		url: "/issue-starter/api/issues/start",
		body: { issue: 42 },
	});
	assert.equal(boom.status, 500);
	assert.match(boom.body.error, /git worktree add failed/);

	const noRoute = await call(createIssueStarter({
		spawn: makeScriptedSubprocess(buildTable()).spawn,
		resolveExecutable: resolveStub,
		defaultCwd: realWorkdir,
	}), { method: "GET", url: "/issue-starter/api/nope" });
	assert.equal(noRoute.status, 404);
	console.log("  - 501 without agents, broken repo, gh failure, degraded fetch: OK");
}

console.log("host-half functional tests OK");
