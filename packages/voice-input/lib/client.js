/**
 * @dsh-plugins/voice-input — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form:
 * executing the script only REGISTERS the factory; the body runs at
 * materialization. Externals are limited to the shell-seeded baseline
 * (`react`, `react/jsx-runtime`). The plugin contributes one entry to the
 * `conversation.input.left` slot: a microphone toggle that dictates into the
 * composer, either through the browser Speech API or through the plugin's
 * loopback-only local transcription endpoint.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/voice-input",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css =
			".vi-root{display:inline-flex;align-items:center}" +
			".vi-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;" +
			"width:28px;height:28px;border-radius:8px;border:1px solid transparent;background:none;" +
			"color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;font-size:14px;line-height:1}" +
			".vi-btn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-fill-l2,#242428)}" +
			".vi-btn-rec{color:#ff5a6e;background:rgba(255,90,110,.12);border-color:rgba(255,90,110,.35)}" +
			".vi-btn-rec::after{content:\"\";position:absolute;inset:-3px;border-radius:11px;" +
			"border:2px solid rgba(255,90,110,.45);animation:vi-pulse 1.2s ease-out infinite}" +
			"@keyframes vi-pulse{0%{transform:scale(.85);opacity:.9}100%{transform:scale(1.25);opacity:0}}" +
			".vi-btn-busy{color:#eab308;cursor:wait}" +
			".vi-engine{margin-left:2px;font-size:9px;text-transform:uppercase;letter-spacing:.04em;" +
			"color:var(--dsw-alias-label-tertiary,#777)}";
		const tagId = "@dsh-plugins/voice-input/mic.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/voice-input";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api client
		const API = "/voice-input/api";

		async function apiFetch(path, options) {
			const response = await fetch(API + path, options);
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok) {
				const message = payload?.error ? payload.error : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload;
		}

		function getConfig() {
			return apiFetch("/config", { method: "GET" });
		}
		function transcribe(blob) {
			const form = new window.FormData();
			form.append("file", blob, "dictation.webm");
			return apiFetch("/transcribe", { method: "POST", body: form });
		}
		//#endregion

		//#region storage
		const ENGINE_KEY = "dsh-voice-input.engine.v1";
		function readEngine() {
			try {
				const value = window.localStorage.getItem(ENGINE_KEY);
				return value === "webapi" || value === "local" ? value : "auto";
			} catch {
				return "auto";
			}
		}
		function writeEngine(engine) {
			try {
				window.localStorage.setItem(ENGINE_KEY, engine);
			} catch {
				/* private mode: session-only choice */
			}
		}
		//#endregion

		//#region composer insertion
		function findComposerTextarea() {
			if (typeof document === "undefined") return null;
			const candidates = [...document.querySelectorAll("textarea")].filter((node) => {
				const rect = node.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0;
			});
			return candidates.length > 0 ? candidates[candidates.length - 1] : null;
		}

		function insertIntoComposer(text) {
			const node = findComposerTextarea();
			if (!node) return false;
			const current = typeof node.value === "string" ? node.value : "";
			const merged = current && !/\s$/.test(current) ? `${current} ${text}` : current + text;
			const setter =
				Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
			if (setter) setter.call(node, merged);
			else node.value = merged;
			node.dispatchEvent(new window.Event("input", { bubbles: true }));
			node.focus();
			node.selectionStart = node.selectionEnd = merged.length;
			return true;
		}

		async function copyFallback(text) {
			try {
				await window.navigator.clipboard.writeText(text);
				return true;
			} catch {
				return false;
			}
		}
		//#endregion

		//#region engines
		function getSpeechRecognition() {
			return (
				(typeof window !== "undefined" && window.SpeechRecognition) ||
				(typeof window !== "undefined" && window.webkitSpeechRecognition) ||
				null
			);
		}

		/** Browser Speech API session: accumulates final results until stopped. */
		class WebApiSession {
			constructor(onFinal, onError) {
				this.finalText = "";
				this.onError = onError;
				const Ctor = getSpeechRecognition();
				this.recognition = new Ctor();
				this.recognition.continuous = true;
				this.recognition.interimResults = true;
				this.recognition.lang = window.navigator?.language || "en-US";
				this.recognition.onresult = (event) => {
					for (let index = event.resultIndex; index < event.results.length; index += 1) {
						const result = event.results[index];
						if (result.isFinal) this.finalText += result[0].transcript;
					}
				};
				this.recognition.onerror = (event) => onError(describeSpeechError(event?.error));
				this.stopped = false;
			}
			start() {
				this.recognition.start();
			}
			stop() {
				this.stopped = true;
				try {
					this.recognition.stop();
				} catch {
					/* already stopped */
				}
				return this.finalText.trim();
			}
		}

		function describeSpeechError(code) {
			if (code === "not-allowed" || code === "service-not-allowed")
				return "microphone permission denied";
			if (code === "no-speech") return "no speech detected";
			if (code === "audio-capture") return "no microphone found";
			return `speech recognition error: ${code ?? "unknown"}`;
		}

		/** Local-server session: MediaRecorder → /transcribe. */
		class LocalSession {
			constructor(onFinal, onError) {
				this.onFinal = onFinal;
				this.onError = onError;
			}
			async start() {
				this.stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
				this.chunks = [];
				this.recorder = new window.MediaRecorder(this.stream);
				this.recorder.ondataavailable = (event) => {
					if (event.data && event.data.size > 0) this.chunks.push(event.data);
				};
				this.recorder.onerror = () => this.onError("recording failed");
				this.recorder.start();
			}
			async stop() {
				const recorder = this.recorder;
				if (!recorder) return "";
				const finished = new Promise((resolve) => {
					recorder.onstop = () => resolve();
				});
				try {
					recorder.stop();
				} catch {
					/* already stopped */
				}
				await finished;
				for (const track of this.stream?.getTracks?.() ?? []) track.stop();
				const blob = new window.Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
				const payload = await transcribe(blob);
				return String(payload?.text ?? "").trim();
			}
		}
		//#endregion

		//#region mic button
		const MAX_RECORD_MS = 120_000;

		function MicButton() {
			const [phase, setPhase] = react.useState("idle"); // idle | recording | busy | error
			const [error, setError] = react.useState("");
			const [engine, setEngine] = react.useState(readEngine);
			const [asrEnabled, setAsrEnabled] = react.useState(null);
			const sessionRef = react.useRef(null);
			const timerRef = react.useRef(null);

			// Learn whether the host half has a usable local ASR endpoint.
			react.useEffect(() => {
				let live = true;
				getConfig()
					.then((payload) => {
						if (live) setAsrEnabled(Boolean(payload?.asrEnabled));
					})
					.catch(() => {
						if (live) setAsrEnabled(false);
					});
				return () => {
					live = false;
				};
			}, []);

			const effectiveEngine = () => {
				if (engine === "auto") return getSpeechRecognition() ? "webapi" : "local";
				return engine;
			};

			const finishWithText = async (rawText) => {
				const text = String(rawText ?? "").trim();
				if (!text) {
					setPhase("idle");
					setError("nothing heard");
					return;
				}
				const inserted = insertIntoComposer(text);
				if (!inserted) await copyFallback(`${text} `);
				setPhase("idle");
			};

			const stop = async () => {
				window.clearInterval(timerRef.current);
				timerRef.current = null;
				const session = sessionRef.current;
				sessionRef.current = null;
				if (!session) {
					setPhase("idle");
					return;
				}
				setPhase("busy");
				try {
					await finishWithText(session.stop());
				} catch (err) {
					setPhase("error");
					setError(String(err.message || err));
				}
			};

			const start = async () => {
				setError("");
				const which = effectiveEngine();
				if (which === "local" && asrEnabled === false) {
					setPhase("error");
					setError(
						"local ASR not configured: set the row config 'asrUrl' (loopback) on the voice-input plugin",
					);
					return;
				}
				try {
					const session =
						which === "webapi"
							? new WebApiSession(null, (message) => {
									setError(message);
								})
							: new LocalSession(null, (message) => {
									setError(message);
								});
					sessionRef.current = session;
					await session.start();
					setPhase("recording");
					timerRef.current = window.setInterval(() => {
						void stop();
					}, MAX_RECORD_MS);
				} catch (err) {
					sessionRef.current = null;
					setPhase("error");
					setError(String(err.message || err));
				}
			};

			const toggle = () => {
				if (phase === "recording") void stop();
				else if (phase !== "busy") void start();
			};

			const cycleEngine = (event) => {
				event.preventDefault();
				event.stopPropagation();
				const order = ["auto", "webapi", "local"];
				const next = order[(order.indexOf(engine) + 1) % order.length];
				setEngine(next);
				writeEngine(next);
			};

			const icon = phase === "recording" ? "⏹" : "🎙";
			const title =
				phase === "recording"
					? "Stop dictation"
					: phase === "busy"
						? "Transcribing…"
						: `Dictate (${effectiveEngine()}${engine === "auto" ? ", shift-click to change" : ""})`;

			return react_jsx_runtime.jsxs("span", {
				className: "vi-root",
				"data-testid": "voice-input-root",
				children: [
					react_jsx_runtime.jsx("button", {
						type: "button",
						className:
							"vi-btn" +
							(phase === "recording" ? " vi-btn-rec" : "") +
							(phase === "busy" ? " vi-btn-busy" : ""),
						"data-testid": "voice-input-toggle",
						title,
						"aria-pressed": phase === "recording",
						onClick: toggle,
						onContextMenu: cycleEngine,
						children: icon,
					}),
					engine !== "auto"
						? react_jsx_runtime.jsx(
								"span",
								{
									className: "vi-engine",
									children: engine === "webapi" ? "w" : "L",
								},
						  )
						: null,
					phase === "error" && error
						? react_jsx_runtime.jsx("span", {
								className: "vi-engine",
								"title": error,
								style: { color: "#ff8896", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								children: "mic error",
							})
						: null,
				],
			});
		}
		//#endregion

		//#region plugin body
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: "voice-mic",
						order: 50,
					},
					MicButton,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
