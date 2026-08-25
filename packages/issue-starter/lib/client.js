/**
 * @dsh-plugins/issue-starter — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form:
 * executing the script only REGISTERS the factory; the body runs at
 * materialization. Externals are limited to the shell-seeded baseline
 * (`react`, `react/jsx-runtime`). The plugin contributes one entry to the
 * runtime-owned `shell.overlay` slot: a floating chip plus a right-docked
 * panel to preview a GitHub issue and launch an isolated agent session for it.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/issue-starter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css =
			".is-root{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#e6e6e6)}" +
			".is-toggle{position:absolute;left:16px;bottom:56px;z-index:30;display:inline-flex;align-items:center;gap:6px;" +
			"padding:8px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#333);" +
			"background:var(--dsw-specific-menu,#16161a);color:var(--dsw-alias-label-secondary,#bbb);" +
			"box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.4));cursor:pointer;font-size:12px}" +
			".is-toggle:hover{color:var(--dsw-alias-label-primary,#fff);border-color:var(--dsw-alias-border-l3,#555)}" +
			".is-panel{position:absolute;top:0;right:0;bottom:0;width:min(480px,94vw);z-index:29;display:flex;flex-direction:column;" +
			"border-left:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-specific-menu,#141417);" +
			"box-shadow:-12px 0 32px rgba(0,0,0,.35);font-family:var(--dsw-font-sans,system-ui,sans-serif)}" +
			".is-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#333);flex:none}" +
			".is-title{flex:1;font-weight:600;font-size:13px;letter-spacing:.02em}" +
			".is-iconbtn{background:none;border:0;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;border-radius:6px;" +
			"padding:4px 6px;font-size:13px;line-height:1}" +
			".is-iconbtn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-fill-l2,#242428)}" +
			".is-body{display:flex;flex-direction:column;min-height:0;flex:1;padding:10px 12px 14px;gap:10px;overflow:hidden}" +
			".is-form{display:flex;flex-direction:column;gap:6px;flex:none}" +
			".is-input,.is-textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-fill-l1,#1b1b20);" +
			"color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:8px;" +
			"padding:7px 9px;font-size:12px;outline:none}" +
			".is-input:focus{border-color:var(--dsw-alias-border-l3,#4a4a52)}" +
			".is-row{display:flex;gap:6px;align-items:center}" +
			".is-btn{border:0;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}" +
			".is-secondarybtn{background:var(--dsw-alias-fill-l2,#242428);color:var(--dsw-alias-label-primary,#ddd)}" +
			".is-secondarybtn:hover{background:#2c2c33}" +
			".is-launchbtn{margin-left:auto;background:#0e7a46;color:#d3f5e3}.is-launchbtn:hover{background:#0c9152}" +
			".is-launchbtn:disabled{opacity:.5;cursor:not-allowed}" +
			".is-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93)}" +
			".is-scroll{overflow-y:auto;min-height:0;flex:1;display:flex;flex-direction:column;gap:10px;padding-right:2px}" +
			".is-card{border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:10px;background:var(--dsw-alias-fill-l1,#191920);" +
			"padding:8px 10px;display:flex;flex-direction:column;gap:6px}" +
			".is-issue-title{font-weight:600;font-size:13px}" +
			".is-issue-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap}" +
			".is-label{font-size:10px;border-radius:999px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2,#333);" +
			"color:var(--dsw-alias-label-secondary,#aaa)}" +
			".is-issue-body{max-height:120px;overflow:auto;font-size:11px;line-height:16px;white-space:pre-wrap;" +
			"word-break:break-word;color:var(--dsw-alias-label-secondary,#b8b8c0)}" +
			".is-runname{flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".is-runmeta{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:10px;" +
			"color:var(--dsw-alias-label-tertiary,#9a9aa2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".is-delbtn{background:none;color:var(--dsw-alias-label-tertiary,#777);border:0;padding:4px 6px;cursor:pointer}" +
			".is-delbtn:hover{color:#ff8896}" +
			".is-error{color:#ff8896;font-size:11px;white-space:pre-wrap}" +
			".is-success{color:#7ce38b;font-size:11px}" +
			".is-empty{color:var(--dsw-alias-label-tertiary,#777);font-size:12px;padding:10px 4px}" +
			".is-sectionlabel{margin:2px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary,#888)}";
		const tagId = "@dsh-plugins/issue-starter/panel.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/issue-starter";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api client
		const API = "/issue-starter/api";

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

		function previewIssue(body) {
			return apiFetch("/issues/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		}
		function startFromIssue(body) {
			return apiFetch("/issues/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		}
		function listRuns() {
			return apiFetch("/runs", { method: "GET" });
		}
		function discardRun(id) {
			return apiFetch(`/runs/${id}`, { method: "DELETE" });
		}
		//#endregion

		//#region storage
		const FORM_KEY = "dsh-issue-starter.form.v1";
		function readFormMemory() {
			try {
				const raw = window.localStorage.getItem(FORM_KEY);
				const parsed = raw ? JSON.parse(raw) : {};
				return parsed && typeof parsed === "object" ? parsed : {};
			} catch {
				return {};
			}
		}
		function writeFormMemory(patch) {
			try {
				window.localStorage.setItem(
					FORM_KEY,
					JSON.stringify(Object.assign(readFormMemory(), patch)),
				);
			} catch {
				/* private mode */
			}
		}
		//#endregion

		//#region launch form
		function LaunchForm(props) {
			const memory = react.useMemo(readFormMemory, []);
			const cwdRef = react.useRef(null);
			const issueRef = react.useRef(null);
			const repoRef = react.useRef(null);
			const providerRef = react.useRef(null);
			const modelRef = react.useRef(null);
			const [preview, setPreview] = react.useState(props.preview);
			const [busy, setBusy] = react.useState("");

			const formBody = () => ({
				cwd: cwdRef.current?.value?.trim() || undefined,
				issue: issueRef.current?.value?.trim(),
				repo: repoRef.current?.value?.trim() || undefined,
			});

			const remember = () =>
				writeFormMemory({
					cwd: cwdRef.current?.value ?? "",
					repo: repoRef.current?.value ?? "",
				});

			const doPreview = async () => {
				setBusy("preview");
				props.onClearMessages();
				try {
					const payload = await previewIssue(formBody());
					setPreview(payload.issue);
					remember();
				} catch (err) {
					props.onError(String(err.message || err));
				} finally {
					setBusy("");
				}
			};

			const doLaunch = async () => {
				setBusy("launch");
				props.onClearMessages();
				const body = formBody();
				const provider = providerRef.current?.value?.trim();
				const model = modelRef.current?.value?.trim();
				if (provider && model) body.model = { provider, model };
				try {
					const created = await startFromIssue(body);
					remember();
					props.onLaunched(created);
					setPreview(null);
					if (issueRef.current) issueRef.current.value = "";
				} catch (err) {
					props.onError(String(err.message || err));
				} finally {
					setBusy("");
				}
			};

			return react_jsx_runtime.jsxs("form", {
				className: "is-form",
				"data-testid": "issue-starter-form",
				onSubmit: (event) => {
					event.preventDefault();
					void doLaunch();
				},
				children: [
					react_jsx_runtime.jsx("input", {
						ref: cwdRef,
						className: "is-input",
						"data-testid": "issue-starter-cwd-input",
						placeholder: "Repository directory (default: harness cwd)",
						defaultValue: typeof memory.cwd === "string" ? memory.cwd : "",
						spellCheck: false,
					}),
					react_jsx_runtime.jsxs("div", {
						className: "is-row",
						children: [
							react_jsx_runtime.jsx("input", {
								ref: issueRef,
								className: "is-input",
								"data-testid": "issue-starter-ref-input",
								placeholder: "Issue number or …/issues/123 URL",
								spellCheck: false,
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "is-btn is-secondarybtn",
								"data-testid": "issue-starter-preview-btn",
								disabled: busy !== "",
								onClick: () => void doPreview(),
								children: busy === "preview" ? "…" : "Preview",
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "is-row",
						children: [
							react_jsx_runtime.jsx("input", {
								ref: repoRef,
								className: "is-input",
								"data-testid": "issue-starter-repo-input",
								placeholder: "owner/repo (optional gh -R override)",
								defaultValue: typeof memory.repo === "string" ? memory.repo : "",
								spellCheck: false,
							}),
						],
					}),
					preview
						? react_jsx_runtime.jsxs("div", {
								className: "is-card",
								"data-testid": "issue-starter-preview",
								children: [
									react_jsx_runtime.jsx("span", {
										className: "is-issue-title",
										children: `#${preview.number} · ${preview.title}`,
									}),
									Array.isArray(preview.labels) && preview.labels.length > 0
										? react_jsx_runtime.jsx(
												"div",
												{
													className: "is-issue-meta",
													children: preview.labels.map((label, index) =>
														react_jsx_runtime.jsx(
															"span",
															{
																className: "is-label",
																children:
																	typeof label === "string" ? label : label?.name ?? "?",
															},
															index,
														),
													),
												},
										  )
										: null,
									react_jsx_runtime.jsx("pre", {
										className: "is-issue-body",
										children: preview.body || "(empty body)",
									}),
								],
						  })
						: null,
					react_jsx_runtime.jsxs("div", {
						className: "is-row",
						children: [
							react_jsx_runtime.jsx("input", {
								ref: providerRef,
								className: "is-input",
								"data-testid": "issue-starter-provider-input",
								placeholder: "Provider (optional)",
								spellCheck: false,
							}),
							react_jsx_runtime.jsx("input", {
								ref: modelRef,
								className: "is-input",
								"data-testid": "issue-starter-model-input",
								placeholder: "Model (optional)",
								spellCheck: false,
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "is-row",
						children: [
							react_jsx_runtime.jsx("span", {
								className: "is-hint",
								children:
									"Cuts an isolated worktree branch from an up-to-date base, then launches the session there.",
							}),
							react_jsx_runtime.jsx("button", {
								type: "submit",
								className: "is-btn is-launchbtn",
								"data-testid": "issue-starter-launch-btn",
								disabled: busy !== "",
								children: busy === "launch" ? "Launching…" : "🚀 Launch session",
							}),
						],
					}),
				],
			});
		}
		//#endregion

		//#region runs list
		function RunCard(props) {
			const run = props.run;
			return react_jsx_runtime.jsxs("div", {
				className: "is-card",
				"data-testid": `issue-starter-run-${run.id}`,
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "is-row",
						children: [
							react_jsx_runtime.jsx("span", {
								className: "is-runname",
								title: run.issue?.title ?? "",
								children: `#${run.issue?.number} · ${run.issue?.title ?? ""}`,
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "is-delbtn",
								"title": "Forget this entry (the session itself keeps running)",
								onClick: () => props.onDiscard(run.id),
								children: "✕",
							}),
						],
					}),
					react_jsx_runtime.jsx("span", {
						className: "is-runmeta",
						title: `${run.branch} @ ${run.worktreePath}`,
						children: `${run.branch} · ${run.worktreePath}${run.baseNote ? ` · ${run.baseNote}` : ""}`,
					}),
				],
			});
		}
		//#endregion

		//#region panel
		function Panel(props) {
			const onClose = props.onClose;
			const [runs, setRuns] = react.useState([]);
			const [error, setError] = react.useState("");
			const [success, setSuccess] = react.useState("");

			const clearMessages = () => {
				setError("");
				setSuccess("");
			};

			// Load the registry snapshot once per open (the host keeps it across reloads).
			react.useEffect(() => {
				let cancelled = false;
				listRuns()
					.then((payload) => {
						if (!cancelled) setRuns(Array.isArray(payload.runs) ? payload.runs : []);
					})
					.catch(() => {});
				return () => {
					cancelled = true;
				};
			}, []);

			react.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);

			const onError = (message) => {
				setError(message);
				setSuccess("");
			};

			const onLaunched = (created) => {
				setError("");
				setSuccess(`Session launched — open it from the sidebar (${created.branch}).`);
				setRuns((previous) => [created, ...previous]);
			};

			const discard = async (id) => {
				try {
					await discardRun(id);
					setRuns((previous) => previous.filter((run) => run.id !== id));
				} catch (err) {
					onError(String(err.message || err));
				}
			};

			return react_jsx_runtime.jsxs("div", {
				className: "is-panel",
				"data-testid": "issue-starter-panel",
				children: [
					react_jsx_runtime.jsxs("header", {
						className: "is-header",
						children: [
							react_jsx_runtime.jsx("span", { children: "🐙" }),
							react_jsx_runtime.jsx("span", {
								className: "is-title",
								children: "Issues → Sessions",
							}),
							react_jsx_runtime.jsx("button", {
								className: "is-iconbtn",
								"data-testid": "issue-starter-close",
								title: "Close (Esc)",
								onClick: onClose,
								children: "✕",
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "is-body",
						children: [
							error ? react_jsx_runtime.jsx("div", { className: "is-error", children: error }) : null,
							success
								? react_jsx_runtime.jsx("div", { className: "is-success", children: success })
								: null,
							react_jsx_runtime.jsx(LaunchForm, {
								onError,
								onLaunched,
								onClearMessages: clearMessages,
							}),
							react_jsx_runtime.jsx("h3", { className: "is-sectionlabel", children: "Launched" }),
							react_jsx_runtime.jsxs("div", {
								className: "is-scroll",
								children: [
									runs.length === 0
										? react_jsx_runtime.jsx("div", {
												className: "is-empty",
												children: "Nothing launched yet.",
											})
										: runs.map((run) =>
												react_jsx_runtime.jsx(RunCard, { run, onDiscard: discard }, run.id),
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
				className: "is-root",
				"data-testid": "issue-starter-root",
				children: [
					open
						? react_jsx_runtime.jsx(Panel, { onClose: () => setOpen(false) })
						: react_jsx_runtime.jsx("button", {
								className: "is-toggle",
								"data-testid": "issue-starter-toggle",
								title: "Launch an agent session from a GitHub issue",
								onClick: () => setOpen(true),
								children: "🐙 Issues",
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
						id: "issue-starter",
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
