/**
 * @dsh-plugins/mission-control — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form:
 * executing the script only REGISTERS the factory; the body below runs at
 * materialization. Externals are limited to the shell-seeded baseline
 * (`react`, `react/jsx-runtime`). The plugin contributes one entry to the
 * runtime-owned `shell.overlay` slot: a floating toggle chip plus a
 * left-docked Mission Control inbox — GitHub items needing attention, each
 * hand-offable to a running agent session, and a registry of launched
 * sessions with a one-line nudge input.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/mission-control",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css =
			".mc-root{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#e6e6e6)}" +
			".mc-toggle{position:absolute;left:16px;bottom:16px;z-index:30;display:inline-flex;align-items:center;gap:6px;" +
			"padding:8px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#333);" +
			"background:var(--dsw-specific-menu,#16161a);color:var(--dsw-alias-label-secondary,#bbb);" +
			"box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.4));cursor:pointer;font-size:12px}" +
			".mc-toggle:hover{color:var(--dsw-alias-label-primary,#fff);border-color:var(--dsw-alias-border-l3,#555)}" +
			".mc-panel{position:absolute;top:0;left:0;bottom:0;width:min(430px,90vw);z-index:29;display:flex;flex-direction:column;" +
			"border-right:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-specific-menu,#141417);" +
			"box-shadow:12px 0 32px rgba(0,0,0,.35);font-family:var(--dsw-font-sans,system-ui,sans-serif)}" +
			".mc-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#333);flex:none}" +
			".mc-title{flex:1;font-weight:600;font-size:13px;letter-spacing:.02em}" +
			".mc-iconbtn{background:none;border:0;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;border-radius:6px;" +
			"padding:4px 6px;font-size:13px;line-height:1}" +
			".mc-iconbtn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-fill-l2,#242428)}" +
			".mc-body{display:flex;flex-direction:column;min-height:0;flex:1;padding:10px 12px 14px;gap:10px;overflow:hidden}" +
			".mc-formrow{display:flex;gap:6px;align-items:center;flex:none}" +
			".mc-input{flex:1;min-width:0;box-sizing:border-box;background:var(--dsw-alias-fill-l1,#1b1b20);" +
			"color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:8px;" +
			"padding:7px 9px;font-size:12px;outline:none}" +
			".mc-input:focus{border-color:var(--dsw-alias-border-l3,#4a4a52)}" +
			".mc-btn{border:0;border-radius:7px;padding:5px 10px;font-size:11px;cursor:pointer;flex:none}" +
			".mc-btn-refresh{background:#1f2937;color:#cbd5e1}.mc-btn-refresh:hover{background:#2b3648}" +
			".mc-handoff{background:#2563eb;color:#fff;margin-left:auto}.mc-handoff:hover{background:#1d4fd8}" +
			".mc-scroll{overflow-y:auto;min-height:0;flex:1;display:flex;flex-direction:column;gap:8px;padding-right:2px}" +
			".mc-sectionlabel{margin:6px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary,#888)}" +
			".mc-count{color:#67e8f9;font-weight:600}" +
			".mc-card{border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:10px;background:var(--dsw-alias-fill-l1,#191920);padding:8px 10px;display:flex;flex-direction:column;gap:5px}" +
			".mc-itemtitle{font-weight:500;font-size:12px;line-height:16px;color:inherit;text-decoration:none;display:block;" +
			"white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".mc-itemtitle:hover{text-decoration:underline}" +
			".mc-meta{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}" +
			".mc-repo{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2);" +
			"white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".mc-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#333);flex:none}" +
			".mc-badge-approved{color:#86efac;border-color:#14532d}.mc-badge-changes{color:#fda4af;border-color:#7f1d1d}" +
			".mc-badge-review{color:#cbd5e1;border-color:#334155}.mc-badge-draft{color:#fde68a;border-color:#78350f}" +
			".mc-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#6b7280}" +
			".mc-dot-ok{background:#22c55e}.mc-dot-bad{background:#ef4444}.mc-dot-wait{background:#eab308}" +
			".mc-errorline{color:#ff8896;font-size:11px;white-space:pre-wrap}" +
			".mc-error{color:#ff8896;font-size:11px;white-space:pre-wrap}" +
			".mc-empty{color:var(--dsw-alias-label-tertiary,#777);font-size:12px;padding:6px 4px}" +
			".mc-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".mc-nudgeinput{flex:1;min-width:0;background:var(--dsw-alias-fill-l1,#101014);color:var(--dsw-alias-label-primary,#ddd);" +
			"border:1px solid var(--dsw-alias-border-l1,#26262c);border-radius:7px;padding:4px 8px;font-size:11px;outline:none}" +
			".mc-sendbtn{background:#0e7a46;color:#d3f5e5}.mc-sendbtn:hover{background:#0c9152}" +
			".mc-delbtn{background:none;color:var(--dsw-alias-label-tertiary,#777);padding:4px 6px}.mc-delbtn:hover{color:#ff8896}";
		const tagId = "@dsh-plugins/mission-control/inbox.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/mission-control";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api client
		const API = "/mission-control/api";

		async function apiFetch(path, options) {
			const response = await fetch(API + path, options);
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok) {
				throw new Error(payload?.error ? payload.error : `HTTP ${response.status}`);
			}
			return payload;
		}

		function fetchInbox() {
			return apiFetch("/inbox", { method: "GET" });
		}
		function fetchRuns() {
			return apiFetch("/runs", { method: "GET" });
		}
		function handoff(item, cwd) {
			return apiFetch("/handoff", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ item, cwd }),
			});
		}
		function nudgeRun(id, message) {
			return apiFetch(`/runs/${id}/nudge`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message }),
			});
		}
		function discardRun(id) {
			return apiFetch(`/runs/${id}`, { method: "DELETE" });
		}
		//#endregion

		//#region storage
		const CWD_KEY = "dsh-mission-control.cwd.v1";

		function loadCwd() {
			try {
				return window.localStorage.getItem(CWD_KEY) || "";
			} catch {
				return "";
			}
		}

		function persistCwd(value) {
			try {
				window.localStorage.setItem(CWD_KEY, value);
			} catch {
				/* private mode */
			}
		}
		//#endregion

		//#region badges
		function checkDot(status) {
			if (status === "SUCCESS") return "mc-dot mc-dot-ok";
			if (status === "FAILURE") return "mc-dot mc-dot-bad";
			if (status === "PENDING") return "mc-dot mc-dot-wait";
			return "mc-dot";
		}

		const CHECK_TITLES = {
			SUCCESS: "checks passing",
			FAILURE: "checks failing",
			PENDING: "checks pending",
		};

		function reviewBadge(decision) {
			if (!decision) return null;
			const cls =
				decision === "APPROVED"
					? "mc-badge mc-badge-approved"
					: decision === "CHANGES_REQUESTED"
						? "mc-badge mc-badge-changes"
						: "mc-badge mc-badge-review";
			const labels = {
				APPROVED: "approved",
				CHANGES_REQUESTED: "changes requested",
				REVIEW_REQUIRED: "review required",
			};
			return react_jsx_runtime.jsx("span", {
				className: cls,
				children: labels[decision] ?? decision.toLowerCase(),
			});
		}
		//#endregion

		//#region item card
		function ItemCard(props) {
			const item = props.item;
			const busy = props.busy;
			const onHandoff = props.onHandoff;
			return react_jsx_runtime.jsxs("div", {
				className: "mc-card",
				"data-testid": `mc-item-${item.kind}-${item.number}`,
				children: [
					react_jsx_runtime.jsx("a", {
						className: "mc-itemtitle",
						href: item.url,
						target: "_blank",
						rel: "noreferrer",
						title: item.title,
						children: item.title,
					}),
					react_jsx_runtime.jsxs("div", {
						className: "mc-meta",
						children: [
							item.checkStatus
								? react_jsx_runtime.jsx("span", {
										className: checkDot(item.checkStatus),
										title: CHECK_TITLES[item.checkStatus] ?? "checks",
									})
								: null,
							react_jsx_runtime.jsx("span", {
								className: "mc-repo",
								title: `${item.repo ?? "?"}#${item.number}`,
								children: `${item.repo ?? "?"}#${item.number}`,
							}),
							item.isDraft
								? react_jsx_runtime.jsx("span", {
										className: "mc-badge mc-badge-draft",
										children: "draft",
									})
								: null,
							reviewBadge(item.reviewDecision),
							react_jsx_runtime.jsx("button", {
								className: "mc-btn mc-handoff",
								"data-testid": `mc-handoff-${item.kind}-${item.number}`,
								disabled: busy || !props.launchable,
								title: props.launchable
									? "Cut an isolated worktree and launch an agent session scoped to this item"
									: "The harness 'agents' service is unavailable",
								onClick: () => onHandoff(item),
								children: "→ Hand off",
							}),
						],
					}),
				],
			});
		}
		//#endregion

		//#region run card
		function RunCard(props) {
			const run = props.run;
			const inputRef = react.useRef(null);
			const kindIcon = run.kind === "pr" ? "⇄" : "◎";
			return react_jsx_runtime.jsxs("div", {
				className: "mc-card",
				"data-testid": `mc-run-${run.id}`,
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "mc-meta",
						children: [
							react_jsx_runtime.jsx("span", { children: kindIcon }),
							react_jsx_runtime.jsx("span", {
								className: "mc-repo",
								children: `${run.item.repo ?? "?"}#${run.item.number}`,
							}),
							react_jsx_runtime.jsx("span", {
								className: "mc-note",
								title: `${run.item.title} — ${run.branch}`,
								children: run.item.title,
							}),
							react_jsx_runtime.jsx("button", {
								className: "mc-delbtn",
								"data-testid": `mc-forget-${run.id}`,
								title: "Forget this launched session",
								onClick: () => props.onDiscard(run.id),
								children: "✕",
							}),
						],
					}),
					run.baseNote
						? react_jsx_runtime.jsx("div", {
								className: "mc-note",
								children: run.baseNote,
							})
						: null,
					react_jsx_runtime.jsxs("div", {
						className: "mc-formrow",
						children: [
							react_jsx_runtime.jsx("input", {
								ref: inputRef,
								className: "mc-nudgeinput",
								"data-testid": `mc-nudge-input-${run.id}`,
								placeholder: "Nudge this session…",
								spellCheck: false,
								onKeyDown: (event) => {
									if (event.key === "Enter") {
										const value = inputRef.current?.value?.trim();
										if (value) {
											props.onNudge(run.id, value);
											if (inputRef.current) inputRef.current.value = "";
										}
									}
								},
							}),
							react_jsx_runtime.jsx("button", {
								className: "mc-btn mc-sendbtn",
								onClick: () => {
									const value = inputRef.current?.value?.trim();
									if (value) {
										props.onNudge(run.id, value);
										if (inputRef.current) inputRef.current.value = "";
									}
								},
								children: "Send",
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
			const [cwd, setCwd] = react.useState(loadCwd);
			const [inbox, setInbox] = react.useState(null);
			const [runs, setRuns] = react.useState([]);
			const [launchable, setLaunchable] = react.useState(false);
			const [error, setError] = react.useState("");
			const [busyItem, setBusyItem] = react.useState("");

			const refreshRuns = react.useCallback(() => {
				fetchRuns()
					.then((payload) => {
						setRuns(payload.runs ?? []);
						setLaunchable(payload.launchable === true);
					})
					.catch((err) => setError(String(err.message || err)));
			}, []);

			const refreshInbox = react.useCallback(
				(nextCwd) => {
					setError("");
					fetchInbox()
						.then((payload) => setInbox(payload))
						.catch((err) => {
							setInbox({ sections: [], launchable: false, generatedAt: Date.now() });
							setError(String(err.message || err));
						});
					void nextCwd;
				},
				[],
			);

			react.useEffect(() => {
				refreshInbox(loadCwd());
				refreshRuns();
			}, [refreshInbox, refreshRuns]);

			// Escape closes the panel.
			react.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);

			const applyCwd = () => {
				persistCwd(cwd.trim());
			};

			const doHandoff = async (item) => {
				setBusyItem(`${item.kind}:${item.number}`);
				setError("");
				try {
					await handoff({ kind: item.kind, url: item.url }, cwd.trim());
					applyCwd();
					refreshRuns();
				} catch (err) {
					setError(String(err.message || err));
				} finally {
					setBusyItem("");
				}
			};

			const doNudge = async (id, message) => {
				setError("");
				try {
					await nudgeRun(id, message);
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			const doDiscard = async (id) => {
				setError("");
				try {
					await discardRun(id);
					refreshRuns();
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			const sections = inbox?.sections ?? [];

			return react_jsx_runtime.jsxs("div", {
				className: "mc-panel",
				"data-testid": "mission-control-panel",
				children: [
					react_jsx_runtime.jsxs("header", {
						className: "mc-header",
						children: [
							react_jsx_runtime.jsx("span", { children: "🗂" }),
							react_jsx_runtime.jsx("span", {
								className: "mc-title",
								children: "Mission Control",
							}),
							react_jsx_runtime.jsx("button", {
								className: "mc-iconbtn",
								"data-testid": "mission-control-close",
								title: "Close (Esc)",
								onClick: onClose,
								children: "✕",
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "mc-body",
						children: [
							react_jsx_runtime.jsxs("div", {
								className: "mc-formrow",
								children: [
									react_jsx_runtime.jsx("input", {
										className: "mc-input",
										"data-testid": "mission-control-cwd",
										value: cwd,
										placeholder: "Local checkout of your GitHub repos…",
										spellCheck: false,
										onChange: (event) => setCwd(event.target.value),
										onBlur: applyCwd,
									}),
									react_jsx_runtime.jsx("button", {
										className: "mc-btn mc-btn-refresh",
										"data-testid": "mission-control-refresh",
										title: "Re-read the inbox",
										onClick: () => {
											applyCwd();
											refreshInbox(cwd);
											refreshRuns();
										},
										children: "⟳",
									}),
								],
							}),
							error
								? react_jsx_runtime.jsx("div", {
										className: "mc-error",
										children: error,
									})
								: null,
							react_jsx_runtime.jsxs("div", {
								className: "mc-scroll",
								children: [
									sections.map((section) =>
										react_jsx_runtime.jsxs(
											"div",
											{
												children: [
													react_jsx_runtime.jsxs("h3", {
														className: "mc-sectionlabel",
														children: [
															section.name,
															" ",
															react_jsx_runtime.jsx("span", {
																className: "mc-count",
																children: section.error ? "!" : String(section.items.length),
															}),
														],
													}),
													section.error
														? react_jsx_runtime.jsx("div", {
																className: "mc-errorline",
																children: section.error,
															})
														: null,
													!section.error && section.items.length === 0
														? react_jsx_runtime.jsx("div", {
																className: "mc-empty",
																children: "Nothing waiting here.",
															})
														: section.items.map((item) =>
																react_jsx_runtime.jsx(
																	ItemCard,
																	{
																		item,
																		busy: busyItem !== "",
																		launchable,
																		onHandoff: doHandoff,
																	},
																	`${item.kind}-${item.url}`,
																),
															),
												],
											},
											section.name,
										),
									),
									inbox === null
										? react_jsx_runtime.jsx("div", {
												className: "mc-empty",
												children: "Reading the inbox…",
											})
										: null,
									react_jsx_runtime.jsx("h3", {
										className: "mc-sectionlabel",
										"data-testid": "mission-control-runs",
										children: ["Sessions launched ", react_jsx_runtime.jsx("span", { className: "mc-count", children: String(runs.length) })],
									}),
									runs.length === 0
										? react_jsx_runtime.jsx("div", {
												className: "mc-empty",
												children: "No sessions launched from the inbox yet.",
											})
										: runs.map((run) =>
												react_jsx_runtime.jsx(
													RunCard,
													{ run, onNudge: doNudge, onDiscard: doDiscard },
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
				className: "mc-root",
				"data-testid": "mission-control-root",
				children: [
					open
						? react_jsx_runtime.jsx(Panel, { onClose: () => setOpen(false) })
						: react_jsx_runtime.jsx("button", {
								className: "mc-toggle",
								"data-testid": "mission-control-toggle",
								title: "Open Mission Control",
								onClick: () => setOpen(true),
								children: "🗂 Mission Control",
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
						id: "mission-control",
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
