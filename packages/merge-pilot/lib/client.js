/**
 * @dsh-plugins/merge-pilot — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form:
 * executing the script only REGISTERS the factory; the body below runs at
 * materialization. Externals are limited to the shell-seeded baseline
 * (`react`, `react/jsx-runtime`). The plugin contributes one entry to the
 * runtime-owned `shell.overlay` slot: a floating toggle chip plus a
 * right-docked Merge Pilot panel — register any pull request, watch its CI /
 * review / mergeability state live, wake the owning session on demand, and
 * merge manually or let the host-side pilot do it.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/merge-pilot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css =
			".mp-root{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#e6e6e6)}" +
			".mp-toggle{position:absolute;right:16px;bottom:60px;z-index:30;display:inline-flex;align-items:center;gap:6px;" +
			"padding:8px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#333);" +
			"background:var(--dsw-specific-menu,#16161a);color:var(--dsw-alias-label-secondary,#bbb);" +
			"box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.4));cursor:pointer;font-size:12px}" +
			".mp-toggle:hover{color:var(--dsw-alias-label-primary,#fff);border-color:var(--dsw-alias-border-l3,#555)}" +
			".mp-panel{position:absolute;top:0;right:0;bottom:0;width:min(460px,90vw);z-index:29;display:flex;flex-direction:column;" +
			"border-left:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-specific-menu,#141417);" +
			"box-shadow:-12px 0 32px rgba(0,0,0,.35);font-family:var(--dsw-font-sans,system-ui,sans-serif)}" +
			".mp-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#333);flex:none}" +
			".mp-title{flex:1;font-weight:600;font-size:13px;letter-spacing:.02em}" +
			".mp-iconbtn{background:none;border:0;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;border-radius:6px;" +
			"padding:4px 6px;font-size:13px;line-height:1}" +
			".mp-iconbtn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-fill-l2,#242428)}" +
			".mp-body{display:flex;flex-direction:column;min-height:0;flex:1;padding:10px 12px 14px;gap:10px;overflow:hidden}" +
			".mp-form{display:flex;flex-direction:column;gap:6px;flex:none;border:1px solid var(--dsw-alias-border-l1,#26262b);" +
			"border-radius:10px;background:var(--dsw-alias-fill-l1,#17171c);padding:10px}" +
			".mp-input,.mp-select{width:100%;box-sizing:border-box;background:#101014;color:var(--dsw-alias-label-primary,#eee);" +
			"border:1px solid #26262c;border-radius:7px;padding:6px 9px;font-size:12px;outline:none}" +
			".mp-input:focus,.mp-select:focus{border-color:#4a4a52}" +
			".mp-formrow{display:flex;gap:6px;align-items:center}" +
			".mp-formrow > .mp-input{flex:1;min-width:0}" +
			".mp-startbtn{margin-left:auto;background:#2563eb;border:0;color:#fff;border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer}" +
			".mp-startbtn:hover{background:#1d4fd8}" +
			".mp-check{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#bbb);cursor:pointer}" +
			".mp-scroll{overflow-y:auto;min-height:0;flex:1;display:flex;flex-direction:column;gap:8px;padding-right:2px}" +
			".mp-card{border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:10px;background:var(--dsw-alias-fill-l1,#191920);" +
			"padding:8px 10px;display:flex;flex-direction:column;gap:5px}" +
			".mp-cardrow{display:flex;align-items:center;gap:6px;min-width:0}" +
			".mp-name{flex:1;min-width:0;font-weight:500;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".mp-repo{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2);flex:none}" +
			".mp-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#6b7280}" +
			".mp-dot-watching{background:#38bdf8}.mp-dot-fixing{background:#eab308;box-shadow:0 0 6px rgba(234,179,8,.7)}" +
			".mp-dot-ready{background:#22c55e}.mp-dot-merged{background:#8b5cf6}" +
			".mp-dot-blocked{background:#f97316}.mp-dot-closed{background:#64748b}" +
			".mp-dot-expired,.mp-dot-cancelled{background:#475569}" +
			".mp-status{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa);text-transform:none;flex:none}" +
			".mp-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93);white-space:normal}" +
			".mp-badges{display:flex;gap:6px;align-items:center;flex-wrap:wrap}" +
			".mp-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#333);flex:none}" +
			".mp-badge-approved{color:#86efac;border-color:#14532d}.mp-badge-changes{color:#fda4af;border-color:#7f1d1d}" +
			".mp-badge-review{color:#cbd5e1;border-color:#334155}.mp-badge-draft{color:#fde68a;border-color:#78350f}" +
			".mp-checks{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:10px;color:var(--dsw-alias-label-tertiary,#9a9aa2)}" +
			".mp-checks-ok{color:#4ade80}.mp-checks-bad{color:#f87171}.mp-checks-wait{color:#fbbf24}" +
			".mp-btn{border:0;border-radius:7px;padding:4px 10px;font-size:11px;cursor:pointer;flex:none}" +
			".mp-mergebtn{background:#6d28d9;color:#ede9fe}.mp-mergebtn:hover{background:#7c3aed}" +
			".mp-stopbtn{background:#8a2230;color:#ffd9de}.mp-stopbtn:hover{background:#a52a3b}" +
			".mp-delbtn{background:none;color:var(--dsw-alias-label-tertiary,#777);padding:4px 6px}.mp-delbtn:hover{color:#ff8896}" +
			".mp-empty{color:var(--dsw-alias-label-tertiary,#777);font-size:12px;padding:8px 4px}" +
			".mp-error{color:#ff8896;font-size:11px;white-space:pre-wrap;flex:none}" +
			".mp-timeline{margin:2px 0 0;padding-left:14px;font-size:10px;color:var(--dsw-alias-label-tertiary,#77777f)}" +
			".mp-timeline li{margin-top:2px}";
		const tagId = "@dsh-plugins/merge-pilot/pilot.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/merge-pilot";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api client
		const API = "/merge-pilot/api";

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
		function listPilots() {
			return apiFetch("/pilots", { method: "GET" });
		}
		function createPilot(body) {
			return apiFetch("/pilots", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		}
		function mergePilot(id) {
			return apiFetch(`/pilots/${id}/merge`, { method: "POST" });
		}
		function cancelPilot(id) {
			return apiFetch(`/pilots/${id}/cancel`, { method: "POST" });
		}
		function discardPilot(id) {
			return apiFetch(`/pilots/${id}`, { method: "DELETE" });
		}
		//#endregion

		//#region badges + dots
		function dotClass(status) {
			const known = [
				"watching",
				"fixing",
				"ready",
				"merged",
				"blocked",
				"closed",
				"expired",
				"cancelled",
			];
			return known.includes(status) ? `mp-dot mp-dot-${status}` : "mp-dot";
		}

		const STATUS_LABELS = {
			watching: "watching",
			fixing: "fixing…",
			ready: "ready to merge",
			merged: "merged ✓",
			blocked: "blocked",
			closed: "closed",
			expired: "expired",
			cancelled: "cancelled",
		};

		function reviewBadgeClass(decision) {
			if (decision === "APPROVED") return "mp-badge mp-badge-approved";
			if (decision === "CHANGES_REQUESTED") return "mp-badge mp-badge-changes";
			return "mp-badge mp-badge-review";
		}

		const REVIEW_LABELS = {
			APPROVED: "approved",
			CHANGES_REQUESTED: "changes requested",
			REVIEW_REQUIRED: "review required",
		};
		//#endregion

		//#region pilot card
		function PilotCard(props) {
			const pilot = props.pilot;
			const summary = pilot.checkSummary ?? {};
			const canMerge =
				pilot.status === "ready" ||
				(pilot.status === "blocked" && !["merged", "closed"].includes(pilot.status));
			return react_jsx_runtime.jsxs("div", {
				className: "mp-card",
				"data-testid": `mp-pilot-${pilot.id}`,
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "mp-cardrow",
						children: [
							react_jsx_runtime.jsx("span", { className: dotClass(pilot.status) }),
							react_jsx_runtime.jsx("span", {
								className: "mp-status",
								children: STATUS_LABELS[pilot.status] ?? pilot.status,
							}),
							react_jsx_runtime.jsx("span", {
								className: "mp-name",
								title: pilot.title ?? "",
								children: pilot.title ?? "(untitled)",
							}),
							pilot.status === "watching" || pilot.status === "fixing" || pilot.status === "blocked"
								? react_jsx_runtime.jsx("button", {
										className: "mp-btn mp-stopbtn",
										"data-testid": `mp-cancel-${pilot.id}`,
										onClick: () => props.onCancel(pilot.id),
										children: "■ Stop",
									})
								: null,
							canMerge
								? react_jsx_runtime.jsx("button", {
										className: "mp-btn mp-mergebtn",
										"data-testid": `mp-merge-${pilot.id}`,
										title: `Merge now (${pilot.mode})`,
										onClick: () => props.onMerge(pilot.id),
										children: "⇓ Merge",
									})
								: null,
							react_jsx_runtime.jsx("button", {
								className: "mp-delbtn",
								"data-testid": `mp-forget-${pilot.id}`,
								title: "Forget this pilot",
								onClick: () => props.onDiscard(pilot.id),
								children: "✕",
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "mp-cardrow",
						children: [
							react_jsx_runtime.jsx("span", {
								className: "mp-repo",
								children: `${pilot.slug}#${pilot.prNumber}`,
							}),
							react_jsx_runtime.jsx("a", {
								className: "mp-repo",
								href: pilot.prUrl ?? "#",
								target: "_blank",
								rel: "noreferrer",
								children: "↗ open PR",
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "mp-badges",
						children: [
							pilot.reviewDecision
								? react_jsx_runtime.jsx("span", {
										className: reviewBadgeClass(pilot.reviewDecision),
										children: REVIEW_LABELS[pilot.reviewDecision] ?? String(pilot.reviewDecision).toLowerCase(),
									})
								: null,
							pilot.isDraft
								? react_jsx_runtime.jsx("span", { className: "mp-badge mp-badge-draft", children: "draft" })
								: null,
							react_jsx_runtime.jsxs("span", {
								className: "mp-checks",
								children: [
									summary.passed ? `${summary.passed}✓ ` : "",
									summary.failed ? `${summary.failed}✗ ` : "",
									summary.pending ? `${summary.pending}⏳` : "",
									!summary.passed && !summary.failed && !summary.pending ? "no checks yet" : "",
								],
							}),
							react_jsx_runtime.jsx("span", { className: "mp-checks", children: pilot.autoMerge ? "auto-merge" : "manual" }),
						],
					}),
					pilot.note ? react_jsx_runtime.jsx("div", { className: "mp-note", children: pilot.note }) : null,
					pilot.timeline && pilot.timeline.length > 0
						? react_jsx_runtime.jsx(
								"ul",
								{ className: "mp-timeline", children: pilot.timeline.map((entry, index) =>
										react_jsx_runtime.jsx("li", { children: `${entry.at.slice(11, 19)} — ${entry.event}` }, index),
									) },
							)
						: null,
				],
			});
		}
		//#endregion

		//#region start form
		function StartForm(props) {
			const refRef = react.useRef(null);
			const sessionRef = react.useRef(null);
			const [mode, setMode] = react.useState("squash");
			const [autoMerge, setAutoMerge] = react.useState(false);

			const submit = (event) => {
				event.preventDefault();
				const pullRequest = refRef.current ? refRef.current.value.trim() : "";
				if (!pullRequest) return;
				props.onStart({
					pullRequest,
					sessionId: sessionRef.current ? sessionRef.current.value.trim() : "",
					mode,
					autoMerge,
				});
				if (refRef.current) refRef.current.value = "";
			};

			return react_jsx_runtime.jsxs("form", {
				className: "mp-form",
				"data-testid": "merge-pilot-form",
				onSubmit: submit,
				children: [
					react_jsx_runtime.jsx("input", {
						ref: refRef,
						className: "mp-input",
						"data-testid": "merge-pilot-ref-input",
						placeholder: "PR to shepherd — URL, o/r#123 or #123…",
						spellCheck: false,
					}),
					react_jsx_runtime.jsxs("div", {
						className: "mp-formrow",
						children: [
							react_jsx_runtime.jsxs("select", {
								className: "mp-select",
								"data-testid": "merge-pilot-mode",
								value: mode,
								onChange: (event) => setMode(event.target.value),
								children: [
									react_jsx_runtime.jsx("option", { value: "squash", children: "Squash merge" }),
									react_jsx_runtime.jsx("option", { value: "merge", children: "Merge commit" }),
									react_jsx_runtime.jsx("option", { value: "rebase", children: "Rebase merge" }),
								],
							}),
							react_jsx_runtime.jsx("label", {
								className: "mp-check",
								title: "Let the host-side pilot run gh pr merge as soon as the PR turns green + approved",
								children: [
									react_jsx_runtime.jsx("input", {
										type: "checkbox",
										"data-testid": "merge-pilot-automerge",
										checked: autoMerge,
										onChange: (event) => setAutoMerge(event.target.checked),
									}),
									"auto-merge",
								],
							}),
							react_jsx_runtime.jsx("button", {
								type: "submit",
								className: "mp-startbtn",
								"data-testid": "merge-pilot-start",
								children: "🛬 Pilot this PR",
							}),
						],
					}),
					react_jsx_runtime.jsx("input", {
						ref: sessionRef,
						className: "mp-input",
						"data-testid": "merge-pilot-session-input",
						placeholder: "Session id to wake on CI failure / review comments (optional)",
						spellCheck: false,
					}),
				],
			});
		}
		//#endregion

		//#region panel
		function Panel(props) {
			const onClose = props.onClose;
			const [pilots, setPilots] = react.useState([]);
			const [error, setError] = react.useState("");

			const refresh = react.useCallback(() => {
				listPilots()
					.then((payload) => setPilots(payload.pilots ?? []))
					.catch((err) => setError(String(err.message || err)));
			}, []);

			react.useEffect(() => {
				refresh();
				const timer = window.setInterval(refresh, 2500);
				return () => window.clearInterval(timer);
			}, [refresh]);

			// Escape closes the panel.
			react.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);

			const start = async (body) => {
				setError("");
				try {
					await createPilot({
						pullRequest: body.pullRequest,
						mode: body.mode,
						autoMerge: body.autoMerge,
						...(body.sessionId ? { sessionId: body.sessionId } : {}),
					});
					refresh();
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			const merge = async (id) => {
				setError("");
				try {
					await mergePilot(id);
					refresh();
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			const cancel = async (id) => {
				setError("");
				try {
					await cancelPilot(id);
					refresh();
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			const discard = async (id) => {
				setError("");
				try {
					await discardPilot(id);
					refresh();
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			return react_jsx_runtime.jsxs("div", {
				className: "mp-panel",
				"data-testid": "merge-pilot-panel",
				children: [
					react_jsx_runtime.jsxs("header", {
						className: "mp-header",
						children: [
							react_jsx_runtime.jsx("span", { children: "🛬" }),
							react_jsx_runtime.jsx("span", {
								className: "mp-title",
								children: "Merge Pilot",
							}),
							react_jsx_runtime.jsx("button", {
								className: "mp-iconbtn",
								"data-testid": "merge-pilot-close",
								title: "Close (Esc)",
								onClick: onClose,
								children: "✕",
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "mp-body",
						children: [
							react_jsx_runtime.jsx(StartForm, { onStart: start }),
							error
								? react_jsx_runtime.jsx("div", { className: "mp-error", children: error })
								: null,
							react_jsx_runtime.jsxs("div", {
								className: "mp-scroll",
								children: [
									pilots.length === 0
										? react_jsx_runtime.jsx("div", {
												className: "mp-empty",
												children: "No piloted PRs. Register one above — the pilot watches CI and reviews, wakes your session to fix issues, and merges when allowed.",
											})
										: pilots.map((pilot) =>
												react_jsx_runtime.jsx(
													PilotCard,
													{ pilot, onMerge: merge, onCancel: cancel, onDiscard: discard },
													pilot.id,
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
				className: "mp-root",
				"data-testid": "merge-pilot-root",
				children: [
					open
						? react_jsx_runtime.jsx(Panel, { onClose: () => setOpen(false) })
						: react_jsx_runtime.jsx("button", {
								className: "mp-toggle",
								"data-testid": "merge-pilot-toggle",
								title: "Open the Merge Pilot",
								onClick: () => setOpen(true),
								children: "🛬 Merge Pilot",
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
						id: "merge-pilot",
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
