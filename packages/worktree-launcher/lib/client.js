/**
 * @dsh-plugins/worktree-launcher — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form:
 * executing the script only REGISTERS the factory; the body below runs at
 * materialization. Externals are limited to the shell-seeded baseline
 * (`react`, `react/jsx-runtime`). The plugin contributes two additive entries:
 *
 *   - `conversation.input.left`   — the "Worktree" toggle in the composer tool
 *     row of the chat window (ON by default); flipping it persists locally and
 *     syncs the host-side preference that gates auto-creation;
 *   - `conversation.composer.dock` — an ambient readout of the session's
 *     worktree (`dsh-word-word-word` + path copy) once the host created one;
 *   - `shell.overlay`             — a headless session-list painter: it polls
 *     the host's per-session git/PR state feed and stamps `data-wtl-git`
 *     attributes onto matching sidebar session rows; CSS then draws a small
 *     git logo between each row's title and its relative-time label — green
 *     = worktree created, blue = PR open, red = CI failing (or PR closed
 *     unmerged), purple = merged. Only attributes are ever written
 *     (React never strips unknown ones); no child nodes are injected.
 *
 * All seats are additive, so unmounting this plugin restores the stock shell
 * exactly.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/worktree-launcher",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css =
			".wtl-root{font-size:12px;color:var(--dsw-alias-label-secondary,#b9b9c0)}" +
			".wtl-toggle{display:inline-flex;align-items:center;gap:6px;border-radius:999px;" +
			"border:1px solid var(--dsw-alias-border-l1,#2c2c31);background:transparent;" +
			"color:var(--dsw-alias-label-tertiary,#8b8b93);padding:3px 10px;font-size:11px;line-height:16px;" +
			"cursor:pointer;user-select:none}" +
			".wtl-toggle:hover{border-color:var(--dsw-alias-border-l3,#4a4a52);color:var(--dsw-alias-label-primary,#eee)}" +
			".wtl-toggle[aria-pressed='true']{border-color:var(--dsw-specific-ok,#2f9e63);" +
			"color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-fill-l1,#1b1b20)}" +
			".wtl-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l3,#55555c);flex:none}" +
			".wtl-dot.on{background:#34c273;box-shadow:0 0 6px rgba(52,194,115,.7)}" +
			".wtl-label{letter-spacing:.02em}" +
			".wtl-chip{display:inline-flex;align-items:center;gap:7px;max-width:100%;" +
			"font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8b8b93);" +
			"user-select:none}" +
			".wtl-chip .wtl-dot.on{margin-right:1px}" +
			".wtl-branch{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,monospace);" +
			"color:var(--dsw-alias-label-secondary,#b9b9c0);white-space:nowrap;overflow:hidden;" +
			"text-overflow:ellipsis;max-width:32ch}" +
			".wtl-copy{background:none;border:0;padding:0 2px;cursor:pointer;font-size:11px;" +
			"color:var(--dsw-alias-label-tertiary,#8b8b93)}" +
			".wtl-copy:hover{color:var(--dsw-alias-label-primary,#fff)}";

		/** Monochrome git-branch glyph, recolored per state via background-color + mask. */
		const BADGE_SVG =
			"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z'/%3E%3C/svg%3E";

		const badgeCss =
			// The relative-time label of a session row is its penultimate child
			// span (…, title, time, row-menu); drawing on its ::before puts the
			// logo exactly between the title and the time without touching any
			// React-managed child.
			'[data-wtl-git] > span:nth-last-child(2)::before{content:"";display:inline-block;' +
			"width:11px;height:11px;margin-right:5px;vertical-align:-1px;background-color:" +
			"var(--dsw-alias-state-success-primary,#3fb950);" +
			`-webkit-mask:url("${BADGE_SVG}") center/contain no-repeat;` +
			`mask:url("${BADGE_SVG}") center/contain no-repeat}` +
			'[data-wtl-git="pr"] > span:nth-last-child(2)::before{background-color:#4493f8}' +
			'[data-wtl-git="problem"] > span:nth-last-child(2)::before{background-color:' +
			"var(--dsw-alias-state-error-primary,#f85149)}" +
			'[data-wtl-git="merged"] > span:nth-last-child(2)::before{background-color:#a371f7}';

		const tagId = "@dsh-plugins/worktree-launcher/launcher.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/worktree-launcher";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css + badgeCss;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region session list badges
		const STATES_POLL_MS = 30_000;
		const RESCAN_DEBOUNCE_MS = 200;

		function normalizeTitle(text) {
			return String(text ?? "")
				.replace(/\s+/g, " ")
				.trim();
		}

		function childrenOf(node) {
			if (!node || !node.children || typeof node.children.length !== "number") return [];
			return Array.from(node.children);
		}

		function attrOf(node, name) {
			if (!node || typeof node.getAttribute !== "function") return undefined;
			try {
				return node.getAttribute(name);
			} catch {
				return undefined;
			}
		}

		function hasButtonDescendant(node, depth = 0) {
			if (!node || depth > 4) return false;
			if (String(node.tagName ?? "").toUpperCase() === "BUTTON") return true;
			for (const child of childrenOf(node)) {
				if (hasButtonDescendant(child, depth + 1)) return true;
			}
			return false;
		}

		/**
		 * Stamp or clear `data-wtl-git="<state>"` onto sidebar session rows by
		 * matching each row's title against {@link statesByTitle}. Rows are
		 * identified structurally — `[role=treeitem]` whose last child holds a
		 * button (the row menu) and whose penultimate child is a SPAN (the
		 * relative-time label) — never via hashed class names. Workspace group
		 * rows, search results and blank rows fail that shape test and are left
		 * untouched. Pure over minimal node objects so tests run without a DOM.
		 * @returns {Set} every row visited this pass (painted or cleared).
		 */
		function scanSessionRows(root, statesByTitle) {
			const rows = [];
			const collect = (node) => {
				for (const child of childrenOf(node)) {
					if (attrOf(child, "role") === "treeitem") {
						rows.push(child);
						continue;
					}
					collect(child);
				}
			};
			collect(root);
			const touched = new Set();
			for (const row of rows) {
				touched.add(row);
				const kids = childrenOf(row);
				let state;
				if (
					kids.length >= 3 &&
					hasButtonDescendant(kids[kids.length - 1]) &&
					String(kids[kids.length - 2]?.tagName ?? "").toUpperCase() === "SPAN"
				) {
					state = statesByTitle.get(normalizeTitle(kids[kids.length - 3]?.textContent));
				}
				if (state) {
					if (typeof row.setAttribute === "function") row.setAttribute("data-wtl-git", state);
				} else if (typeof row.removeAttribute === "function") {
					row.removeAttribute("data-wtl-git");
				}
			}
			return touched;
		}

		/**
		 * Headless overlay entry: polls the host state feed and repaints rows on
		 * DOM mutations. Renders nothing; owns every timer/observer it creates.
		 */
		function SessionGitBadges() {
			const statesRef = react.useRef(new Map());
			const paintedRef = react.useRef(new Set());

			react.useEffect(() => {
				let live = true;
				let pending = null;
				let intervalId = null;
				let observer = null;

				const repaint = () => {
					try {
						if (typeof document === "undefined" || !document.body) return;
						for (const node of scanSessionRows(document.body, statesRef.current)) {
							paintedRef.current.add(node);
						}
					} catch {
						/* a hostile node shape must never break the page */
					}
				};
				const requestRepaint = () => {
					if (pending !== null) return;
					pending = window.setTimeout(() => {
						pending = null;
						if (live) repaint();
					}, RESCAN_DEBOUNCE_MS);
				};
				const poll = () => {
					fetchSessionStates()
						.then((payload) => {
							if (!live) return;
							const byTitle = new Map();
							for (const entry of Array.isArray(payload?.states) ? payload.states : []) {
								if (
									entry &&
									typeof entry.title === "string" &&
									typeof entry.state === "string"
								) {
									byTitle.set(normalizeTitle(entry.title), entry.state);
								}
							}
							statesRef.current = byTitle;
							repaint();
						})
						.catch(() => {});
				};
				const onVisible = () => {
					if (document.visibilityState === "visible") poll();
				};

				if (typeof MutationObserver === "function" && document.body) {
					observer = new MutationObserver(requestRepaint);
					observer.observe(document.body, {
						childList: true,
						subtree: true,
						characterData: true,
					});
				}
				if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
					document.addEventListener("visibilitychange", onVisible);
				}
				intervalId = window.setInterval(poll, STATES_POLL_MS);
				poll();

				return () => {
					live = false;
					if (pending !== null) window.clearTimeout(pending);
					window.clearInterval(intervalId);
					if (observer) observer.disconnect();
					if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
						document.removeEventListener("visibilitychange", onVisible);
					}
					for (const node of paintedRef.current) {
						try {
							node?.removeAttribute?.("data-wtl-git");
						} catch {
							/* detached node */
						}
					}
					paintedRef.current.clear();
				};
			}, []);

			return null;
		}
		//#endregion

		//#region api client
		const API = "/worktree-launcher/api";

		async function apiFetch(path, options) {
			let response;
			try {
				response = await fetch(API + path, options);
			} catch (error) {
				throw new Error(`worktree-launcher: ${String(error?.message ?? error)}`);
			}
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

		function getPref() {
			return apiFetch("/pref", { method: "GET" });
		}
		function putPref(enabled) {
			return apiFetch("/pref", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
		}
		function fetchBySession(sessionId) {
			return apiFetch(`/by-session/${encodeURIComponent(sessionId)}`, {
				method: "GET",
			});
		}
		function fetchSessionStates() {
			return apiFetch("/session-states", { method: "GET" });
		}
		//#endregion

		//#region storage
		const STORAGE_KEY = "dsh-worktree-launcher.enabled.v1";

		function readLocal() {
			try {
				return window.localStorage.getItem(STORAGE_KEY) !== "0";
			} catch {
				return true;
			}
		}
		function writeLocal(enabled) {
			try {
				window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
			} catch {
				/* private mode: session-only preference */
			}
		}
		//#endregion

		//#region toggle
		function WorktreeToggle() {
			const [enabled, setEnabled] = react.useState(readLocal);

			react.useEffect(() => {
				let live = true;
				getPref()
					.then((payload) => {
						if (!live || typeof payload?.enabled !== "boolean") return;
						setEnabled(payload.enabled);
						writeLocal(payload.enabled);
					})
					.catch(() => {});
				return () => {
					live = false;
				};
			}, []);

			const flip = () => {
				const next = !enabled;
				setEnabled(next);
				writeLocal(next);
				putPref(next).catch(() => {});
			};

			return react_jsx_runtime.jsxs(
				"button",
				{
					className: "wtl-toggle",
					type: "button",
					"data-testid": "worktree-toggle",
					"aria-pressed": enabled ? "true" : "false",
					title:
						"Nouvelle session isolée dans un worktree git " +
						"(branche dsh-mot-mot-mot basée sur main à jour)",
					onClick: flip,
					children: [
						react_jsx_runtime.jsx("span", {
							className: enabled ? "wtl-dot on" : "wtl-dot",
						}),
						react_jsx_runtime.jsx("span", {
							className: "wtl-label",
							children: "Worktree",
						}),
					],
				},
			);
		}
		//#endregion

		//#region chip
		function sessionIdOf(props) {
			if (!props) return undefined;
			const snapshot = props.session;
			if (snapshot && typeof snapshot.sessionId === "string") {
				return snapshot.sessionId;
			}
			if (typeof props.sessionId === "string") return props.sessionId;
			return undefined;
		}

		function WorktreeChip(props) {
			const sessionId = sessionIdOf(props);
			const [record, setRecord] = react.useState(null);
			const [copied, setCopied] = react.useState(false);

			react.useEffect(() => {
				setRecord(null);
				if (!sessionId) return undefined;
				let live = true;
				let timer = null;
				let attempts = 0;
				const tick = () => {
					timer = null;
					fetchBySession(sessionId)
						.then((payload) => {
							if (!live) return;
							setRecord(payload);
						})
						.catch(() => {
							// Not created yet (or endpoint busy): retry briefly, then stop.
							attempts += 1;
							if (live && attempts < 10) timer = window.setTimeout(tick, 3000);
						});
				};
				tick();
				return () => {
					live = false;
					if (timer !== null) window.clearTimeout(timer);
				};
			}, [sessionId]);

			const copyPath = () => {
				if (!record) return;
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(record.path).catch(() => {});
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1200);
					}
				} catch {
					/* clipboard unavailable */
				}
			};

			if (!record || !sessionId) return null;
			const title =
				`${record.path}\n` +
				`branche ${record.branch} · base ${record.baseBranch}` +
				(record.mainUpdated ? " (main mise à jour)" : "") +
				(record.note ? `\n${record.note}` : "");
			return react_jsx_runtime.jsxs(
				"span",
				{
					className: "wtl-root wtl-chip",
					"data-testid": "worktree-chip",
					title,
					children: [
						react_jsx_runtime.jsx("span", { className: "wtl-dot on" }),
						react_jsx_runtime.jsx("span", {
							className: "wtl-branch",
							children: record.branch,
						}),
						react_jsx_runtime.jsx("button", {
							className: "wtl-copy",
							type: "button",
							"data-testid": "worktree-chip-copy",
							title: "Copier le chemin du worktree",
							onClick: copyPath,
							children: copied ? "✓" : "⧉",
						}),
					],
				},
			);
		}
		//#endregion

		//#region plugin body
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: "worktree-toggle",
						order: 40,
					},
					WorktreeToggle,
				),
			);
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{
						name: "conversation.composer.dock",
						id: "worktree-chip",
						order: 10,
					},
					WorktreeChip,
				),
			);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "session-git-badges",
						order: 50,
					},
					SessionGitBadges,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.scanSessionRows = scanSessionRows;
		exports.normalizeTitle = normalizeTitle;
		return module.exports;
	},
});
