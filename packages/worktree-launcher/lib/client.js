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
 *     worktree (`dsh-word-word-word` + path copy) once the host created one.
 *
 * Both seats are list slots, so unmounting this plugin restores the stock
 * composer exactly.
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
		const tagId = "@dsh-plugins/worktree-launcher/launcher.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/worktree-launcher";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
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
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
