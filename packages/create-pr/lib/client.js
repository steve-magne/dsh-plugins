/**
 * @dsh-plugins/create-pr — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form:
 * executing the script only REGISTERS the factory; the body below runs at
 * materialization. Externals are limited to the shell-seeded baseline
 * (`react`, `react/jsx-runtime`). The plugin contributes ONE additive entry:
 *
 *   - `conversation.input.left` — the "Create PR" button in the composer tool
 *     row of the chat window, rendered right beside the Worktree toggle
 *     (order 45, just after its order-40 neighbor).
 *
 * Clicking posts to the host pipeline and then polls `GET /create-pr/api/
 * runs/<id>` every few seconds, mirroring the host-side run status:
 * preparing → committing → pushing → creating → waiting-ci → fixing? →
 * passed | failed | expired | cancelled | error. The last run id per session
 * survives reloads through localStorage.
 *
 * The seat is a list slot, so unmounting this plugin restores the stock
 * composer exactly.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/create-pr",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css =
			".cpr-root{display:inline-flex;align-items:center}" +
			".cpr-btn{display:inline-flex;align-items:center;gap:6px;border-radius:999px;" +
			"border:1px solid var(--dsw-alias-border-l1,#2c2c31);background:transparent;" +
			"color:var(--dsw-alias-label-tertiary,#8b8b93);padding:3px 10px;font-size:11px;line-height:16px;" +
			"cursor:pointer;user-select:none;text-decoration:none;font-family:inherit}" +
			".cpr-btn:hover{border-color:var(--dsw-alias-border-l3,#4a4a52);color:var(--dsw-alias-label-primary,#eee)}" +
			".cpr-btn[disabled]{opacity:.55;cursor:default}" +
			".cpr-btn.busy{border-color:var(--dsw-alias-border-l3,#4a4a52);" +
			"color:var(--dsw-alias-label-primary,#eee)}" +
			".cpr-btn.ok{border-color:#2f9e63;color:#34c273}" +
			".cpr-btn.warn{border-color:#b08a2e;color:#d9a53a}" +
			".cpr-btn.fail{border-color:#a04040;color:#e05656}" +
			".cpr-dot{width:7px;height:7px;border-radius:50%;flex:none;" +
			"background:var(--dsw-alias-border-l3,#55555c)}" +
			".cpr-dot.busy{background:#d9a53a;box-shadow:0 0 6px rgba(217,165,58,.6)}" +
			".cpr-dot.ok{background:#34c273;box-shadow:0 0 6px rgba(52,194,115,.7)}" +
			".cpr-dot.fail{background:#e05656;box-shadow:0 0 6px rgba(224,86,86,.7)}" +
			".cpr-label{letter-spacing:.02em}";
		const tagId = "@dsh-plugins/create-pr/button.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/create-pr";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api client
		const API = "/create-pr/api";
		const POLL_MS = 3000;

		async function apiFetch(path, options) {
			let response;
			try {
				response = await fetch(API + path, options);
			} catch (error) {
				throw new Error(`create-pr: ${String(error?.message ?? error)}`);
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

		function postRun(body) {
			return apiFetch("/create", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		}
		function fetchRun(runId) {
			return apiFetch(`/runs/${encodeURIComponent(runId)}`, { method: "GET" });
		}
		//#endregion

		//#region helpers
		const TERMINAL = new Set([
			"passed",
			"failed",
			"expired",
			"cancelled",
			"error",
		]);
		const PIPELINE = new Set(["preparing", "checking", "committing", "pushing", "creating"]);

		function storageKey(sessionId) {
			return `dsh-create-pr.run.${sessionId}`;
		}
		function readSavedRunId(sessionId) {
			try {
				return window.localStorage.getItem(storageKey(sessionId)) || null;
			} catch {
				return null;
			}
		}
		function saveRunId(sessionId, runId) {
			try {
				window.localStorage.setItem(storageKey(sessionId), runId);
			} catch {
				/* private mode: session-only */
			}
		}

		function sessionOf(props) {
			if (!props) return undefined;
			const snapshot = props.session;
			if (snapshot && typeof snapshot.sessionId === "string") {
				return snapshot.sessionId;
			}
			if (typeof props.sessionId === "string") return props.sessionId;
			return undefined;
		}

		function toneOf(run) {
			if (!run) return { className: "", dot: "" };
			if (run.status === "passed") return { className: "ok", dot: "ok" };
			if (run.status === "fixing") return { className: "warn", dot: "busy" };
			if (PIPELINE.has(run.status) || run.status === "waiting-ci") {
				return { className: run.status === "waiting-ci" ? "warn" : "busy", dot: "busy" };
			}
			return { className: "fail", dot: "fail" };
		}

		function labelOf(run) {
			if (!run) return "Create PR";
			const n = run.prNumber ? ` #${run.prNumber}` : "";
			switch (run.status) {
				case "preparing":
				case "checking":
					return `PR${n}…`;
				case "committing":
					return `${n || ""} commit…`;
				case "pushing":
					return `${n || ""} push…`;
				case "creating":
					return `${n || "PR"} open…`;
				case "waiting-ci":
					return `${n} CI…`;
				case "fixing":
					return `${n} fix…`;
				case "passed":
					return `✓${n}`;
				default:
					return `⚠${n}`;
			}
		}

		function titleOf(run) {
			if (!run) return "Commit current work and open a GitHub pull request (gh CLI)";
			const checks = Array.isArray(run.checks)
				? run.checks.map((check) => `${check.name}: ${check.conclusion}`).join("\n")
				: "";
			const parts = [
				`${run.branch} → ${run.prUrl ?? "…"}`,
				run.commitSubject ? `commit: ${run.commitSubject}` : "",
				checks,
				run.note ? `note: ${run.note}` : "",
				run.error ? `error: ${run.error}` : "",
			].filter(Boolean);
			return parts.join("\n");
		}
		//#endregion

		//#region button
		function CreatePrButton(props) {
			const sessionId = sessionOf(props);
			const [run, setRun] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);

			react.useEffect(() => {
				setRun(null);
				setError(null);
				if (!sessionId) return undefined;
				const saved = readSavedRunId(sessionId);
				if (!saved) return undefined;
				let live = true;
				fetchRun(saved)
					.then((record) => {
						if (live && record) setRun(record);
					})
					.catch(() => {});
				return () => {
					live = false;
				};
			}, [sessionId]);

			react.useEffect(() => {
				if (!run || TERMINAL.has(run.status)) return undefined;
				let live = true;
				const timer = window.setInterval(() => {
					fetchRun(run.id)
						.then((record) => {
							if (live && record) setRun(record);
						})
						.catch(() => {});
				}, POLL_MS);
				return () => {
					live = false;
					window.clearInterval(timer);
				};
			}, [run && run.id]);

			const active = run && !TERMINAL.has(run.status);
			const click = () => {
				if (busy || active) return;
				setBusy(true);
				setError(null);
				postRun({ sessionId })
					.then((record) => {
						setRun(record);
						if (sessionId) saveRunId(sessionId, record.id);
					})
					.catch((err) => setError(String(err?.message ?? err)))
					.finally(() => setBusy(false));
			};

			const tone = busy ? { className: "busy", dot: "busy" } : toneOf(run);
			const className = `cpr-btn ${tone.className}`.trim();
			const label = labelOf(run);
			const title = error ? `${titleOf(run)}\n\n${error}` : titleOf(run);

			if (run && run.status === "passed" && run.prUrl && !busy) {
				return react_jsx_runtime.jsxs(
					"span",
					{
						className: "cpr-root",
						children: [
							react_jsx_runtime.jsxs(
								"a",
								{
									className: `${className}`,
									href: run.prUrl,
									target: "_blank",
									rel: "noreferrer",
									title,
									children: [
										react_jsx_runtime.jsx("span", { className: `cpr-dot ${tone.dot}` }),
										react_jsx_runtime.jsx("span", { className: "cpr-label", children: label }),
									],
								},
							),
						],
					},
				);
			}

			return react_jsx_runtime.jsxs(
				"span",
				{
					className: "cpr-root",
					children: [
						react_jsx_runtime.jsxs(
							"button",
							{
								className,
								type: "button",
								"data-testid": "create-pr-button",
								disabled: Boolean(busy || active),
								title,
								onClick: click,
								children: [
									react_jsx_runtime.jsx("span", { className: `cpr-dot ${tone.dot}` }),
									react_jsx_runtime.jsx("span", { className: "cpr-label", children: label }),
								],
							},
						),
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
						id: "create-pr-button",
						order: 45,
					},
					CreatePrButton,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
