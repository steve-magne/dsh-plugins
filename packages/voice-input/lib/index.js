/**
 * @dsh-plugins/voice-input — host half.
 *
 * A DeepSeek Harness (cordis) plugin that adds on-device voice dictation to
 * the web surface (the GitHub-Copilot-app "voice conversations" workflow).
 * The browser half contributes a microphone toggle to the composer tool row;
 * it can transcribe either through the browser Speech API or by sending the
 * recording to THIS host half, which forwards it to one locally-configured
 * transcription server (e.g. whisper.cpp's OpenAI-compatible endpoint).
 *
 * Trust posture: the forwarder is deliberately narrow — ONE configured ASR
 * URL, validated to be loopback at activation time, bodies capped, upstream
 * answer truncated. The harness never proxies audio to an arbitrary URL, and
 * the default story matches the Copilot app's promise: nothing leaves the
 * machine.
 */

export const inject = ["webServer"];

const API_PREFIX = "/voice-input/api";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const UPSTREAM_SNIPPET_CHARS = 400;

/**
 * Validate that a transcription endpoint is loopback-only.
 * @param {string} rawUrl
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
export function validateLoopbackUrl(rawUrl) {
	let url;
	try {
		url = new URL(String(rawUrl));
	} catch {
		return { ok: false, reason: `not a valid URL: ${rawUrl}` };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, reason: `protocol must be http(s): ${url.protocol}` };
	}
	const hostname = url.hostname.toLowerCase();
	const isLoopback =
		hostname === "localhost" ||
		hostname === "::1" ||
		hostname === "[::1]" ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
	if (!isLoopback) {
		return {
			ok: false,
			reason: `ASR endpoint must be loopback (nothing leaves the machine): ${hostname}`,
		};
	}
	return { ok: true, url };
}

/**
 * Build the voice-input controller. Factored out of {@link apply} so the HTTP
 * behavior is testable against a stubbed fetch.
 * @param {object} deps
 * @param {string} [deps.asrUrl] - local OpenAI-compatible transcription endpoint.
 * @param {typeof fetch} [deps.fetchImpl] - injectable for tests.
 */
export function createVoiceInput(deps = {}) {
	const fetchImpl = typeof deps.fetchImpl === "function" ? deps.fetchImpl : globalThis.fetch;
	const validation = deps.asrUrl
		? validateLoopbackUrl(deps.asrUrl)
		: { ok: false, reason: "no ASR endpoint configured (row config key: asrUrl)" };
	const asrEnabled = validation.ok;

	function sendJson(res, statusCode, payload) {
		const body = JSON.stringify(payload);
		res.writeHead(statusCode, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(body);
	}

	function isLocalHost(req) {
		const raw = req.headers.host ?? "";
		let hostname = "";
		try {
			hostname = new URL(`http://${raw}`).hostname;
		} catch {
			return false;
		}
		return (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "[::1]" ||
			hostname === "::1"
		);
	}

	// ---------------------------------------------------------------- routes

	async function handle(req, res) {
		if (!isLocalHost(req)) {
			sendJson(res, 403, { error: "voice-input: local connections only" });
			return;
		}
		let url;
		try {
			url = new URL(req.url ?? "/", "http://invalid.local");
		} catch {
			sendJson(res, 400, { error: "malformed request URL" });
			return;
		}
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		const method = (req.method ?? "GET").toUpperCase();

		if (method === "GET" && pathname === `${API_PREFIX}/config`) {
			sendJson(res, 200, {
				asrEnabled,
				asrOrigin: asrEnabled ? validation.url.origin : null,
				reason: asrEnabled ? null : validation.reason,
				maxAudioBytes: MAX_AUDIO_BYTES,
			});
			return;
		}

		if (method === "POST" && pathname === `${API_PREFIX}/transcribe`) {
			if (!asrEnabled) {
				sendJson(res, 409, { error: validation.reason });
				return;
			}
			const contentType = String(req.headers["content-type"] ?? "");
			if (!contentType.startsWith("multipart/form-data") && !contentType.startsWith("audio/")) {
				sendJson(res, 415, {
					error: "voice-input: expected multipart/form-data or audio/* body",
				});
				return;
			}
			const declaredLength = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
			if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
				sendJson(res, 413, {
					error: `recording exceeds ${MAX_AUDIO_BYTES} bytes`,
				});
				return;
			}
			const chunks = [];
			let size = 0;
			for await (const chunk of req) {
				size += chunk.length;
				if (size > MAX_AUDIO_BYTES) {
					sendJson(res, 413, { error: `recording exceeds ${MAX_AUDIO_BYTES} bytes` });
					return;
				}
				chunks.push(chunk);
			}
			const audio = Buffer.concat(chunks);
			if (audio.length === 0) {
				sendJson(res, 400, { error: "empty recording" });
				return;
			}
			try {
				const upstream = await fetchImpl(validation.url, {
					method: "POST",
					headers: { "content-type": contentType },
					body: audio,
					signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
				});
				const raw = await upstream.text();
				if (!upstream.ok) {
					sendJson(res, 502, {
						error: `transcription server answered ${upstream.status}: ${raw.slice(0, UPSTREAM_SNIPPET_CHARS)}`,
					});
					return;
				}
				sendJson(res, 200, { text: extractText(raw) });
			} catch (error) {
				sendJson(res, 502, {
					error: `transcription server unreachable: ${String(error?.message ?? error)}`,
				});
			}
			return;
		}

		sendJson(res, 404, { error: `no such voice-input endpoint: ${method} ${pathname}` });
	}

	return { handle, isAsrEnabled: () => asrEnabled };
}

/** Tolerantly pull the transcript out of an upstream answer. */
function extractText(rawBody) {
	try {
		const parsed = JSON.parse(rawBody);
		for (const candidate of [parsed?.text, parsed?.transcript, parsed?.result]) {
			if (typeof candidate === "string") return candidate;
		}
		if (parsed && typeof parsed === "object") {
			for (const value of Object.values(parsed)) {
				if (typeof value === "string") return value;
			}
		}
		return "";
	} catch {
		return rawBody.trim();
	}
}

/**
 * Cordis plugin body: wire the controller to the harness services.
 * @param {object} ctx - host cordis context (`webServer` injected).
 * @param {object} [config] - row config `{ asrUrl }` — MUST be loopback.
 */
export function apply(ctx, config) {
	const options = config ?? {};
	if (options.asrUrl) {
		const check = validateLoopbackUrl(options.asrUrl);
		if (!check.ok) console.warn(`voice-input: ${check.reason}`);
	}
	const controller = createVoiceInput({
		asrUrl: typeof options.asrUrl === "string" ? options.asrUrl : undefined,
	});

	const disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: "/voice-input/api",
		handler: (req, res) => {
			void controller.handle(req, res);
		},
	});

	ctx.on("dispose", () => {
		disposeRoute();
	});
}
