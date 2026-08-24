/**
 * Unit tests for @dsh-plugins/scheduled-tasks pure halves: the cron engine,
 * the task-store validation/persistence, and the runner's pure helpers.
 *
 *   node test/unit.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeCron, nextCronRun, nextRunAfter, nextRunsAfter, parseCron } from "../lib/cron.js";
import { createTaskStore, normalizeModel, validateTaskFields } from "../lib/store.js";
import { normalizeSkillRef, parseSkillDocument } from "../lib/skills.js";
import {
	buildScheduledPrompt,
	extractPrUrl,
	parseGitHubOwnerRepo,
	scheduledCommitSubject,
	summarizeInterval,
} from "../lib/runner.js";

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

// ------------------------------------------------------------------- cron

await test("parseCron accepts every documented form", () => {
	assert.deepEqual(parseCron("*/15 * * * *").minutes, [0, 15, 30, 45]);
	assert.deepEqual(parseCron("0 9 * * 1-5").hours, [9]);
	const named = parseCron("0 22 * jan,dec mon");
	assert.deepEqual(named.months, [1, 12]);
	assert.deepEqual(named.daysOfWeek, [1]);
	assert.equal(parseCron("* * * * *").daysOfMonth, null);
	const both = parseCron("0 0 1 * 0");
	assert.ok(both.daysOfMonth && both.daysOfWeek, "restricted dom+dow kept apart");
});

await test("parseCron rejects malformed expressions precisely", () => {
	for (const bad of ["", "* 4 *", "61 * * * *", "* 24 * * *", "* * 0 * *", "a * * * *", "*/0 * * * *"]) {
		assert.throws(() => parseCron(bad), `must reject '${bad}'`);
	}
});

await test("nextRunAfter computes strictly-after occurrences", () => {
	const base = new Date(2026, 0, 5, 10, 30, 15).getTime(); // Monday Jan 5 2026, 10:30:15
	assert.equal(
		new Date(nextRunAfter("*/15 * * * *", base)).getMinutes(),
		45,
		"steps align forward",
	);
	const daily = new Date(nextRunAfter("0 9 * * *", base));
	assert.equal(daily.getDate(), 6, "09:00 already passed today -> tomorrow");
	const weekly = new Date(nextRunAfter("30 8 * * 1", base));
	assert.equal(weekly.getDate(), 12, "this Monday's 08:30 passed -> next Monday");
	const alias = new Date(nextRunAfter("@daily", base));
	assert.equal(`${alias.getHours()}:${alias.getMinutes()}`, "0:0");
	const feb29 = new Date(nextRunAfter("0 0 29 2 *", base));
	assert.equal(feb29.getFullYear(), 2028, "leap-year-only schedule lands on Feb 29");
});

await test("vixie day-pair semantics: dom OR dow when both restricted", () => {
	const base = new Date(2026, 0, 5, 10, 30, 0).getTime(); // Monday
	// 5th of month OR any Sunday, at noon: today IS the 5th and 12:00 is ahead.
	assert.equal(new Date(nextRunAfter("0 12 5 * 0", base)).getDate(), 5);
	// After the 5th, next hit is Sunday Jan 11.
	const after = new Date(2026, 0, 5, 13, 0, 0).getTime();
	assert.equal(new Date(nextRunAfter("0 12 5 * 0", after)).getDate(), 11);
});

await test("nextRunsAfter previews a sequence of distinct instants", () => {
	const base = new Date(2026, 5, 1, 0, 0, 0).getTime();
	const runs = nextRunsAfter("0 */6 * * *", base, 3);
	assert.equal(runs.length, 3);
	assert.ok(runs[0] < runs[1] && runs[1] < runs[2], "strictly increasing");
});

await test("describeCron humanizes common shapes and falls back", () => {
	assert.match(describeCron("0 9 * * 1-5"), /lundi.*vendredi|à 09:00/);
	assert.match(describeCron("*/30 * * * *"), /30 minutes/);
	assert.equal(describeCron("not even close to cron"), "not even close to cron");
	void nextCronRun; // exercised above through nextRunAfter
});

// ------------------------------------------------------------------ store

await test("normalizeModel accepts object, slashed string, or bare id + default provider", () => {
	assert.deepEqual(normalizeModel({ provider: "deepseek", model: "chat" }), {
		provider: "deepseek",
		model: "chat",
	});
	assert.deepEqual(normalizeModel("deepseek/chat-latest"), { provider: "deepseek", model: "chat-latest" });
	assert.deepEqual(normalizeModel("chat", "deepseek"), { provider: "deepseek", model: "chat" });
	assert.throws(() => normalizeModel(""), /model is required/);
	assert.throws(() => normalizeModel({ provider: "", model: "x" }), /are both required/);
	assert.throws(() => normalizeModel("bare"), /needs a provider/);
});

await test("validateTaskFields enforces workspace/cron/prompt contracts", () => {
	const good = validateTaskFields({
		workspace: "/tmp/repo",
		cron: "@hourly",
		prompt: "do things",
		model: "p/m",
	});
	assert.equal(good.workspace, "/tmp/repo");
	assert.equal(good.enabled, true, "enabled defaults true");
	assert.equal(good.skill, null, "skill is optional and defaults to null");
	assert.throws(() => validateTaskFields({ workspace: "relative/x", cron: "* * * * *", prompt: "x", model: "p/m" }), /absolute/);
	assert.throws(() => validateTaskFields({ workspace: "/r", cron: "nope", prompt: "x", model: "p/m" }), /cron/i);
	assert.throws(() => validateTaskFields({ workspace: "/r", cron: "* * * * *", prompt: "   ", model: "p/m" }), /prompt is required/);
});

await test("validateTaskFields accepts and normalizes an optional skill reference", () => {
	const base = { workspace: "/r", cron: "* * * * *", prompt: "x", model: "p/m" };
	assert.deepEqual(validateTaskFields({ ...base, skill: { source: "project", id: "code-review" } }).skill, {
		source: "project",
		id: "code-review",
	});
	assert.deepEqual(validateTaskFields({ ...base, skill: "profile:find-skills" }).skill, {
		source: "profile",
		id: "find-skills",
	});
	assert.deepEqual(validateTaskFields({ ...base, skill: null }).skill, null, "explicit null clears the skill");
	for (const bad of [
		{ source: "galaxy", id: "x" },
		{ source: "profile", id: "../escape" },
		{ source: "profile", id: "a/b" },
		{ source: "profile", id: "" },
		"profile:",
		":thing",
		"no-colon",
	]) {
		assert.throws(() => validateTaskFields({ ...base, skill: bad }), /skill/i, `must reject ${JSON.stringify(bad)}`);
	}
});

await test("store persists tasks+runs atomically across reloads and bounds the run tail", async () => {
	const dir = await mkdtemp(join(tmpdir(), "stq-store-"));
	const filePath = join(dir, "nested", "scheduled-tasks.json");
	let clock = 1_000;
	const store = createTaskStore({
		filePath,
		now: () => clock,
		maxRuns: 3,
		warn: () => {},
	});
	await store.load();
	const task = await store.addTask(
		{ workspace: "/tmp/repo", cron: "0 9 * * 1-5", prompt: "work", model: { provider: "deepseek", model: "chat" } },
		{},
	);
	assert.match(task.id, /^[0-9a-f-]{36}$/);
	await store.updateTask(task.id, { enabled: false });
	for (let index = 0; index < 5; index += 1) {
		clock += 10;
		await store.recordRun({ id: `run-${index}`, taskId: task.id, status: "done", startedAt: clock });
	}
	const reloaded = createTaskStore({ filePath, maxRuns: 3 });
	await reloaded.load();
	const tasks = reloaded.listTasks();
	assert.equal(tasks.length, 1);
	assert.equal(tasks[0].enabled, false, "update persisted");
	assert.equal(reloaded.listRuns().length, 3, "run tail bounded to maxRuns");
	assert.deepEqual(
		reloaded.listRuns().map((r) => r.id),
		["run-4", "run-3", "run-2"],
		"newest first",
	);
	assert.equal(tasks[0].lastStatus, "done", "lastStatus mirrors the newest run");

	// Corrupt store degrades to empty instead of crashing boot.
	await writeFile(filePath, "{not json", "utf8");
	const rescued = createTaskStore({ filePath, warn: () => {} });
	await rescued.load();
	assert.equal(rescued.listTasks().length, 0);
	await rm(dir, { recursive: true, force: true });
});

await test("store rejects duplicate-shaped updates on unknown ids", async () => {
	const dir = await mkdtemp(join(tmpdir(), "stq-store2-"));
	const store = createTaskStore({ filePath: join(dir, "s.json") });
	await store.load();
	await assert.rejects(() => store.updateTask("ghost", { enabled: true }), /unknown scheduled task/);
	await assert.rejects(() => store.removeTask("ghost"), /unknown scheduled task/);
	await rm(dir, { recursive: true, force: true });
});

// ------------------------------------------------------- runner pure bits

await test("summarizeInterval folds last non-empty assistant text and reason", () => {
	const events = [
		{ seq: 1, type: "turn/start" },
		{ seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "" }] } } },
		{ seq: 3, type: "assistant/message", data: { message: { content: [{ type: "text", text: "final words" }] } } },
		{ seq: 4, type: "turn/end", data: { reason: { kind: "completed" } } },
	];
	assert.deepEqual(summarizeInterval(events, 1), { text: "final words", reasonKind: "completed" });
	assert.deepEqual(summarizeInterval([], 0), { text: "", reasonKind: undefined });
});

await test("extractPrUrl and parseGitHubOwnerRepo handle gh/git remote shapes", () => {
	assert.deepEqual(extractPrUrl("Created! https://github.com/acme/w/pull/42"), {
		url: "https://github.com/acme/w/pull/42",
		number: 42,
	});
	assert.equal(extractPrUrl("nothing here"), undefined);
	assert.deepEqual(parseGitHubOwnerRepo("https://github.com/acme/widget.git"), { owner: "acme", repo: "widget" });
	assert.deepEqual(parseGitHubOwnerRepo("git@github.com:acme/widget.git"), { owner: "acme", repo: "widget" });
	assert.equal(parseGitHubOwnerRepo("https://gitlab.com/acme/widget.git"), undefined);
});

await test("scheduled prompts and subjects carry the deterministic contract", () => {
	const prompt = buildScheduledPrompt("Fix the flaky test", "/repo/.dsh/worktrees/sched-x");
	assert.match(prompt, /\[SCHEDULED TASK\]/);
	assert.match(prompt, /Work ONLY inside/);
	assert.ok(prompt.endsWith("Fix the flaky test"));
	assert.equal(
		scheduledCommitSubject("abcd1234", "20260105-103000"),
		"chore(sched-abcd1234): apply scheduled iteration 20260105-103000",
	);
});

await test("buildScheduledPrompt embeds an attached skill between rules and task", () => {
	const withSkill = buildScheduledPrompt("Do the thing", "/wt", {
		name: "code-review",
		body: "# Code Review\nCheck everything.\n",
	});
	const skillStart = withSkill.indexOf("[APPLIED SKILL: code-review]");
	const begin = withSkill.indexOf("----- BEGIN SKILL -----");
	const end = withSkill.indexOf("----- END SKILL -----");
	const taskAt = withSkill.indexOf("TASK:");
	assert.ok(skillStart > -1 && skillStart < begin && begin < end, "skill framing is ordered");
	assert.match(withSkill, /follow it while performing the TASK/);
	assert.ok(withSkill.includes("# Code Review\nCheck everything."), "body embedded verbatim");
	assert.ok(end < taskAt && withSkill.trimEnd().endsWith("Do the thing"), "task stays last");
	// No skill -> byte-identical to the legacy two-argument form.
	assert.equal(
		buildScheduledPrompt("p", "/wt", undefined),
		buildScheduledPrompt("p", "/wt"),
	);
	assert.doesNotMatch(buildScheduledPrompt("p", "/wt"), /APPLIED SKILL/);
});

await test("parseSkillDocument splits front matter and keeps a verbatim body", () => {
	const doc = parseSkillDocument(
		'---\nname: find-skills\ndescription: "Finds installable skills"\n---\n\n# Find Skills\nUse npx skills.',
	);
	assert.equal(doc.name, "find-skills");
	assert.equal(doc.description, "Finds installable skills");
	assert.equal(doc.body, "\n# Find Skills\nUse npx skills.");
	const bare = parseSkillDocument("# Just markdown\nno front matter");
	assert.equal(bare.name, undefined);
	assert.equal(bare.body, "# Just markdown\nno front matter");
});

await test("normalizeSkillRef validates sources and single-segment ids", () => {
	assert.deepEqual(normalizeSkillRef({ source: "profile", id: "x" }), { source: "profile", id: "x" });
	assert.deepEqual(normalizeSkillRef("project:y"), { source: "project", id: "y" });
	assert.equal(normalizeSkillRef(undefined), null);
	assert.equal(normalizeSkillRef(null), null);
	assert.equal(normalizeSkillRef(""), null);
	for (const bad of [{ source: "nope", id: "x" }, "../etc", "profile:a/b", "profile:", "profile:..", {}]) {
		assert.throws(() => normalizeSkillRef(bad), `must reject ${JSON.stringify(bad)}`);
	}
});

await test("store survives a crash mid-write thanks to atomic rename", async () => {
	const dir = await mkdtemp(join(tmpdir(), "stq-store3-"));
	const filePath = join(dir, "s.json");
	const store = createTaskStore({ filePath });
	await store.load();
	await store.addTask({ workspace: "/r", cron: "* * * * *", prompt: "p", model: "a/b" }, {});
	// A leftover tmp file must not confuse anything.
	await writeFile(`${filePath}.999.tmp`, "garbage", "utf8");
	const again = createTaskStore({ filePath });
	await again.load();
	assert.equal(again.listTasks().length, 1);
	const persisted = JSON.parse(await readFile(filePath, "utf8"));
	assert.equal(persisted.version, 1);
	await rm(dir, { recursive: true, force: true });
});

console.log(`\n${passed} unit tests passed`);
