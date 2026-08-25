/**
 * Standalone functional test for the @dsh-plugins/agent-terminal host half.
 * Runs without cordis: drives `createAgentTerminal` against stubbed subprocess
 * services — a real-process pipe backend (node:child_process) and an in-memory
 * fake PTY provider — through mock req/res objects.
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTerminal } from "../lib/index.js";

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

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `predicate(value)` holds, polling `read()` with a deadline. */
async function waitFor(read, predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!predicate(value)) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
		await sleep(60);
		value = await read();
	}
	return value;
}

// ------------------------------------------------- pipe-backend subprocess

/** Minimal SubprocessRuntime stand-in over node:child_process (pipe stdin). */
function makePipeSubprocess() {
	return {
		async resolveExecutable(command) {
			if (command === "bash" || command === "/bin/bash") return "/bin/bash";
			if (command.includes("/")) return command;
			throw new Error(`cannot resolve ${command}`);
		},
		spawn(spec) {
			const wantsStdin = spec.stdio?.stdin === "pipe";
			const child = spawn(spec.argv[0], spec.argv.slice(1), {
				cwd: spec.cwd,
				stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe"],
				detached: true,
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
			let terminated = false;
			return {
				pid: child.pid ?? -1,
				stdin: child.stdin,
				stdout: child.stdout,
				stderr: child.stderr,
				done,
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
				},
				async waitForExit(signal) {
					await Promise.race([
						done,
						new Promise((_, reject) => {
							signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
						}),
					]).catch(() => {});
					return true;
				},
			};
		},
	};
}

// --------------------------------------------------- fake PTY provider

class FakePtyOutput {
	constructor() {
		this.listeners = [];
	}
	setEncoding() {}
	on(event, fn) {
		if (event === "data") this.listeners.push(fn);
	}
	push(text) {
		for (const fn of [...this.listeners]) fn(text);
	}
}

function makeFakeSpawnTerminal(tape) {
	return async function spawnTerminal(spec) {
		tape.specs.push(spec);
		const output = new FakePtyOutput();
		const handle = {
			pid: 4242,
			output,
			writes: [],
			signals: [],
			terminated: false,
			write(data) {
				handle.writes.push(data);
				output.push(`«${data}»`);
				return Promise.resolve();
			},
			async inspectForeground() {
				return { processGroupId: 4242, inputWaiting: false };
			},
			async signalForeground(signal) {
				handle.signals.push(signal);
				output.push(`[signal:${signal}]`);
				return 4242;
			},
			async terminate() {
				handle.terminated = true;
			},
			async waitForExit() {
				return handle.terminated;
			},
			done: null,
		};
		handle.done = new Promise((resolveDone) => {
			handle.settle = () => resolveDone({ exitCode: 0, signal: null });
		});
		tape.handles.push(handle);
		return handle;
	};
}

// ---------------------------------------------------------------- suite A

const workdir = await mkdtemp(join(tmpdir(), "agent-terminal-test-"));

console.log("suite A — pipe backend (real child processes)");
{
	const controller = createAgentTerminal({
		spawn: (spec) => makePipeSubprocess().spawn(spec),
		resolveExecutable: (c) => makePipeSubprocess().resolveExecutable(c),
		defaultCwd: workdir,
		maxTerminals: 2,
	});

	// Host allowlist blunts DNS rebinding.
	const forbidden = await call(controller, {
		method: "GET",
		url: "/agent-terminal/api/terminals",
		host: "evil.example:3080",
	});
	assert.equal(forbidden.status, 403);

	// Unknown routes answer 404.
	const missing = await call(controller, {
		method: "GET",
		url: "/agent-terminal/api/nope",
	});
	assert.equal(missing.status, 404);

	// Validation errors.
	const badCwd = await call(controller, {
		method: "POST",
		url: "/agent-terminal/api/terminals",
		body: { command: "true", cwd: "/definitely/not/here" },
	});
	assert.equal(badCwd.status, 400);

	// `cat` echoes stdin to stdout — the interactivity probe.
	const created = await call(controller, {
		method: "POST",
		url: "/agent-terminal/api/terminals",
		body: { label: "echo probe", command: "cat", cwd: workdir },
	});
	assert.equal(created.status, 201);
	assert.equal(created.body.backend, "pipe");
	assert.equal(created.body.status, "running");
	const id = created.body.id;

	const emptyInput = await call(controller, {
		method: "POST",
		url: `/agent-terminal/api/terminals/${id}/input`,
		body: { text: "" },
	});
	assert.equal(emptyInput.status, 400);

	const written = await call(controller, {
		method: "POST",
		url: `/agent-terminal/api/terminals/${id}/input`,
		body: { text: "hello-agent\n" },
	});
	assert.equal(written.status, 200);
	assert.equal(written.body.written, "hello-agent\n".length);

	const first = await waitFor(
		() => call(controller, { method: "GET", url: `/agent-terminal/api/terminals/${id}/output?offset=0` }),
		(payload) => payload.body.out.text.includes("hello-agent"),
	);
	assert.ok(first.body.out.nextOffset >= "hello-agent\n".length);

	// Incremental read from nextOffset only carries NEW deltas.
	await call(controller, {
		method: "POST",
		url: `/agent-terminal/api/terminals/${id}/input`,
		body: { text: "second-line\n" },
	});
	const delta = await waitFor(
		() =>
			call(controller, {
				method: "GET",
				url: `/agent-terminal/api/terminals/${id}/output?offset=${first.body.out.nextOffset}`,
			}),
		(payload) => payload.body.out.text.includes("second-line"),
	);
	assert.ok(!delta.body.out.text.includes("hello-agent"), "delta must not repeat old bytes");

	// Pipe backends cannot deliver foreground signals.
	const signalAnswer = await call(controller, {
		method: "POST",
		url: `/agent-terminal/api/terminals/${id}/signal`,
		body: { signal: "SIGINT" },
	});
	assert.equal(signalAnswer.status, 409);

	// Stop terminates; output stays readable after settlement.
	const stopped = await call(controller, {
		method: "POST",
		url: `/agent-terminal/api/terminals/${id}/stop`,
	});
	assert.equal(stopped.status, 200);
	await waitFor(
		() => call(controller, { method: "GET", url: `/agent-terminal/api/terminals/${id}/output?offset=0` }),
		(payload) => payload.body.status !== "running" && payload.body.status !== "stopping",
	);

	const discarded = await call(controller, {
		method: "DELETE",
		url: `/agent-terminal/api/terminals/${id}`,
	});
	assert.equal(discarded.status, 200);
	const afterDiscard = await call(controller, {
		method: "GET",
		url: `/agent-terminal/api/terminals/${id}/output?offset=0`,
	});
	assert.equal(afterDiscard.status, 404);

	// The maxTerminals cap counts LIVE terminals only.
	const firstLive = await call(controller, {
		method: "POST",
		url: "/agent-terminal/api/terminals",
		body: { command: "sleep 30", cwd: workdir },
	});
	assert.equal(firstLive.status, 201);
	const secondLive = await call(controller, {
		method: "POST",
		url: "/agent-terminal/api/terminals",
		body: { command: "sleep 30", cwd: workdir },
	});
	assert.equal(secondLive.status, 201);
	const thirdLive = await call(controller, {
		method: "POST",
		url: "/agent-terminal/api/terminals",
		body: { command: "sleep 30", cwd: workdir },
	});
	assert.equal(thirdLive.status, 409);

	await controller.shutdown();
	console.log("  - allowlist, validation, echo interactivity, incremental deltas, cap: OK");
}

// ---------------------------------------------------------------- suite B

console.log("suite B — pty backend (in-memory fake provider)");
{
	const tape = { specs: [], handles: [] };
	const controller = createAgentTerminal({
		spawn: () => {
			throw new Error("pipe backend must not be used when spawnTerminal exists");
		},
		spawnTerminal: makeFakeSpawnTerminal(tape),
		resolveExecutable: async (command) => command,
		defaultCwd: workdir,
		scrollbackBytes: 256,
	});

	const created = await call(controller, {
		method: "POST",
		url: "/agent-terminal/api/terminals",
		body: { argv: ["/bin/bash"], rows: 999, cols: 2, label: "fake shell" },
	});
	assert.equal(created.status, 201);
	assert.equal(created.body.backend, "pty");
	assert.equal(created.body.rows, 200, "rows clamp to MAX_ROWS");
	assert.equal(created.body.cols, 10, "cols clamp to MIN_COLS");
	assert.equal(created.body.pid, 4242);
	const id = created.body.id;
	assert.equal(tape.specs.length, 1);
	assert.deepEqual(
		{ argv: tape.specs[0].argv, graceMs: tape.specs[0].graceMs },
		{ argv: ["/bin/bash"], graceMs: 2_000 },
	);

	const listed = await call(controller, {
		method: "GET",
		url: "/agent-terminal/api/terminals",
	});
	assert.equal(listed.body.ptyAvailable, true);

	const input = await call(controller, {
		method: "POST",
		url: `/agent-terminal/api/terminals/${id}/input`,
		body: { text: "ls -la\n" },
	});
	assert.equal(input.status, 200);
	assert.deepEqual(tape.handles[0].writes, ["ls -la\n"]);

	const echoed = await waitFor(
		() => call(controller, { method: "GET", url: `/agent-terminal/api/terminals/${id}/output?offset=0` }),
		(payload) => payload.body.out.text.includes("«ls -la\n»"),
	);

	const signaled = await call(controller, {
		method: "POST",
		url: `/agent-terminal/api/terminals/${id}/signal`,
		body: { signal: "SIGINT" },
	});
	assert.equal(signaled.status, 200);
	assert.equal(signaled.body.processGroupId, 4242);
	assert.deepEqual(tape.handles[0].signals, ["SIGINT"]);

	const badSignal = await call(controller, {
		method: "POST",
		url: `/agent-terminal/api/terminals/${id}/signal`,
		body: { signal: "SIGUSR1" },
	});
	assert.equal(badSignal.status, 400);

	await waitFor(
		() =>
			call(controller, {
				method: "GET",
				url: `/agent-terminal/api/terminals/${id}/output?offset=0`,
			}),
		(payload) => payload.body.out.text.includes("[signal:SIGINT]"),
	);
	assert.ok(echoed.body.status === "running");

	// Settlement reaps the whole terminal session.
	tape.handles[0].settle();
	await waitFor(
		() => call(controller, { method: "GET", url: `/agent-terminal/api/terminals/${id}/output?offset=0` }),
		(payload) => payload.body.status === "exited",
	);
	assert.equal(tape.handles[0].terminated, true, "settled sessions must be reaped");

	await controller.shutdown();
	console.log("  - allocation clamps, write/signal plumbing, settle+reap: OK");
}

console.log("host-half functional tests OK");
