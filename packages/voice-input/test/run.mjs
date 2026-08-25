/**
 * Standalone functional test for the @dsh-plugins/voice-input host half.
 * Runs without cordis: drives `createVoiceInput` against a stubbed fetch and
 * mock req/res objects, plus direct checks of the loopback validator.
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { createVoiceInput, validateLoopbackUrl } from "../lib/index.js";

// ---------------------------------------------------------------- helpers

function makeReq({
	method = "GET",
	url = "/",
	body = undefined,
	headers = {},
	host = "127.0.0.1:3080",
}) {
	const chunks =
		body === undefined
			? []
			: [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8")];
	return {
		method,
		url,
		headers: { host, ...headers },
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

// ---------------------------------------------------------- validator

console.log("loopback validator");
{
	assert.equal(validateLoopbackUrl("http://127.0.0.1:8080/v1/audio/transcriptions").ok, true);
	assert.equal(validateLoopbackUrl("http://localhost:9000/asr").ok, true);
	assert.equal(validateLoopbackUrl("http://[::1]:9000/asr").ok, true);
	assert.equal(validateLoopbackUrl("https://127.0.0.1/transcribe").ok, true);

	const remote = validateLoopbackUrl("http://192.168.1.10:8080/asr");
	assert.equal(remote.ok, false, "LAN addresses must be rejected");
	const dns = validateLoopbackUrl("http://api.example.com/v1/audio/transcriptions");
	assert.equal(dns.ok, false, "DNS names other than localhost must be rejected");
	const scheme = validateLoopbackUrl("ftp://127.0.0.1/asr");
	assert.equal(scheme.ok, false, "non-http schemes must be rejected");
	const garbage = validateLoopbackUrl("not a url");
	assert.equal(garbage.ok, false);
	console.log("  - loopback-only enforcement: OK");
}

// ---------------------------------------------------------------- suite A

console.log("suite A — unconfigured host half");
{
	const controller = createVoiceInput({});

	const config = await call(controller, {
		method: "GET",
		url: "/voice-input/api/config",
	});
	assert.equal(config.status, 200);
	assert.equal(config.body.asrEnabled, false);
	assert.match(config.body.reason, /no ASR endpoint configured/);

	const refused = await call(controller, {
		method: "POST",
		url: "/voice-input/api/transcribe",
		body: Buffer.from("x"),
		headers: { "content-type": "audio/webm", "content-length": "1" },
	});
	assert.equal(refused.status, 409);

	const forbidden = await call(controller, {
		method: "GET",
		url: "/voice-input/api/config",
		host: "evil.example:3080",
	});
	assert.equal(forbidden.status, 403);

	const missing = await call(controller, {
		method: "GET",
		url: "/voice-input/api/nope",
	});
	assert.equal(missing.status, 404);
	console.log("  - config disclosure, refusal, allowlist, routing: OK");
}

// ---------------------------------------------------------------- suite B

console.log("suite B — configured forwarder (stubbed upstream)");
{
	const seenRequests = [];
	const fetchStub = async (url, init) => {
		seenRequests.push({ url: String(url), init });
		if (seenRequests.length === 1) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ text: "hello dictation" }),
			};
		}
		if (seenRequests.length === 2) {
			return { ok: false, status: 500, text: async () => "boom".repeat(300) };
		}
		throw new Error("connection refused");
	};

	const controller = createVoiceInput({
		asrUrl: "http://127.0.0.1:18080/v1/audio/transcriptions",
		fetchImpl: fetchStub,
	});

	const config = await call(controller, {
		method: "GET",
		url: "/voice-input/api/config",
	});
	assert.equal(config.body.asrEnabled, true);
	assert.equal(config.body.asrOrigin, "http://127.0.0.1:18080");

	const audio = Buffer.from("RIFF-fake-audio-bytes");
	const good = await call(controller, {
		method: "POST",
		url: "/voice-input/api/transcribe",
		body: audio,
		headers: { "content-type": "multipart/form-data; boundary=X" },
	});
	assert.equal(good.status, 200);
	assert.equal(good.body.text, "hello dictation");
	assert.equal(seenRequests[0].url, "http://127.0.0.1:18080/v1/audio/transcriptions");
	assert.ok(Buffer.isBuffer(seenRequests[0].init.body));
	assert.equal(
		seenRequests[0].init.headers["content-type"],
		"multipart/form-data; boundary=X",
	);

	const badUpstream = await call(controller, {
		method: "POST",
		url: "/voice-input/api/transcribe",
		body: audio,
		headers: { "content-type": "audio/webm" },
	});
	assert.equal(badUpstream.status, 502);
	assert.ok(badUpstream.body.error.includes("answered 500"));
	assert.ok(badUpstream.body.error.length < 500, "upstream answers are truncated");

	const downUpstream = await call(controller, {
		method: "POST",
		url: "/voice-input/api/transcribe",
		body: audio,
		headers: { "content-type": "audio/webm" },
	});
	assert.equal(downUpstream.status, 502);
	assert.match(downUpstream.body.error, /unreachable/);

	const wrongType = await call(controller, {
		method: "POST",
		url: "/voice-input/api/transcribe",
		body: audio,
		headers: { "content-type": "application/json" },
	});
	assert.equal(wrongType.status, 415);

	const oversized = await call(controller, {
		method: "POST",
		url: "/voice-input/api/transcribe",
		body: Buffer.alloc(11 * 1024 * 1024),
		headers: { "content-type": "audio/webm" },
	});
	assert.equal(oversized.status, 413);

	const empty = await call(controller, {
		method: "POST",
		url: "/voice-input/api/transcribe",
		body: Buffer.alloc(0),
		headers: { "content-type": "audio/webm" },
	});
	assert.equal(empty.status, 400);

	await call(controller, {
		method: "POST",
		url: "/voice-input/api/transcribe",
		body: audio,
		headers: { "content-type": "audio/webm" },
	}).catch(() => {});
	console.log("  - forwarding shape, error mapping, caps: OK");
}

console.log("host-half functional tests OK");
