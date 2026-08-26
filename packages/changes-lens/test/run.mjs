/**
 * Standalone functional test for the @dsh-plugins/changes-lens host half.
 * Runs without cordis: drives `createChangesLens` against a stubbed subprocess
 * service implemented over node:child_process, through mock req/res objects,
 * exercising REAL temporary git repositories (local bare origin for
 * ahead/behind state) plus the pure porcelain/numstat parsers.
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyEntry,
	createChangesLens,
	parseNumstat,
	parsePorcelainStatus,
} from "../lib/index.js";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "cl-test",
	GIT_AUTHOR_EMAIL: "cl@test.local",
	GIT_COMMITTER_NAME: "cl-test",
	GIT_COMMITTER_EMAIL: "cl@test.local",
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

const resolveExecutableStub = (command) => Promise.resolve(command);

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
	console.log("— pure parsers —");

	assert.deepEqual(classifyEntry("?", "?"), {
		glyph: "?",
		label: "untracked",
		staged: false,
		unstaged: false,
		untracked: true,
	});
	assert.deepEqual(classifyEntry("M", " ").staged, true);
	assert.deepEqual(classifyEntry(" ", "M").staged, false);
	assert.equal(classifyEntry("M", "M").label, "staged + edited (modified)");
	assert.equal(classifyEntry("A", " ").label, "staged (added)");
	assert.equal(classifyEntry("A", "D").label, "staged + edited (added)");

	const statusText = [
		"## main...origin/main [ahead 1]",
		" M src/app.js",
		"M  src/staged.js",
		"A  src/new.js",
		"?? notes.txt",
		'R  old.js -> "renamed file.js"',
	].join("\n");
	const entries = parsePorcelainStatus(statusText);
	assert.deepEqual(
		entries.map((entry) => entry.path),
		["src/app.js", "src/staged.js", "src/new.js", "notes.txt", "renamed file.js"],
	);
	// The rename destination wins and its core.quotePath quoting is decoded.
	assert.equal(entries[4].x, "R");

	const numstats = parseNumstat(
		"12\t3\tsrc/app.js\n-\t-\tlogo.png\n5\t0\t\"quoted\\303\\251.txt\"",
	);
	assert.deepEqual(numstats.get("src/app.js"), { adds: 12, dels: 3, binary: false });
	assert.deepEqual(numstats.get("logo.png").binary, true);
	console.log("  classifyEntry / parsePorcelainStatus / parseNumstat OK");
}

// ------------------------------------------------------------ handler suites

async function makeProject() {
	const dir = await mkdtemp(join(tmpdir(), "cl-fixture-"));
	const origin = join(dir, "origin.git");
	try {
		git(["init", "--quiet", "--bare", "--initial-branch=main", origin], dir);
	} catch {
		git(["init", "--quiet", "--bare", origin], dir);
		git(["symbolic-ref", "HEAD", "refs/heads/main"], origin);
	}
	const root = join(dir, "project");
	git(["clone", "--quiet", origin, root], dir);
	git(["config", "user.email", "cl@test.local"], root);
	git(["config", "user.name", "cl-test"], root);
	await writeFile(join(root, "app.js"), "const a = 1;\nconsole.log(a);\n", "utf8");
	git(["add", "."], root);
	git(["commit", "-q", "-m", "seed"], root);
	git(["push", "-q", "-u", "origin", "main"], root);
	return { dir, root };
}

async function suiteLens() {
	console.log("— open/status/diff/snapshot pipeline —");
	const project = await makeProject();

	// Pending work: unstaged edit, staged addition, untracked file, staged edit.
	await writeFile(join(project.root, "app.js"), "const a = 2;\nconsole.log(a);\n", "utf8");
	await writeFile(join(project.root, "feature.js"), "export const b = 3;\n", "utf8");
	await writeFile(join(project.root, "notes.txt"), "scratch\n", "utf8");
	git(["add", "feature.js", "app.js"], project.root);
	await writeFile(join(project.root, "app.js"), "const a = 42;\nconsole.log(a);\n", "utf8");
	// Local-only commit -> ahead 1 of origin/main. The pathspec keeps the
	// previously staged entries (app.js, feature.js) OUT of this commit.
	await writeFile(join(project.root, "committed.txt"), "later\n", "utf8");
	git(["add", "committed.txt"], project.root);
	git(["commit", "-q", "-m", "local only", "--", "committed.txt"], project.root);

	const controller = createChangesLens({
		spawn: (spec) => spawnStub(spec),
		resolveExecutable: resolveExecutableStub,
		defaultRoot: project.root,
	});

	// Host allowlist blunts DNS rebinding.
	assert.equal(
		(await call(controller, { url: "/changes-lens/api/status?root=/x", host: "evil.example:3080" })).status,
		403,
	);

	// Defaults expose the configured root before anything is opened.
	{
		const answer = await call(controller, { url: "/changes-lens/api/defaults" });
		assert.equal(answer.payload.defaultRoot, project.root);
	}

	// Open resolves to the toplevel and reports ahead/behind against upstream.
	{
		const answer = await call(controller, {
			method: "POST",
			url: "/changes-lens/api/open",
			body: { cwd: join(project.root, "subdir-that-does-not-exist") },
		});
		assert.equal(answer.status, 400, "non-directories must be refused");
	}
	{
		const answer = await call(controller, {
			method: "POST",
			url: "/changes-lens/api/open",
			body: { cwd: project.root },
		});
		assert.equal(answer.status, 200);
		assert.equal(answer.payload.branch, "main");
		assert.equal(answer.payload.upstream, "origin/main");
		assert.equal(answer.payload.ahead, 1);
		assert.equal(answer.payload.behind, 0);
	}

	// Status inventory: classification + exact numstat merge.
	{
		const answer = await call(controller, {
			url: `/changes-lens/api/status?root=${encodeURIComponent(project.root)}`,
		});
		assert.equal(answer.status, 200);
		const byPath = new Map(answer.payload.entries.map((entry) => [entry.path, entry]));
		assert.ok(byPath.has("app.js"));
		const app = byPath.get("app.js");
		assert.equal(app.staged, true);
		assert.equal(app.unstaged, true);
		assert.ok(app.adds >= 2, `expected staged+unstaged additions, got ${app.adds}`);
		const feature = byPath.get("feature.js");
		assert.equal(feature.glyph, "A");
		assert.deepEqual([feature.adds, feature.dels], [1, 0]);
		const notes = byPath.get("notes.txt");
		assert.equal(notes.untracked, true);
		assert.equal(notes.adds, null);
		assert.equal(answer.payload.counts.total, answer.payload.entries.length);
		assert.ok(answer.payload.counts.staged >= 2);
	}

	// Diff per file, capped payloads, staged vs worktree views.
	{
		const full = await call(controller, {
			url: `/changes-lens/api/diff?root=${encodeURIComponent(project.root)}&path=${encodeURIComponent("app.js")}`,
		});
		assert.equal(full.status, 200);
		assert.match(full.payload.text, /-const a = 2;/);
		assert.match(full.payload.text, /\+const a = 42;/);
		assert.equal(full.payload.truncated, false);

		const staged = await call(controller, {
			url: `/changes-lens/api/diff?root=${encodeURIComponent(project.root)}&cached=1`,
		});
		assert.match(staged.payload.text, /feature\.js/);
		assert.doesNotMatch(staged.payload.text, /notes\.txt/, "untracked files have no staged diff");

		const tiny = createChangesLens({
			spawn: (spec) => spawnStub(spec),
			resolveExecutable: resolveExecutableStub,
			defaultRoot: project.root,
			maxDiffBytes: 48,
		});
		const capped = await call(tiny, {
			url: `/changes-lens/api/diff?root=${encodeURIComponent(project.root)}&path=${encodeURIComponent("app.js")}`,
		});
		assert.equal(capped.payload.truncated, true);
		assert.ok(capped.payload.text.length <= 48);
	}

	// Recovery snapshot pins the uncommitted tracked work without touching it.
	const appBefore = git(["show", ":app.js"], project.root);
	{
		const answer = await call(controller, {
			method: "POST",
			url: "/changes-lens/api/snapshot",
			body: { root: project.root },
		});
		assert.equal(answer.status, 201);
		assert.equal(answer.payload.created, true);
		assert.match(answer.payload.ref, /^refs\/dsh-changes-lens\/\d{8}-\d{6}-[0-9a-f]{10}$/);
		const listed = await call(controller, {
			url: `/changes-lens/api/snapshots/list?root=${encodeURIComponent(project.root)}`,
			method: "POST",
		});
		assert.equal(listed.payload.snapshots.length, 1);
		assert.equal(listed.payload.snapshots[0].ref, answer.payload.ref);
		// Working tree untouched: index still holds the staged version.
		assert.equal(git(["show", ":app.js"], project.root), appBefore);
	}

	// A clean tree snapshots nothing.
	{
		const cleanDir = await mkdtemp(join(tmpdir(), "cl-clean-"));
		git(["init", "-q"], cleanDir);
		git(["config", "user.email", "cl@test.local"], cleanDir);
		git(["config", "user.name", "cl-test"], cleanDir);
		const controllerClean = createChangesLens({
			spawn: (spec) => spawnStub(spec),
			resolveExecutable: resolveExecutableStub,
		});
		const empty = await call(controllerClean, {
			method: "POST",
			url: "/changes-lens/api/snapshot",
			body: { root: cleanDir },
		});
		assert.equal(empty.payload.created, false);
		await rm(cleanDir, { recursive: true, force: true });
	}

	// Validation: non-repo roots are refused; unknown endpoints 404.
	{
		const outside = await mkdtemp(join(tmpdir(), "cl-norepo-"));
		const answer = await call(controller, {
			url: `/changes-lens/api/status?root=${encodeURIComponent(outside)}`,
		});
		assert.equal(answer.status, 400);
		await rm(outside, { recursive: true, force: true });
		assert.equal((await call(controller, { url: "/changes-lens/api/nope" })).status, 404);
	}

	await rm(project.dir, { recursive: true, force: true });
	console.log("  open/status/diff/snapshot OK");
}

await suiteLens();
console.log("changes-lens host half OK");
