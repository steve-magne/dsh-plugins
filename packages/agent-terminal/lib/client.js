/**
 * @dsh-plugins/agent-terminal — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form:
 * executing the script only REGISTERS the factory; the body runs at
 * materialization. Externals are limited to the shell-seeded baseline
 * (`react`, `react/jsx-runtime`). The plugin contributes one entry to the
 * runtime-owned `shell.overlay` slot: a floating toggle chip plus a
 * right-docked takeover console to allocate terminals on the harness host,
 * watch their output stream in, type into them, and interrupt them.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/agent-terminal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css =
			".at-root{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#e6e6e6)}" +
			".at-toggle{position:absolute;left:16px;bottom:16px;z-index:30;display:inline-flex;align-items:center;gap:6px;" +
			"padding:8px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#333);" +
			"background:var(--dsw-specific-menu,#16161a);color:var(--dsw-alias-label-secondary,#bbb);" +
			"box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.4));cursor:pointer;font-size:12px}" +
			".at-toggle:hover{color:var(--dsw-alias-label-primary,#fff);border-color:var(--dsw-alias-border-l3,#555)}" +
			".at-panel{position:absolute;top:0;right:0;bottom:0;width:min(560px,94vw);z-index:29;display:flex;flex-direction:column;" +
			"border-left:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-specific-menu,#141417);" +
			"box-shadow:-12px 0 32px rgba(0,0,0,.35);font-family:var(--dsw-font-sans,system-ui,sans-serif)}" +
			".at-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#333);flex:none}" +
			".at-title{flex:1;font-weight:600;font-size:13px;letter-spacing:.02em}" +
			".at-badge{font-size:10px;text-transform:uppercase;letter-spacing:.06em;border-radius:5px;padding:2px 6px;" +
			"border:1px solid var(--dsw-alias-border-l2,#333);color:var(--dsw-alias-label-tertiary,#888)}" +
			".at-iconbtn{background:none;border:0;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;border-radius:6px;" +
			"padding:4px 6px;font-size:13px;line-height:1}" +
			".at-iconbtn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-fill-l2,#242428)}" +
			".at-body{display:flex;flex-direction:column;min-height:0;flex:1;padding:10px 12px 14px;gap:10px;overflow:hidden}" +
			".at-form{display:flex;flex-direction:column;gap:6px;flex:none}" +
			".at-input,.at-textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-fill-l1,#1b1b20);" +
			"color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:8px;" +
			"padding:7px 9px;font-size:12px;outline:none}" +
			".at-input:focus{border-color:var(--dsw-alias-border-l3,#4a4a52)}" +
			".at-formrow{display:flex;gap:6px;align-items:center}" +
			".at-newbtn{margin-left:auto;background:#2563eb;border:0;color:#fff;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}" +
			".at-newbtn:hover{background:#1d4fd8}" +
			".at-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93)}" +
			".at-scroll{overflow-y:auto;min-height:0;flex:1;display:flex;flex-direction:column;gap:10px;padding-right:2px}" +
			".at-card{border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:10px;background:var(--dsw-alias-fill-l1,#191920);" +
			"padding:8px 10px;display:flex;flex-direction:column;gap:6px}" +
			".at-cardrow{display:flex;align-items:center;gap:6px}" +
			".at-name{flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".at-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2);white-space:nowrap}" +
			".at-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#6b7280}" +
			".at-dot-running{background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,.8)}" +
			".at-dot-stopping{background:#eab308}.at-dot-failed{background:#ef4444}.at-dot-exited{background:#3f8cff}" +
			".at-btn,.at-stopbtn,.at-intbtn,.at-delbtn{border:0;border-radius:7px;padding:4px 10px;font-size:11px;cursor:pointer;flex:none}" +
			".at-intbtn{background:#7a5a0e;color:#ffeec2}.at-intbtn:hover{background:#96700f}" +
			".at-stopbtn{background:#8a2230;color:#ffd9de}.at-stopbtn:hover{background:#a52a3b}" +
			".at-delbtn{background:none;color:var(--dsw-alias-label-tertiary,#777);padding:4px 6px}.at-delbtn:hover{color:#ff8896}" +
			".at-out{margin:0;padding:8px;background:#0a0a0d;border:1px solid #232329;border-radius:8px;height:220px;overflow:auto;" +
			"font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:16px;" +
			"white-space:pre-wrap;word-break:break-word;color:#cdd6e0}" +
			".at-inrow{display:flex;gap:6px}" +
			".at-send{background:#0e7a46;color:#d3f5e3;border:0;border-radius:7px;padding:4px 12px;font-size:11px;cursor:pointer;flex:none}" +
			".at-send:hover{background:#0c9152}" +
			".at-error{color:#ff8896;font-size:11px;white-space:pre-wrap}" +
			".at-empty{color:var(--dsw-alias-label-tertiary,#777);font-size:12px;padding:10px 4px}";
		const tagId = "@dsh-plugins/agent-terminal/console.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/agent-terminal";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api client
		const API = "/agent-terminal/api";

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

		function createTerminal(body) {
			return apiFetch("/terminals", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		}
		function listTerminals() {
			return apiFetch("/terminals", { method: "GET" });
		}
		function fetchOutput(id, offset) {
			return apiFetch(`/terminals/${id}/output?offset=${offset}`, { method: "GET" });
		}
		function sendInput(id, text) {
			return apiFetch(`/terminals/${id}/input`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
			});
		}
		function sendSignal(id, signal) {
			return apiFetch(`/terminals/${id}/signal`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ signal }),
			});
		}
		function stopTerminal(id) {
			return apiFetch(`/terminals/${id}/stop`, { method: "POST" });
		}
		function discardTerminal(id) {
			return apiFetch(`/terminals/${id}`, { method: "DELETE" });
		}
		//#endregion

		//#region storage
		const CWD_KEY = "dsh-agent-terminal.cwd.v1";
		function readLastCwd() {
			try {
				return window.localStorage.getItem(CWD_KEY) ?? "";
			} catch {
				return "";
			}
		}
		function writeLastCwd(cwd) {
			try {
				window.localStorage.setItem(CWD_KEY, cwd);
			} catch {
				/* private mode: session-only memory */
			}
		}
		//#endregion

		//#region shared bits
		function dotClass(status) {
			if (status === "running") return "at-dot at-dot-running";
			if (status === "stopping") return "at-dot at-dot-stopping";
			if (status === "failed") return "at-dot at-dot-failed";
			return "at-dot at-dot-exited";
		}

		function statusText(term) {
			if (term.status === "running") return "live";
			if (term.status === "stopping") return "stopping";
			if (term.status === "failed")
				return `failed${term.error ? `: ${term.error}` : ""}`;
			const exit = term.exit || {};
			if (exit.signal) return `killed (${exit.signal})`;
			if (typeof exit.exitCode === "number")
				return exit.exitCode === 0 ? "exited (0)" : `exit ${exit.exitCode}`;
			return "exited";
		}

		const isLiveStatus = (status) => status === "running" || status === "stopping";
		//#endregion

		//#region terminal card
		function TerminalCard(props) {
			const term = props.term;
			const patch = props.patch;
			const onError = props.onError;
			const outRef = react.useRef(null);
			const inputRef = react.useRef(null);
			const live = isLiveStatus(term.status);

			react.useEffect(() => {
				const node = outRef.current;
				if (!node) return;
				node.scrollTop = node.scrollHeight;
			}, [term.text]);

			const submitLine = () => {
				const value = inputRef.current ? inputRef.current.value : "";
				if (!value) return;
				inputRef.current.value = "";
				sendInput(term.id, `${value}\n`).catch((error) =>
					onError(String(error.message || error)),
				);
			};

			const interrupt = () => {
				sendSignal(term.id, "SIGINT").catch((error) =>
					onError(String(error.message || error)),
				);
			};

			return react_jsx_runtime.jsxs("div", {
				className: "at-card",
				"data-testid": `terminal-card-${term.id}`,
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "at-cardrow",
						children: [
							react_jsx_runtime.jsx("span", { className: dotClass(term.status) }),
							react_jsx_runtime.jsx("span", {
								className: "at-name",
								title: `${term.label} · ${term.cwd}`,
								children: term.label,
							}),
							react_jsx_runtime.jsx("span", {
								className: "at-meta",
								title: `backend: ${term.backend} · pid ${term.pid}`,
								children: `${term.backend === "pty" ? "PTY" : "PIPE"} · ${statusText(term)}`,
							}),
							live && term.backend === "pty"
								? react_jsx_runtime.jsx("button", {
										className: "at-intbtn",
										"data-testid": `terminal-sigint-${term.id}`,
										title: "Send Ctrl-C to the foreground process",
										onClick: interrupt,
										children: "^C",
									})
								: null,
							live
								? react_jsx_runtime.jsx("button", {
										className: "at-stopbtn",
										"data-testid": `terminal-stop-${term.id}`,
										onClick: () => stopTerminal(term.id).catch((error) => onError(String(error.message || error))),
										children: "■ Stop",
									})
								: react_jsx_runtime.jsx("button", {
										className: "at-delbtn",
										"data-testid": `terminal-discard-${term.id}`,
										title: "Remove from the list",
										onClick: () => props.onDiscard(term.id),
										children: "✕",
									}),
						],
					}),
					react_jsx_runtime.jsx("pre", {
						className: "at-out",
						"data-testid": `terminal-output-${term.id}`,
						ref: outRef,
						children: term.text,
					}),
					live
						? react_jsx_runtime.jsxs("div", {
								className: "at-inrow",
								children: [
									react_jsx_runtime.jsx("input", {
										ref: inputRef,
										className: "at-input",
										"data-testid": `terminal-input-${term.id}`,
										placeholder:
											term.backend === "pty"
												? "Type a line for this terminal…"
												: "Type a line (sent with newline on Enter)…",
										spellCheck: false,
										onKeyDown: (event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												submitLine();
											}
										},
									}),
									react_jsx_runtime.jsx("button", {
										className: "at-send",
										"data-testid": `terminal-send-${term.id}`,
										onClick: submitLine,
										children: "Send",
									}),
								],
							})
						: null,
				],
			});
		}
		//#endregion

		//#region new terminal form
		function NewForm(props) {
			const onCreate = props.onCreate;
			const labelRef = react.useRef(null);
			const cwdRef = react.useRef(null);
			const commandRef = react.useRef(null);

			const submit = () => {
				const body = {};
				const label = labelRef.current ? labelRef.current.value.trim() : "";
				const cwd = cwdRef.current ? cwdRef.current.value.trim() : "";
				const command = commandRef.current ? commandRef.current.value.trim() : "";
				if (label) body.label = label;
				if (cwd) body.cwd = cwd;
				if (command) body.command = command;
				onCreate(body);
			};

			return react_jsx_runtime.jsxs("form", {
				className: "at-form",
				"data-testid": "agent-terminal-new-form",
				onSubmit: (event) => {
					event.preventDefault();
					submit();
				},
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "at-formrow",
						children: [
							react_jsx_runtime.jsx("input", {
								ref: labelRef,
								className: "at-input",
								"data-testid": "agent-terminal-label-input",
								placeholder: "Name (optional)",
								spellCheck: false,
							}),
							react_jsx_runtime.jsx("input", {
								ref: cwdRef,
								className: "at-input",
								"data-testid": "agent-terminal-cwd-input",
								placeholder: "Working directory (default: harness cwd)",
								defaultValue: readLastCwd(),
								spellCheck: false,
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "at-formrow",
						children: [
							react_jsx_runtime.jsx("input", {
								ref: commandRef,
								className: "at-input",
								"data-testid": "agent-terminal-command-input",
								placeholder: "Command to run (blank = interactive shell)",
								spellCheck: false,
								onKeyDown: (event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										submit();
									}
								},
							}),
							react_jsx_runtime.jsx("button", {
								type: "submit",
								className: "at-newbtn",
								"data-testid": "agent-terminal-create-btn",
								children: "+ Terminal",
							}),
						],
					}),
					react_jsx_runtime.jsx("div", {
						className: "at-hint",
						children:
							"Terminals run on the harness host with its full privileges. PTY when available, piped fallback otherwise.",
					}),
				],
			});
		}
		//#endregion

		//#region panel
		function Panel(props) {
			const onClose = props.onClose;
			const [terminals, setTerminals] = react.useState({});
			const [ptyAvailable, setPtyAvailable] = react.useState(false);
			const [error, setError] = react.useState("");
			const terminalsRef = react.useRef(terminals);
			terminalsRef.current = terminals;

			const putTerminal = react.useCallback((meta) => {
				setTerminals((previous) =>
					Object.assign({}, previous, {
						[meta.id]: Object.assign({ text: "", offset: 0 }, previous[meta.id], meta),
					}),
				);
			}, []);

			const patchTerminal = react.useCallback((id, patch) => {
				setTerminals((previous) => {
					const current = previous[id];
					if (!current) return previous;
					return Object.assign({}, previous, {
						[id]: Object.assign({}, current, patch),
					});
				});
			}, []);

			// Adopt still-live host terminals left over from a page reload, and
			// learn whether the deployed subprocess provider has the PTY primitive.
			react.useEffect(() => {
				let cancelled = false;
				listTerminals()
					.then((payload) => {
						if (cancelled) return;
						setPtyAvailable(Boolean(payload.ptyAvailable));
						for (const meta of payload.terminals || []) {
							if (isLiveStatus(meta.status) && !terminalsRef.current[meta.id]) {
								putTerminal(meta);
							}
						}
					})
					.catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [putTerminal]);

			// Poll scrollback deltas for every known terminal while open.
			react.useEffect(() => {
				const timer = window.setInterval(() => {
					for (const id of Object.keys(terminalsRef.current)) {
						const term = terminalsRef.current[id];
						fetchOutput(id, term.offset)
							.then((payload) => {
								patchTerminal(id, {
									status: payload.status,
									exit: payload.exit,
									error: payload.error,
									offset: payload.out ? payload.out.nextOffset : term.offset,
									text: (
										term.text + (payload.out ? payload.out.text : "")
									).slice(-400_000),
								});
							})
							.catch(() => {});
					}
				}, 700);
				return () => window.clearInterval(timer);
			}, [patchTerminal]);

			// Escape closes the panel.
			react.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);

			const create = (body) => {
				setError("");
				const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : "";
				if (cwd) writeLastCwd(cwd);
				createTerminal(body)
					.then((created) => putTerminal(created))
					.catch((err) => setError(String(err.message || err)));
			};

			const discard = async (id) => {
				try {
					await discardTerminal(id);
					setTerminals((previous) => {
						const next = Object.assign({}, previous);
						delete next[id];
						return next;
					});
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			const list = Object.values(terminals).sort((a, b) => b.createdAt - a.createdAt);

			return react_jsx_runtime.jsxs("div", {
				className: "at-panel",
				"data-testid": "agent-terminal-panel",
				children: [
					react_jsx_runtime.jsxs("header", {
						className: "at-header",
						children: [
							react_jsx_runtime.jsx("span", { children: "▮" }),
							react_jsx_runtime.jsx("span", {
								className: "at-title",
								children: "Agent Terminal",
							}),
							react_jsx_runtime.jsx("span", {
								className: "at-badge",
								title:
									"PTY = real pseudo-terminal (interactive, ^C works). PIPE = piped fallback (line-oriented).",
								children: ptyAvailable ? "pty" : "pipe",
							}),
							react_jsx_runtime.jsx("button", {
								className: "at-iconbtn",
								"data-testid": "agent-terminal-close",
								title: "Close (Esc)",
								onClick: onClose,
								children: "✕",
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "at-body",
						children: [
							react_jsx_runtime.jsx(NewForm, { onCreate: create }),
							error
								? react_jsx_runtime.jsx("div", { className: "at-error", children: error })
								: null,
							react_jsx_runtime.jsxs("div", {
								className: "at-scroll",
								children: [
									list.length === 0
										? react_jsx_runtime.jsx("div", {
												className: "at-empty",
												children:
													"No terminals yet — allocate one above (dev server, test watcher, REPL…) and steer it from here.",
											})
										: list.map((term) =>
												react_jsx_runtime.jsx(
													TerminalCard,
													{
														term,
														patch: patchTerminal,
														onDiscard: discard,
														onError: (message) => setError(message),
													},
													term.id,
												),
											),
								],
							}),
						],
					}),
				],
			});
		}
		//#endregion

		//#region root
		function Root() {
			const [open, setOpen] = react.useState(false);
			return react_jsx_runtime.jsxs("div", {
				className: "at-root",
				"data-testid": "agent-terminal-root",
				children: [
					open
						? react_jsx_runtime.jsx(Panel, { onClose: () => setOpen(false) })
						: react_jsx_runtime.jsx("button", {
								className: "at-toggle",
								"data-testid": "agent-terminal-toggle",
								title: "Open the Agent Terminal console",
								onClick: () => setOpen(true),
								children: "▮ Terminal",
							}),
				],
			});
		}
		//#endregion

		//#region plugin body
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "agent-terminal",
					},
					Root,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
