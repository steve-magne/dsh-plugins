/**
 * Standalone functional test for the @dsh-plugins/command-deck host half.
 * Runs without cordis: drives `createCommandDeck` against a stubbed subprocess
 * service implemented over node:child_process, through mock req/res objects.
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCommandDeck } from "../lib/index.js";

// ---------------------------------------------------------------- stubs

/** Minimal SubprocessRuntime stand-in over node:child_process. */
function makeStubSubprocess() {
	return {
		async resolveExecutable(command) {
			if (command.includes("/")) {
				accessSync(command);
				return command;
			}
			if (command === "bash") return "/bin/bash";
			throw new Error(`cannot resolve ${command}`);
		},
		spawn(spec) {
			const child = spawn(spec.argv[0], spec.argv.slice(1), {
				cwd: spec.cwd,
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
			let outcome;
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
					outcome = { exitCode: code, signal };
					doneResolve(outcome);
				}
			});
			let terminated = false;
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
					if (terminated || settled) return;
					terminated = true;
					try {
						if (process.platform === "win32") {
							spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
						} else if (child.pid) {
							process.kill(-child.pid, "SIGTERM");
						}
					} catch {
						child.kill("SIGTERM");
					}
					setTimeout(() => {
						try {
							if (child.pid && !child.killed)
								process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}, 1_500).unref();
				},
				async waitForExit(signal) {
					await Promise.race([
						done,
						new Promise((_, reject) => {
							signal?.addEventListener(
								"abort",
								() => reject(new Error("timeout")),
								{ once: true },
							);
						}),
					]).catch(() => {});
					return true;
				},
			};
		},
	};
}

function accessSync() {
	/* accept everything in tests */
}

function makeReq({
	method = "GET",
	url = "/",
	body = undefined,
	host = "127.0.0.1:3080",
}) {
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

async function call(deck, options) {
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
	await deck.handle(req, fake);
	assert.notEqual(fake.status, null, "handler must answer every request");
	return { status: fake.status, payload: JSON.parse(fake.body) };
}

const sleep = (ms) =>
	new Promise((resolveResult) => setTimeout(resolveResult, ms));

// ---------------------------------------------------------------- tests

const deck = createCommandDeck({
	spawn: (spec) => makeStubSubprocess().spawn(spec),
	resolveExecutable: (command) =>
		makeStubSubprocess().resolveExecutable(command),
	defaultCwd: process.cwd(),
});

let passed = 0;
async function test(name, fn) {
	await fn();
	passed += 1;
	console.log(`PASS ${name}`);
}

await test("registers under /command-deck/api and answers unknown endpoints with 404", async () => {
	const result = await call(deck, {
		method: "GET",
		url: "/command-deck/api/nope",
	});
	assert.equal(result.status, 404);
	assert.ok(result.payload.error.includes("no such command-deck endpoint"));
});

await test("rejects non-local Host headers with 403", async () => {
	const result = await call(deck, {
		method: "GET",
		url: "/command-deck/api/runs",
		host: "evil.example:3080",
	});
	assert.equal(result.status, 403);
});

await test("runs echo and streams stdout deltas with offsets", async () => {
	const created = await call(deck, {
		method: "POST",
		url: "/command-deck/api/runs",
		body: { command: "echo hello-deck" },
	});
	assert.equal(created.status, 201);
	assert.equal(created.payload.status, "running");
	const id = created.payload.id;

	let output;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		output = await call(deck, {
			method: "GET",
			url: `/command-deck/api/runs/${id}/output?out=0&err=0`,
		});
		if (output.payload.status === "exited") break;
		await sleep(100);
	}
	assert.equal(output.payload.status, "exited");
	assert.equal(output.payload.exit.exitCode, 0);
	assert.ok(
		output.payload.out.text.includes("hello-deck"),
		`stdout missing marker: ${JSON.stringify(output.payload.out)}`,
	);

	// Incremental read from the returned offset yields no duplicates.
	const delta = await call(deck, {
		method: "GET",
		url: `/command-deck/api/runs/${id}/output?out=${output.payload.out.nextOffset}&err=0`,
	});
	assert.equal(delta.payload.out.text, "");
});

await test("stops a long-running command via tree termination", async () => {
	const created = await call(deck, {
		method: "POST",
		url: "/command-deck/api/runs",
		body: { command: "sleep 30" },
	});
	assert.equal(created.status, 201);
	const id = created.payload.id;
	const stopped = await call(deck, {
		method: "POST",
		url: `/command-deck/api/runs/${id}/stop`,
	});
	assert.equal(stopped.status, 200);

	let output;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		output = await call(deck, {
			method: "GET",
			url: `/command-deck/api/runs/${id}/output?out=0&err=0`,
		});
		if (
			output.payload.status !== "running" &&
			output.payload.status !== "stopping"
		)
			break;
		await sleep(100);
	}
	assert.equal(output.payload.status, "exited");
	assert.equal(output.payload.exit.signal, "SIGTERM");
});

await test("captures stderr separately", async () => {
	const created = await call(deck, {
		method: "POST",
		url: "/command-deck/api/runs",
		body: { command: "echo boom >&2" },
	});
	const id = created.payload.id;
	let output;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		output = await call(deck, {
			method: "GET",
			url: `/command-deck/api/runs/${id}/output?out=0&err=0`,
		});
		if (output.payload.status === "exited") break;
		await sleep(100);
	}
	assert.ok(
		output.payload.err.text.includes("boom"),
		`stderr missing marker: ${JSON.stringify(output.payload.err)}`,
	);
});

await test("validates input and unknown ids", async () => {
	const empty = await call(deck, {
		method: "POST",
		url: "/command-deck/api/runs",
		body: { command: "" },
	});
	assert.equal(empty.status, 400);
	const badCwd = await call(deck, {
		method: "POST",
		url: "/command-deck/api/runs",
		body: { command: "echo x", cwd: "/definitely/not/a/dir" },
	});
	assert.equal(badCwd.status, 400);
	const unknownStop = await call(deck, {
		method: "POST",
		url: "/command-deck/api/runs/nope-123/stop",
	});
	assert.equal(unknownStop.status, 404);
	// Absent body -> {} -> missing 'command' -> 400.
	const noBody = await call(deck, {
		method: "POST",
		url: "/command-deck/api/runs",
		body: undefined,
	});
	assert.equal(noBody.status, 400);
});

await test("discards a settled run and lists the registry newest-first", async () => {
	const created = await call(deck, {
		method: "POST",
		url: "/command-deck/api/runs",
		body: { command: "echo discard-me", label: "discard me" },
	});
	const id = created.payload.id;
	await sleep(300);
	const discarded = await call(deck, {
		method: "DELETE",
		url: `/command-deck/api/runs/${id}`,
	});
	assert.equal(discarded.status, 200);
	const listed = await call(deck, {
		method: "GET",
		url: "/command-deck/api/runs",
	});
	const ids = listed.payload.runs.map((run) => run.id);
	assert.ok(!ids.includes(id), "discarded run must leave the registry");
	const startedAtList = listed.payload.runs.map((run) => run.startedAt);
	const sorted = [...startedAtList].sort((a, b) => b - a);
	assert.deepEqual(startedAtList, sorted, "registry must list newest-first");
});

await test("shutdown terminates still-running trees", async () => {
	const created = await call(deck, {
		method: "POST",
		url: "/command-deck/api/runs",
		body: { command: "sleep 60" },
	});
	assert.equal(created.payload.status, "running");
	await deck.shutdown();
	const listed = await call(deck, {
		method: "GET",
		url: "/command-deck/api/runs",
	});
	assert.equal(listed.payload.runs.length, 0);
});

console.log(`\n${passed} tests passed`);
