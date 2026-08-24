/**
 * @dsh-plugins/command-deck — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form:
 * executing the script only REGISTERS the factory; the body below runs at
 * materialization. Externals are limited to the shell-seeded baseline
 * (`react`, `react/jsx-runtime`). The plugin contributes one entry to the
 * runtime-owned `shell.overlay` slot: a floating toggle chip plus a
 * right-docked Command Deck sidebar to add shell commands, run them on the
 * host, stream their output, and stop them.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/command-deck",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css =
			".cd-root{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#e6e6e6)}" +
			".cd-toggle{position:absolute;right:16px;bottom:16px;z-index:30;display:inline-flex;align-items:center;gap:6px;" +
			"padding:8px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#333);" +
			"background:var(--dsw-specific-menu,#16161a);color:var(--dsw-alias-label-secondary,#bbb);" +
			"box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.4));cursor:pointer;font-size:12px}" +
			".cd-toggle:hover{color:var(--dsw-alias-label-primary,#fff);border-color:var(--dsw-alias-border-l3,#555)}" +
			".cd-panel{position:absolute;top:0;right:0;bottom:0;width:min(400px,90vw);z-index:29;display:flex;flex-direction:column;" +
			"border-left:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-specific-menu,#141417);" +
			"box-shadow:-12px 0 32px rgba(0,0,0,.35);font-family:var(--dsw-font-sans,system-ui,sans-serif)}" +
			".cd-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#333);flex:none}" +
			".cd-title{flex:1;font-weight:600;font-size:13px;letter-spacing:.02em}" +
			".cd-iconbtn{background:none;border:0;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;border-radius:6px;" +
			"padding:4px 6px;font-size:13px;line-height:1}" +
			".cd-iconbtn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-fill-l2,#242428)}" +
			".cd-body{display:flex;flex-direction:column;min-height:0;flex:1;padding:10px 12px 14px;gap:10px;overflow:hidden}" +
			".cd-form{display:flex;flex-direction:column;gap:6px;flex:none}" +
			".cd-input,.cd-textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-fill-l1,#1b1b20);" +
			"color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:8px;" +
			"padding:7px 9px;font-size:12px;outline:none}" +
			".cd-textarea{font-family:var(--dsw-font-mono,ui-monospace,monospace);resize:vertical;min-height:44px;max-height:160px}" +
			".cd-input:focus,.cd-textarea:focus{border-color:var(--dsw-alias-border-l3,#4a4a52)}" +
			".cd-formrow{display:flex;gap:6px;align-items:center}" +
			".cd-addbtn{margin-left:auto;background:#2563eb;border:0;color:#fff;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}" +
			".cd-addbtn:hover{background:#1d4fd8}" +
			".cd-scroll{overflow-y:auto;min-height:0;flex:1;display:flex;flex-direction:column;gap:8px;padding-right:2px}" +
			".cd-sectionlabel{margin:6px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary,#888)}" +
			".cd-card{border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:10px;background:var(--dsw-alias-fill-l1,#191920);padding:8px 10px;display:flex;flex-direction:column;gap:6px}" +
			".cd-cardrow{display:flex;align-items:center;gap:6px}" +
			".cd-name{flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".cd-cmdline{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2);" +
			"white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".cd-runbtn,.cd-stopbtn,.cd-delbtn{border:0;border-radius:7px;padding:4px 10px;font-size:11px;cursor:pointer;flex:none}" +
			".cd-runbtn{background:#0e7a46;color:#d3f5e3}.cd-runbtn:hover{background:#0c9152}" +
			".cd-stopbtn{background:#8a2230;color:#ffd9de}.cd-stopbtn:hover{background:#a52a3b}" +
			".cd-delbtn{background:none;color:var(--dsw-alias-label-tertiary,#777);padding:4px 6px}.cd-delbtn:hover{color:#ff8896}" +
			".cd-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#6b7280}" +
			".cd-dot-running{background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,.8)}" +
			".cd-dot-stopping{background:#eab308}.cd-dot-failed{background:#ef4444}.cd-dot-exited{background:#3f8cff}" +
			".cd-status{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93);white-space:nowrap}" +
			".cd-out{margin:0;padding:8px;background:#0d0d10;border:1px solid #232329;border-radius:8px;" +
			"max-height:220px;overflow:auto;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:16px;" +
			"white-space:pre-wrap;word-break:break-word;color:#cdd6e0}" +
			".cd-empty{color:var(--dsw-alias-label-tertiary,#777);font-size:12px;padding:10px 4px}" +
			".cd-error{color:#ff8896;font-size:11px;white-space:pre-wrap}" +
			".cd-meta{display:flex;align-items:center;gap:8px;min-width:0}";
		const tagId = "@dsh-plugins/command-deck/deck.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/command-deck";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api client
		const API = "/command-deck/api";

		async function apiFetch(path, options) {
			const response = await fetch(API + path, options);
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok) {
				const message = payload?.error
					? payload.error
					: `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload;
		}

		function startRun(command, cwd) {
			return apiFetch("/runs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ command, cwd }),
			});
		}
		function stopRun(id) {
			return apiFetch(`/runs/${id}/stop`, { method: "POST" });
		}
		function discardRun(id) {
			return apiFetch(`/runs/${id}`, { method: "DELETE" });
		}
		function listRuns() {
			return apiFetch("/runs", { method: "GET" });
		}
		function fetchOutput(id, outOffset, errOffset) {
			return apiFetch(`/runs/${id}/output?out=${outOffset}&err=${errOffset}`, {
				method: "GET",
			});
		}
		//#endregion

		//#region storage
		const STORAGE_KEY = "dsh-command-deck.saved.v1";

		function loadSaved() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				const parsed = raw ? JSON.parse(raw) : [];
				if (!Array.isArray(parsed)) return [];
				return parsed
					.filter(
						(item) =>
							item &&
							typeof item.command === "string" &&
							item.command.length > 0,
					)
					.map((item, index) => ({
						id: typeof item.id === "string" ? item.id : `saved-${index}`,
						label:
							typeof item.label === "string" && item.label.trim()
								? item.label.trim()
								: item.command.split("\n")[0],
						command: item.command,
					}));
			} catch {
				return [];
			}
		}

		function persistSaved(commands) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(commands));
			} catch {
				/* private mode: session-only deck */
			}
		}
		//#endregion

		//#region shared bits
		function dotClass(status) {
			if (status === "running") return "cd-dot cd-dot-running";
			if (status === "stopping") return "cd-dot cd-dot-stopping";
			if (status === "failed") return "cd-dot cd-dot-failed";
			return "cd-dot cd-dot-exited";
		}

		function statusText(run) {
			if (run.status === "running") return "running";
			if (run.status === "stopping") return "stopping";
			if (run.status === "failed")
				return `failed${run.error ? `: ${run.error}` : ""}`;
			const exit = run.exit || {};
			if (exit.signal) return `killed (${exit.signal})`;
			if (typeof exit.exitCode === "number")
				return exit.exitCode === 0 ? "done (0)" : `exit ${exit.exitCode}`;
			return "exited";
		}

		const isLiveStatus = (status) =>
			status === "running" || status === "stopping";
		//#endregion

		//#region run card
		function RunCard(props) {
			const run = props.run;
			const onStop = props.onStop;
			const onDiscard = props.onDiscard;
			const outRef = react.useRef(null);
			const live = isLiveStatus(run.status);

			react.useEffect(() => {
				const node = outRef.current;
				if (!node) return;
				node.scrollTop = node.scrollHeight;
			}, [run.outText, run.errText]);

			return react_jsx_runtime.jsxs("div", {
				className: "cd-card",
				"data-testid": `run-card-${run.id}`,
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "cd-cardrow",
						children: [
							react_jsx_runtime.jsx("span", {
								className: dotClass(run.status),
							}),
							react_jsx_runtime.jsx("span", {
								className: "cd-name",
								title: run.label,
								children: run.label,
							}),
							react_jsx_runtime.jsx("span", {
								className: "cd-status",
								children: statusText(run),
							}),
							live
								? react_jsx_runtime.jsx("button", {
										className: "cd-stopbtn",
										"data-testid": `run-stop-btn-${run.id}`,
										onClick: () => onStop(run.id),
										children: "■ Stop",
									})
								: react_jsx_runtime.jsx("button", {
										className: "cd-delbtn",
										"data-testid": `run-discard-btn-${run.id}`,
										title: "Remove from the list",
										onClick: () => onDiscard(run.id),
										children: "✕",
									}),
						],
					}),
					react_jsx_runtime.jsx("div", {
						className: "cd-cmdline",
						title: run.command,
						children: run.command,
					}),
					react_jsx_runtime.jsx("pre", {
						className: "cd-out",
						"data-testid": `run-output-${run.id}`,
						ref: outRef,
						children:
							(run.outText || "") +
							(run.errText ? `\n[stderr]\n${run.errText}` : ""),
					}),
				],
			});
		}
		//#endregion

		//#region saved card
		function SavedCard(props) {
			const saved = props.saved;
			const onRun = props.onRun;
			const onDelete = props.onDelete;
			return react_jsx_runtime.jsxs("div", {
				className: "cd-card",
				"data-testid": `command-card-${saved.id}`,
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "cd-cardrow",
						children: [
							react_jsx_runtime.jsx("span", {
								className: "cd-name",
								title: saved.label,
								children: saved.label,
							}),
							react_jsx_runtime.jsx("button", {
								className: "cd-runbtn",
								"data-testid": `command-run-btn-${saved.id}`,
								onClick: () => onRun(saved),
								children: "▶ Run",
							}),
							react_jsx_runtime.jsx("button", {
								className: "cd-delbtn",
								"data-testid": `command-delete-btn-${saved.id}`,
								title: "Delete saved command",
								onClick: () => onDelete(saved.id),
								children: "🗑",
							}),
						],
					}),
					react_jsx_runtime.jsx("div", {
						className: "cd-cmdline",
						title: saved.command,
						children: saved.command,
					}),
				],
			});
		}
		//#endregion

		//#region add form
		function AddForm(props) {
			const onAdd = props.onAdd;
			const labelRef = react.useRef(null);
			const commandRef = react.useRef(null);

			const submit = () => {
				const command = commandRef.current
					? commandRef.current.value.trim()
					: "";
				const label = labelRef.current ? labelRef.current.value.trim() : "";
				if (!command) return;
				onAdd(label || command.split("\n")[0], command);
				if (labelRef.current) labelRef.current.value = "";
				if (commandRef.current) commandRef.current.value = "";
			};

			return react_jsx_runtime.jsxs("form", {
				className: "cd-form",
				"data-testid": "command-deck-add-form",
				onSubmit: (event) => {
					event.preventDefault();
					submit();
				},
				children: [
					react_jsx_runtime.jsx("input", {
						ref: labelRef,
						className: "cd-input",
						"data-testid": "command-deck-label-input",
						placeholder: "Name (optional)",
						spellCheck: false,
					}),
					react_jsx_runtime.jsx("textarea", {
						ref: commandRef,
						className: "cd-textarea",
						"data-testid": "command-deck-command-input",
						placeholder: "Shell command…",
						spellCheck: false,
						onKeyDown: (event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								submit();
							}
						},
					}),
					react_jsx_runtime.jsxs("div", {
						className: "cd-formrow",
						children: [
							react_jsx_runtime.jsx("span", {
								className: "cd-status",
								children: "Saved locally · runs on the harness host",
							}),
							react_jsx_runtime.jsx("button", {
								type: "submit",
								className: "cd-addbtn",
								"data-testid": "command-deck-add-btn",
								children: "+ Add",
							}),
						],
					}),
				],
			});
		}
		//#endregion

		//#region panel
		function Panel(props) {
			const onClose = props.onClose;
			const [savedCommands, setSavedCommands] = react.useState(loadSaved);
			const [runs, setRuns] = react.useState({});
			const [error, setError] = react.useState("");
			const runsRef = react.useRef(runs);
			runsRef.current = runs;

			const patchRun = react.useCallback((id, patch) => {
				setRuns((previous) => {
					const current = previous[id];
					if (!current) return previous;
					return Object.assign({}, previous, {
						[id]: Object.assign({}, current, patch),
					});
				});
			}, []);

			const putRun = react.useCallback((meta) => {
				setRuns((previous) =>
					Object.assign({}, previous, {
						[meta.id]: Object.assign(
							{ outText: "", errText: "", outOffset: 0, errOffset: 0 },
							previous[meta.id],
							meta,
						),
					}),
				);
			}, []);

			// Adopt still-running host runs left over from a page reload.
			react.useEffect(() => {
				let cancelled = false;
				listRuns()
					.then((payload) => {
						if (cancelled) return;
						for (const meta of payload.runs || []) {
							if (isLiveStatus(meta.status) && !runsRef.current[meta.id])
								putRun(meta);
						}
					})
					.catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [putRun]);

			// Poll deltas for every known run while the panel is open.
			react.useEffect(() => {
				const ids = Object.keys(runsRef.current);
				if (ids.length === 0) return undefined;
				const timer = window.setInterval(() => {
					for (const id of Object.keys(runsRef.current)) {
						const run = runsRef.current[id];
						fetchOutput(id, run.outOffset, run.errOffset)
							.then((payload) => {
								const patch = {
									status: payload.status,
									exit: payload.exit,
									error: payload.error,
									pid: payload.pid,
									outOffset: payload.out
										? payload.out.nextOffset
										: run.outOffset,
									errOffset: payload.err
										? payload.err.nextOffset
										: run.errOffset,
									outText: (
										run.outText + (payload.out ? payload.out.text : "")
									).slice(-200_000),
									errText: (
										run.errText + (payload.err ? payload.err.text : "")
									).slice(-200_000),
								};
								patchRun(id, patch);
							})
							.catch(() => {});
					}
				}, 900);
				return () => window.clearInterval(timer);
				// Re-arm the polling loop whenever the set of runs changes size.
			}, [Object.keys(runs).length, patchRun]);

			// Escape closes the panel.
			react.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);

			const runCommand = async (saved) => {
				setError("");
				try {
					const created = await startRun(saved.command);
					putRun(created);
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			const addSaved = (label, command) => {
				const entry = {
					id: window.crypto?.randomUUID
						? window.crypto.randomUUID()
						: `saved-${Date.now()}`,
					label,
					command,
				};
				const next = [entry].concat(savedCommands);
				setSavedCommands(next);
				persistSaved(next);
			};

			const deleteSaved = (id) => {
				const next = savedCommands.filter((item) => item.id !== id);
				setSavedCommands(next);
				persistSaved(next);
			};

			const stop = async (id) => {
				try {
					await stopRun(id);
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			const discard = async (id) => {
				try {
					await discardRun(id);
					setRuns((previous) => {
						const next = Object.assign({}, previous);
						delete next[id];
						return next;
					});
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			const runList = Object.values(runs).sort(
				(a, b) => b.startedAt - a.startedAt,
			);

			return react_jsx_runtime.jsxs("div", {
				className: "cd-panel",
				"data-testid": "command-deck-panel",
				children: [
					react_jsx_runtime.jsxs("header", {
						className: "cd-header",
						children: [
							react_jsx_runtime.jsx("span", { children: "⚡" }),
							react_jsx_runtime.jsx("span", {
								className: "cd-title",
								children: "Command Deck",
							}),
							react_jsx_runtime.jsx("button", {
								className: "cd-iconbtn",
								"data-testid": "command-deck-close",
								title: "Close (Esc)",
								onClick: onClose,
								children: "✕",
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "cd-body",
						children: [
							react_jsx_runtime.jsx(AddForm, { onAdd: addSaved }),
							error
								? react_jsx_runtime.jsx("div", {
										className: "cd-error",
										children: error,
									})
								: null,
							react_jsx_runtime.jsxs("div", {
								className: "cd-scroll",
								children: [
									react_jsx_runtime.jsx("h3", {
										className: "cd-sectionlabel",
										children: "Commands",
									}),
									savedCommands.length === 0
										? react_jsx_runtime.jsx("div", {
												className: "cd-empty",
												children: "No saved commands yet — add one above.",
											})
										: savedCommands.map((saved) =>
												react_jsx_runtime.jsx(
													SavedCard,
													{ saved, onRun: runCommand, onDelete: deleteSaved },
													saved.id,
												),
											),
									runList.length > 0
										? react_jsx_runtime.jsx("h3", {
												className: "cd-sectionlabel",
												"data-testid": "command-deck-runs",
												children: "Runs",
											})
										: null,
									runList.map((run) =>
										react_jsx_runtime.jsx(
											RunCard,
											{ run, onStop: stop, onDiscard: discard },
											run.id,
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
				className: "cd-root",
				"data-testid": "command-deck-root",
				children: [
					open
						? react_jsx_runtime.jsx(Panel, { onClose: () => setOpen(false) })
						: react_jsx_runtime.jsx("button", {
								className: "cd-toggle",
								"data-testid": "command-deck-toggle",
								title: "Open the Command Deck",
								onClick: () => setOpen(true),
								children: "⚡ Command Deck",
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
						id: "command-deck",
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
