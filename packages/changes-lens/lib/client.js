/**
 * @dsh-plugins/changes-lens — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form:
 * executing the script only REGISTERS the factory; the body below runs at
 * materialization. Externals are limited to the shell-seeded baseline
 * (`react`, `react/jsx-runtime`). The plugin contributes one entry to the
 * runtime-owned `shell.overlay` slot: a floating toggle chip plus a
 * right-docked Changes Lens panel — pick a checkout, watch its branch/sync
 * state, browse changed files with +/- stats, read per-file unified diffs,
 * and pin recovery snapshots of uncommitted work.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/changes-lens",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css =
			".cl-root{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#e6e6e6)}" +
			".cl-toggle{position:absolute;left:16px;bottom:60px;z-index:30;display:inline-flex;align-items:center;gap:6px;" +
			"padding:8px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#333);" +
			"background:var(--dsw-specific-menu,#16161a);color:var(--dsw-alias-label-secondary,#bbb);" +
			"box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.4));cursor:pointer;font-size:12px}" +
			".cl-toggle:hover{color:var(--dsw-alias-label-primary,#fff);border-color:var(--dsw-alias-border-l3,#555)}" +
			".cl-panel{position:absolute;top:0;right:0;bottom:0;width:min(460px,90vw);z-index:29;display:flex;flex-direction:column;" +
			"border-left:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-specific-menu,#141417);" +
			"box-shadow:-12px 0 32px rgba(0,0,0,.35);font-family:var(--dsw-font-sans,system-ui,sans-serif)}" +
			".cl-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#333);flex:none}" +
			".cl-title{flex:1;font-weight:600;font-size:13px;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".cl-iconbtn{background:none;border:0;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;border-radius:6px;" +
			"padding:4px 6px;font-size:13px;line-height:1}" +
			".cl-iconbtn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-fill-l2,#242428)}" +
			".cl-body{display:flex;flex-direction:column;min-height:0;flex:1;padding:10px 12px 14px;gap:8px;overflow:hidden}" +
			".cl-formrow{display:flex;gap:6px;align-items:center;flex:none}" +
			".cl-input{flex:1;min-width:0;box-sizing:border-box;background:var(--dsw-alias-fill-l1,#1b1b20);" +
			"color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:8px;" +
			"padding:7px 9px;font-size:12px;font-family:var(--dsw-font-mono,ui-monospace,monospace);outline:none}" +
			".cl-input:focus{border-color:var(--dsw-alias-border-l3,#4a4a52)}" +
			".cl-btn{border:0;border-radius:7px;padding:5px 10px;font-size:11px;cursor:pointer;flex:none}" +
			".cl-openbtn{background:#2563eb;color:#fff}.cl-openbtn:hover{background:#1d4fd8}" +
			".cl-refresh{background:#1f2937;color:#cbd5e1}.cl-refresh:hover{background:#2b3648}" +
			".cl-snapbtn{background:#6d28d9;color:#ede9fe}.cl-snapbtn:hover{background:#7c3aed}" +
			".cl-statusrow{display:flex;align-items:center;gap:8px;flex:none;min-width:0}" +
			".cl-branch{font-weight:600;font-size:12px}" +
			".cl-sync{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2)}" +
			".cl-counts{margin-left:auto;display:flex;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93)}" +
			".cl-files{overflow-y:auto;min-height:88px;max-height:40%;flex:none;border:1px solid var(--dsw-alias-border-l1,#26262b);" +
			"border-radius:9px;background:var(--dsw-alias-fill-l1,#17171c)}" +
			".cl-file{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:0;" +
			"padding:5px 10px;cursor:pointer;color:inherit;font-size:12px;font-family:inherit}" +
			".cl-file:hover{background:var(--dsw-alias-fill-l2,#222228)}" +
			".cl-file-active{background:var(--dsw-alias-fill-l3,#2a2a33)}" +
			".cl-glyph{width:16px;height:16px;border-radius:5px;font-size:11px;line-height:16px;text-align:center;flex:none;font-weight:700}" +
			".cl-glyph-M{background:#3f3000;color:#fde047}.cl-glyph-A{background:#0c2d6b;color:#93c5fd}" +
			".cl-glyph-D{background:#4c0519;color:#fda4af}.cl-glyph-R,.cl-glyph-C{background:#3b0764;color:#d8b4fe}" +
			".cl-glyph-U{background:#450a0a;color:#fecaca}.cl-glyph-T{background:#134e4a;color:#5eead4}" +
			".cl-glyph-q{background:#27272a;color:#a1a1aa}.cl-glyph-x{background:#27272a;color:#a1a1aa}" +
			".cl-path{flex:1;min-width:0;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;" +
			"white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".cl-stats{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:10px;flex:none}" +
			".cl-adds{color:#4ade80}.cl-dels{color:#f87171}" +
			".cl-empty{color:var(--dsw-alias-label-tertiary,#777);font-size:12px;padding:12px 10px}" +
			".cl-diffwrap{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,#26262b);" +
			"border-radius:9px;overflow:hidden;background:#0d0d10}" +
			".cl-diffhead{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #232329;flex:none;" +
			"font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2);font-family:var(--dsw-font-mono,ui-monospace,monospace);" +
			"white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".cl-diff{flex:1;min-height:0;overflow:auto;margin:0;padding:8px 0;" +
			"font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:16px;white-space:pre}" +
			".cl-line{display:block;padding:0 10px}" +
			".cl-line-add{background:rgba(34,197,94,.14);color:#bbf7d0}" +
			".cl-line-del{background:rgba(239,68,68,.14);color:#fecaca}" +
			".cl-line-hunk{color:#7dd3fc;background:rgba(56,189,248,.08)}" +
			".cl-line-meta{color:#64748b}" +
			".cl-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93);white-space:pre-wrap;flex:none}" +
			".cl-error{color:#ff8896;font-size:11px;white-space:pre-wrap;flex:none}";
		const tagId = "@dsh-plugins/changes-lens/lens.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/changes-lens";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api client
		const API = "/changes-lens/api";

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
		const fetchDefaults = () => apiFetch("/defaults", { method: "GET" });
		const openRoot = (cwd) =>
			apiFetch("/open", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd }),
			});
		const fetchStatus = (root) =>
			apiFetch(`/status?root=${encodeURIComponent(root)}`, { method: "GET" });
		const fetchDiff = (root, path, cached) =>
			apiFetch(
				`/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path ?? "")}&cached=${cached ? "1" : "0"}`,
				{ method: "GET" },
			);
		const snapshot = (root) =>
			apiFetch("/snapshot", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ root }),
			});
		const listSnapshots = (root) =>
			apiFetch(`/snapshots/list?root=${encodeURIComponent(root)}`, { method: "POST" });
		//#endregion

		//#region storage
		const ROOT_KEY = "dsh-changes-lens.root.v1";

		function loadRoot() {
			try {
				return window.localStorage.getItem(ROOT_KEY) || "";
			} catch {
				return "";
			}
		}

		function persistRoot(value) {
			try {
				window.localStorage.setItem(ROOT_KEY, value);
			} catch {
				/* private mode */
			}
		}
		//#endregion

		//#region diff rendering
		function diffLineClass(line) {
			if (line.startsWith("@@")) return "cl-line cl-line-hunk";
			if (line.startsWith("+")) return "cl-line cl-line-add";
			if (line.startsWith("-")) return "cl-line cl-line-del";
			if (
				line.startsWith("diff ") ||
				line.startsWith("index ") ||
				line.startsWith("--- ") ||
				line.startsWith("+++ ")
			) {
				return "cl-line cl-line-meta";
			}
			return "cl-line";
		}

		function DiffView(props) {
			const diff = props.diff;
			const lines = String(diff.text ?? "").split("\n");
			return react_jsx_runtime.jsxs("div", {
				className: "cl-diffwrap",
				"data-testid": "changes-lens-diff",
				children: [
					react_jsx_runtime.jsx("div", {
						className: "cl-diffhead",
						children: [
							diff.path ? diff.path : "(all files)",
							diff.cached ? " · staged" : "",
							diff.truncated ? ` · truncated at ${Math.round(diff.text.length / 1024)} KiB` : "",
						].join(""),
					}),
					react_jsx_runtime.jsx("pre", {
						className: "cl-diff",
						children: lines.map((line, index) =>
							react_jsx_runtime.jsx(
								"span",
								{ className: diffLineClass(line), children: line || " " },
								index,
							),
						),
					}),
				],
			});
		}
		//#endregion

		//#region file row
		function glyphClass(glyph) {
			if (glyph === "?") return "cl-glyph cl-glyph-q";
			if (/^[MRCDUT]$/.test(glyph)) return `cl-glyph cl-glyph-${glyph}`;
			return "cl-glyph cl-glyph-x";
		}

		function FileRow(props) {
			const entry = props.entry;
			const active = props.active;
			return react_jsx_runtime.jsxs("button", {
				className: active ? "cl-file cl-file-active" : "cl-file",
				"data-testid": `changes-lens-file-${entry.path}`,
				title: `${entry.label} — ${entry.path}`,
				onClick: () => props.onSelect(entry),
				children: [
					react_jsx_runtime.jsx("span", { className: glyphClass(entry.glyph), children: entry.glyph }),
					react_jsx_runtime.jsx("span", { className: "cl-path", children: entry.path }),
					entry.binary
						? react_jsx_runtime.jsx("span", { className: "cl-stats", children: "bin" })
						: entry.adds === null && entry.dels === null
							? null
							: react_jsx_runtime.jsxs("span", { className: "cl-stats", children: [
									react_jsx_runtime.jsx("span", { className: "cl-adds", children: `+${entry.adds ?? 0}` }),
									" ",
									react_jsx_runtime.jsx("span", { className: "cl-dels", children: `−${entry.dels ?? 0}` }),
								] }),
				],
			});
		}
		//#endregion

		//#region panel
		function Panel(props) {
			const onClose = props.onClose;
			const [rootInput, setRootInput] = react.useState(loadRoot);
			const [state, setState] = react.useState(null);
			const [selected, setSelected] = react.useState(null); // {path, cached}
			const [diffData, setDiffData] = react.useState(null);
			const [note, setNote] = react.useState("");
			const [error, setError] = react.useState("");
			const stateRef = react.useRef(state);
			stateRef.current = state;

			const loadStatus = react.useCallback(async (root) => {
				if (!root) return;
				setError("");
				try {
					const next = await fetchStatus(root);
					setState(next);
					persistRoot(root);
				} catch (err) {
					setError(String(err.message || err));
				}
			}, []);

			const loadDiff = react.useCallback(async (root, path, cached) => {
				setError("");
				try {
					setDiffData(await fetchDiff(root, path, cached));
				} catch (err) {
					setError(String(err.message || err));
				}
			}, []);

			// Initial open: prefer the remembered root, else the host default.
			react.useEffect(() => {
				let cancelled = false;
				fetchDefaults()
					.then((payload) => {
						if (cancelled) return;
						const initial =
							loadRoot() ||
							payload.defaultRoot ||
							payload.recent?.[0] ||
							"";
						setRootInput(initial);
						if (initial) void loadStatus(initial);
					})
					.catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [loadStatus]);

			// Light auto-refresh of the status while the panel is open.
			react.useEffect(() => {
				const timer = window.setInterval(() => {
					const root = stateRef.current?.root;
					if (root) void loadStatus(root);
				}, 5000);
				return () => window.clearInterval(timer);
			}, [loadStatus]);

			// Escape closes the panel.
			react.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);

			const doOpen = async () => {
				const root = rootInput.trim();
				if (!root) return;
				await loadStatus(root);
				setSelected(null);
				setDiffData(null);
			};

			const doSelect = async (entry) => {
				const root = stateRef.current?.root;
				if (!root) return;
				setSelected({ path: entry.path, cached: false });
				await loadDiff(root, entry.path, false);
			};

			const doAllFiles = async () => {
				const root = stateRef.current?.root;
				if (!root) return;
				setSelected(null);
				await loadDiff(root, "", false);
			};

			const doStagedToggle = async () => {
				const root = stateRef.current?.root;
				if (!root) return;
				const cached = !(selected?.cached ?? false);
				const nextSelected = selected ? { ...selected, cached } : null;
				setSelected(nextSelected);
				await loadDiff(root, nextSelected?.path ?? "", cached);
			};

			const doSnapshot = async () => {
				const root = stateRef.current?.root;
				if (!root) return;
				setNote("");
				setError("");
				try {
					const result = await snapshot(root);
					setNote(
						result.created
							? `Recovery ref pinned:\n${result.ref}\n(${result.sha.slice(0, 12)})`
							: result.note,
					);
					listSnapshots(root).catch(() => {});
				} catch (err) {
					setError(String(err.message || err));
				}
			};

			const entries = state?.entries ?? [];
			const counts = state?.counts;

			return react_jsx_runtime.jsxs("div", {
				className: "cl-panel",
				"data-testid": "changes-lens-panel",
				children: [
					react_jsx_runtime.jsxs("header", {
						className: "cl-header",
						children: [
							react_jsx_runtime.jsx("span", { children: "◫" }),
							react_jsx_runtime.jsx("span", {
								className: "cl-title",
								title: state?.root,
								children: state ? "Changes Lens" : "Changes Lens — open a checkout",
							}),
							react_jsx_runtime.jsx("button", {
								className: "cl-iconbtn",
								"data-testid": "changes-lens-close",
								title: "Close (Esc)",
								onClick: onClose,
								children: "✕",
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "cl-body",
						children: [
							react_jsx_runtime.jsxs("div", {
								className: "cl-formrow",
								children: [
									react_jsx_runtime.jsx("input", {
										className: "cl-input",
										"data-testid": "changes-lens-root-input",
										value: rootInput,
										placeholder: "/path/to/checkout…",
										spellCheck: false,
										onChange: (event) => setRootInput(event.target.value),
										onKeyDown: (event) => {
											if (event.key === "Enter") void doOpen();
										},
									}),
									react_jsx_runtime.jsx("button", {
										className: "cl-btn cl-openbtn",
										"data-testid": "changes-lens-open",
										onClick: () => void doOpen(),
										children: "Open",
									}),
									react_jsx_runtime.jsx("button", {
										className: "cl-btn cl-snapbtn",
										"data-testid": "changes-lens-snapshot",
										title: "Pin uncommitted tracked work under refs/dsh-changes-lens/*",
										onClick: () => void doSnapshot(),
										children: "⌾ Snapshot",
									}),
								],
							}),
							state
								? react_jsx_runtime.jsxs("div", {
										className: "cl-statusrow",
										children: [
											react_jsx_runtime.jsx("span", {
												className: "cl-branch",
												"data-testid": "changes-lens-branch",
												children: state.branch,
											}),
											state.upstream
												? react_jsx_runtime.jsx("span", {
														className: "cl-sync",
														children: `↑${state.ahead} ↓${state.behind}`,
													})
												: null,
											react_jsx_runtime.jsx("span", {
												className: "cl-counts",
												children: counts
													? `${counts.total} changed · ${counts.staged} staged`
													: "",
											}),
											react_jsx_runtime.jsx("button", {
												className: "cl-btn cl-refresh",
												"data-testid": "changes-lens-refresh",
												title: "Re-read status + diff",
												onClick: () => {
													void loadStatus(state.root);
													if (selected)
														void loadDiff(state.root, selected.path, selected.cached);
												},
												children: "⟳",
											}),
										],
									})
								: null,
							error ? react_jsx_runtime.jsx("div", { className: "cl-error", children: error }) : null,
							note ? react_jsx_runtime.jsx("div", { className: "cl-note", children: note }) : null,
							react_jsx_runtime.jsxs("div", {
								className: "cl-files",
								"data-testid": "changes-lens-files",
								children: [
									!state
										? react_jsx_runtime.jsx("div", { className: "cl-empty", children: "Open a local checkout above." })
										: entries.length === 0
											? react_jsx_runtime.jsx("div", {
													className: "cl-empty",
													children: "Working tree clean — nothing pending.",
												})
											: entries.map((entry) =>
													react_jsx_runtime.jsx(
														FileRow,
														{
															entry,
															active:
																selected?.path === entry.path && !selected?.cached,
															onSelect: (item) => void doSelect(item),
														},
														entry.path,
													),
												),
								],
							}),
							selected
								? react_jsx_runtime.jsxs("div", {
										className: "cl-formrow",
										children: [
											react_jsx_runtime.jsx("button", {
												className: "cl-btn cl-refresh",
												"data-testid": "changes-lens-allfiles",
												onClick: () => void doAllFiles(),
												children: "Whole tree",
											}),
											react_jsx_runtime.jsx("button", {
												className: "cl-btn cl-refresh",
												"data-testid": "changes-lens-cached",
												title: "Toggle between worktree and staged diff",
												onClick: () => void doStagedToggle(),
												children: selected?.cached ? "Show unstaged" : "Show staged",
											}),
										],
									})
								: null,
							diffData
								? react_jsx_runtime.jsx(DiffView, { diff: diffData })
								: state && entries.length > 0
									? react_jsx_runtime.jsx("div", {
											className: "cl-note",
											children: "Pick a file above to inspect its unified diff.",
										})
									: null,
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
				className: "cl-root",
				"data-testid": "changes-lens-root",
				children: [
					open
						? react_jsx_runtime.jsx(Panel, { onClose: () => setOpen(false) })
						: react_jsx_runtime.jsx("button", {
								className: "cl-toggle",
								"data-testid": "changes-lens-toggle",
								title: "Open the Changes Lens",
								onClick: () => setOpen(true),
								children: "◫ Changes Lens",
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
						id: "changes-lens",
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
