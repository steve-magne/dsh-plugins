/**
 * @dsh-plugins/scheduled-tasks — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form
 * (executing the script only REGISTERS the factory). It contributes ONE
 * additive entry:
 *
 *   - `settings.section` — a full "Scheduled Tasks" page inside the Settings
 *     modal: a create/edit form (workspace, model, cron with live preview,
 *     optional skill context, prompt) above the list of defined tasks with
 *     their recent runs.
 *
 * The seat is a list slot contributed additively, so unmounting the plugin
 * restores the stock Settings exactly. Externals are limited to the
 * shell-seeded baseline (`react`, `react/jsx-runtime`).
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/scheduled-tasks",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css =
			// The app never declares a page-wide `color-scheme`, so the browser
			// renders NATIVE control popups (select dropdowns, datalist
			// suggestions) in its default scheme — dark text on this dark UI,
			// i.e. unreadable. Opting this subtree in per active theme makes the
			// popups follow it (white text on dark in the dark theme).
			".stq-root{color-scheme:light;display:flex;flex-direction:column;gap:14px;font-size:13px;" +
			"color:var(--dsw-alias-label-primary,#eee);height:100%;min-height:0}" +
			"body[data-ds-dark-theme] .stq-root{color-scheme:dark}" +
			".stq-head{display:flex;align-items:center;justify-content:space-between;gap:12px}" +
			".stq-title{font-size:15px;font-weight:600;margin:0}" +
			".stq-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93);margin-top:2px}" +
			".stq-btn{border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#2c2c31);" +
			"background:var(--dsw-alias-fill-l1,#1b1b20);color:var(--dsw-alias-label-primary,#eee);" +
			"padding:5px 12px;font-size:12px;cursor:pointer}" +
			".stq-btn:hover{border-color:var(--dsw-alias-border-l3,#4a4a52)}" +
			".stq-btn.primary{background:#2f6feb;border-color:#2f6feb;color:#fff}" +
			".stq-btn.danger:hover{border-color:#e5534b;color:#e5534b}" +
			".stq-btn.small{padding:2px 9px;font-size:11px}" +
			".stq-btn[disabled]{opacity:.45;cursor:not-allowed}" +
			".stq-form{display:flex;flex-direction:column;gap:10px;border:1px solid " +
			"var(--dsw-alias-border-l1,#2c2c31);border-radius:10px;padding:14px;" +
			"background:var(--dsw-alias-fill-l1,#1b1b20)}" +
			".stq-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
			"@media(max-width:760px){.stq-grid{grid-template-columns:1fr}}" +
			".stq-field{display:flex;flex-direction:column;gap:4px;min-width:0}" +
			".stq-field label{font-size:11px;color:var(--dsw-alias-label-secondary,#b9b9c0)}" +
			".stq-field input,.stq-field textarea,.stq-field select{" +
			"background:var(--dsw-alias-fill-l0,#141418);color:var(--dsw-alias-label-primary,#eee);" +
			"border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:7px;padding:6px 9px;" +
			"font-size:12.5px;width:100%;box-sizing:border-box}" +
			".stq-field textarea{font-family:inherit;resize:vertical;min-height:96px}" +
			".stq-field input.mono,.stq-cron-desc{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,monospace)}" +
			".stq-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93);line-height:1.5}" +
			".stq-hint.err{color:#e5534b}" +
			".stq-hint.ok{color:#57ab5a}" +
			".stq-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
			".stq-error{border:1px solid #e5534b;border-radius:8px;padding:7px 10px;color:#e5534b;" +
			"font-size:12px;background:rgba(229,83,75,.08)}" +
			".stq-list{display:flex;flex-direction:column;gap:8px;overflow:auto;min-height:0}" +
			".stq-task{border:1px solid var(--dsw-alias-border-l1,#2c2c31);border-radius:10px;" +
			"padding:11px 13px;display:flex;flex-direction:column;gap:7px;" +
			"background:transparent}" +
			".stq-task.off{opacity:.55}" +
			".stq-task-main{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}" +
			".stq-cron-badge{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,monospace);" +
			"background:var(--dsw-alias-fill-l2,#232329);border-radius:6px;padding:1px 7px;font-size:11.5px}" +
			".stq-ws{font-weight:600;font-size:12.5px}" +
			".stq-model{font-size:11px;color:var(--dsw-alias-label-secondary,#b9b9c0)}" +
			".stq-prompt{font-size:12px;color:var(--dsw-alias-label-secondary,#b9b9c0);" +
			"display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
			".stq-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93)}" +
			".stq-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none;" +
			"background:var(--dsw-alias-border-l3,#55555c)}" +
			'.stq-dot[data-status="done"]{background:#57ab5a}' +
			'.stq-dot[data-status="error"]{background:#e5534b}' +
			'.stq-dot[data-status="running"],.stq-dot[data-status="worktree"],' +
			'.stq-dot[data-status="running-budget"]{background:#d29922}' +
			".stq-runs{display:flex;gap:6px;align-items:center;flex-wrap:wrap}" +
			".stq-run{display:inline-flex;align-items:center;gap:5px;font-size:11px;" +
			"color:var(--dsw-alias-label-tertiary,#8b8b93);text-decoration:none;" +
			"border:1px solid var(--dsw-alias-border-l0,#222228);border-radius:999px;padding:1px 8px}" +
			"a.stq-run:hover{border-color:var(--dsw-alias-border-l3,#4a4a52);color:var(--dsw-alias-label-primary,#eee)}" +
			".stq-empty{border:1px dashed var(--dsw-alias-border-l1,#2c2c31);border-radius:10px;" +
			"padding:26px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b8b93);font-size:12px}" +
			".stq-toggle{display:inline-flex;align-items:center;gap:6px;background:none;border:0;" +
			"cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,#b9b9c0);padding:2px 0}" +
			".stq-actions{margin-left:auto;display:flex;gap:6px;align-items:center}";
		const tagId = "@dsh-plugins/scheduled-tasks/page.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/scheduled-tasks";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api client
		const API = "/scheduled-tasks/api";

		async function apiFetch(path, options) {
			let response;
			try {
				response = await fetch(API + path, options);
			} catch (error) {
				throw new Error(`scheduled-tasks: ${String(error?.message ?? error)}`);
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok) {
				throw new Error(payload?.error ?? `HTTP ${response.status}`);
			}
			return payload;
		}

		const getMeta = () => apiFetch("/meta", { method: "GET" });
		const getTasks = () => apiFetch("/tasks", { method: "GET" });
		const getRuns = () => apiFetch("/runs", { method: "GET" });
		const createTask = (body) =>
			apiFetch("/tasks", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const updateTask = (id, body) =>
			apiFetch(`/tasks/${encodeURIComponent(id)}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const deleteTask = (id) =>
			apiFetch(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
		const runTaskNow = (id) =>
			apiFetch(`/tasks/${encodeURIComponent(id)}/run`, { method: "POST" });
		const cronPreview = (expr) =>
			apiFetch(`/cron-preview?expr=${encodeURIComponent(expr)}`, { method: "GET" });
		const getSkills = (workspace) =>
			apiFetch(`/skills?workspace=${encodeURIComponent(workspace ?? "")}`, { method: "GET" });
		//#endregion

		//#region helpers
		function formatWhen(ms) {
			if (!ms) return "";
			try {
				return new Intl.DateTimeFormat(undefined, {
					dateStyle: "medium",
					timeStyle: "short",
				}).format(new Date(ms));
			} catch {
				return new Date(ms).toLocaleString();
			}
		}

		function workspaceLabel(path) {
			const parts = String(path ?? "").split("/").filter(Boolean);
			return parts[parts.length - 1] ?? path ?? "";
		}

		function modelLabel(task) {
			return task?.model ? `${task.model.provider}/${task.model.model}` : "";
		}

		/**
		 * The provider/model pair the form displays and submits: the operator's
		 * choice first, then the edited task's stored pair, then the deployment
		 * default, then the first catalog row. Only catalog members drive
		 * preselection; an unmatched stored/custom value is kept visible through
		 * a fallback <option> instead of being silently rewritten.
		 */
		function resolveSelection(stateValue, initialValue, defaultValue, candidates) {
			for (const value of [stateValue, initialValue, defaultValue]) {
				if (value && candidates.includes(value)) return value;
			}
			return stateValue || initialValue || defaultValue || "";
		}

		/** Option label: presentation name with the routable id kept visible. */
		function optionLabel(row) {
			return row.name && row.name !== row.id ? `${row.name} (${row.id})` : row.id;
		}

		/** Wire form of a skill reference: `"source:id"`, or "" for none. */
		function skillValue(ref) {
			return ref && ref.source && ref.id ? `${ref.source}:${ref.id}` : "";
		}

		/** Split the wire form back into the API's `{source, id}` (or null). */
		function parseSkillValue(value) {
			const text = String(value ?? "").trim();
			if (!text) return null;
			const colon = text.indexOf(":");
			if (colon <= 0) return null;
			const source = text.slice(0, colon);
			const id = text.slice(colon + 1);
			return source && id ? { source, id } : null;
		}

		const ACTIVE_STATUSES = ["preparing", "worktree", "running", "landing"];
		//#endregion

		//#region cron preview field
		function CronField({ value, onChange }) {
			const [preview, setPreview] = react.useState(null);
			react.useEffect(() => {
				const trimmed = value.trim();
				if (!trimmed) {
					setPreview(null);
					return undefined;
				}
				let live = true;
				const timer = window.setTimeout(() => {
					cronPreview(trimmed)
						.then((payload) => {
							if (live) setPreview({ ok: true, ...payload });
						})
						.catch((error) => {
							if (live) setPreview({ ok: false, error: String(error.message ?? error) });
						});
				}, 350);
				return () => {
					live = false;
					window.clearTimeout(timer);
				};
			}, [value]);
			const nextLine =
				preview && preview.ok && Array.isArray(preview.next)
					? preview.next.map((iso) => formatWhen(Date.parse(iso))).join(" · ")
					: "";
			return react_jsx_runtime.jsxs("div", {
				className: "stq-field",
				children: [
					react_jsx_runtime.jsx("label", { children: "Cron (minute heure jour-du-mois mois jour-semaine)" }),
					react_jsx_runtime.jsx("input", {
						className: "mono",
						value,
						placeholder: "*/30 * * * *   ·   0 9 * * 1-5   ·   @daily",
						onChange: (event) => onChange(event.target.value),
						spellCheck: false,
					}),
					preview === null
						? react_jsx_runtime.jsx("div", { className: "stq-hint", children: "Exemples : */15 * * * *, 0 9 * * 1-5, @daily…" })
						: preview.ok
							? react_jsx_runtime.jsxs("div", {
									className: "stq-hint ok",
									children: [
										react_jsx_runtime.jsx("span", { className: "stq-cron-desc", children: preview.description }),
										nextLine ? ` → ${nextLine}` : "",
									],
								})
							: react_jsx_runtime.jsx("div", { className: "stq-hint err", children: preview.error }),
				],
			});
		}
		//#endregion

		//#region skill field
		/**
		 * Optional skill attached to the task, rendered just above the Prompt.
		 * One select, two optgroups fed by GET /skills?workspace=… (debounced):
		 * the edited project's own skills (`.agents/skills`) and the harness
		 * profile's skills (`<DSH_HOME>/skills`). A stored reference that no
		 * longer exists stays visible through a fallback option instead of
		 * being silently rewritten — same contract as the model selects.
		 */
		function SkillField({ value, onChange, workspace }) {
			const [groups, setGroups] = react.useState(null);
			react.useEffect(() => {
				let live = true;
				const timer = window.setTimeout(() => {
					getSkills(String(workspace ?? "").trim())
						.then((payload) => {
							if (live) {
								setGroups({
									profile: Array.isArray(payload?.profile) ? payload.profile : [],
									project: Array.isArray(payload?.project) ? payload.project : [],
								});
							}
						})
						.catch(() => {
							if (live) setGroups({ profile: [], project: [] });
						});
				}, 250);
				return () => {
					live = false;
					window.clearTimeout(timer);
				};
			}, [workspace]);
			const projectSkills = groups?.project ?? [];
			const profileSkills = groups?.profile ?? [];
			const known = [...projectSkills, ...profileSkills].find((row) => skillValue(row) === value);
			const fallback =
				value && value.includes(":") && !known
					? { source: value.slice(0, value.indexOf(":")), id: value.slice(value.indexOf(":") + 1), description: "" }
					: null;
			const selected = known ?? fallback;
			const option = (row) =>
				react_jsx_runtime.jsx(
					"option",
					{
						value: skillValue(row),
						title: row.description || "",
						children: row.name && row.name !== row.id ? `${row.name} (${row.id})` : row.id,
					},
					skillValue(row),
				);
			return react_jsx_runtime.jsxs("div", {
				className: "stq-field stq-skill",
				children: [
					react_jsx_runtime.jsx("label", { children: "Skill (fournie en contexte à chaque déclenchement)" }),
					react_jsx_runtime.jsxs("select", {
						value,
						onChange: (event) => onChange(event.target.value),
						children: [
							react_jsx_runtime.jsx("option", { value: "", children: "— Aucune —" }, "none"),
							projectSkills.length > 0
								? react_jsx_runtime.jsx(
										"optgroup",
										{ label: "Projet (.agents/skills)", children: projectSkills.map(option) },
										"project",
									)
								: null,
							profileSkills.length > 0
								? react_jsx_runtime.jsx(
										"optgroup",
										{ label: "Profil DSH (~/.dsh/skills)", children: profileSkills.map(option) },
										"profile",
									)
								: null,
							fallback
								? react_jsx_runtime.jsx(
										"option",
										{ value, children: `${fallback.id} (introuvable)` },
										"missing",
									)
								: null,
						].filter(Boolean),
					}),
					react_jsx_runtime.jsx("div", {
						className: "stq-hint",
						children: selected
							? selected.description || `skill ${selected.source}:${selected.id}`
							: "Contexte additionnel lu à chaque exécution : skills du projet (.agents/skills) ou du profil DSH.",
					}),
				],
			});
		}
		//#endregion

		//#region task form
		function TaskForm({ initial, meta, onCancel, onSaved }) {
			const [workspace, setWorkspace] = react.useState(initial?.workspace ?? "");
			const [cron, setCron] = react.useState(initial?.cron ?? "0 9 * * 1-5");
			const [provider, setProvider] = react.useState(initial?.model?.provider ?? "");
			const [modelName, setModelName] = react.useState(initial?.model?.model ?? "");
			const [prompt, setPrompt] = react.useState(initial?.prompt ?? "");
			const [skill, setSkill] = react.useState(skillValue(initial?.skill));
			const [enabled, setEnabled] = react.useState(initial ? initial.enabled !== false : true);
			const [error, setError] = react.useState("");
			const [saving, setSaving] = react.useState(false);

			// Same catalog the chat window's model picker shows: provider rows
			// plus one model group per routable provider id (see /meta).
			const providers = Array.isArray(meta?.providers) ? meta.providers : [];
			const groups = Array.isArray(meta?.groups) ? meta.groups : [];
			const providerIds = providers.map((row) => row.id);
			const chosenProvider = resolveSelection(
				provider,
				initial?.model?.provider,
				meta?.defaults?.provider,
				providerIds,
			);
			const effProvider =
				providers.length > 0 && !chosenProvider ? providerIds[0] : chosenProvider;
			const activeGroup = groups.find((group) => group.provider.id === effProvider) ?? null;
			const modelRows = activeGroup?.models ?? [];
			const modelIds = modelRows.map((row) => row.id);
			const chosenModel =
				provider === effProvider
					? resolveSelection(
							modelName,
							initial?.model?.provider === effProvider ? initial?.model?.model : undefined,
							meta?.defaults?.provider === effProvider ? meta?.defaults?.model : undefined,
							modelIds,
						)
					: "";
			const effModel = modelRows.length > 0 && !chosenModel ? modelIds[0] : chosenModel;

			const ready =
				workspace.trim().startsWith("/") &&
				cron.trim() &&
				effProvider.trim() &&
				effModel.trim() &&
				prompt.trim() &&
				!saving;

			const submit = () => {
				setSaving(true);
				setError("");
				const body = {
					workspace: workspace.trim(),
					cron: cron.trim(),
					model: { provider: effProvider.trim(), model: effModel.trim() },
					prompt,
					skill: parseSkillValue(skill),
					enabled,
				};
				const request = initial?.id ? updateTask(initial.id, body) : createTask(body);
				request.then(onSaved).catch((err) => {
					setError(String(err.message ?? err));
					setSaving(false);
				});
			};
			return react_jsx_runtime.jsxs("div", {
				className: "stq-form",
				children: [
					error ? react_jsx_runtime.jsx("div", { className: "stq-error", role: "alert", children: error }) : null,
					react_jsx_runtime.jsxs("div", {
						className: "stq-grid",
						children: [
							react_jsx_runtime.jsxs("div", {
								className: "stq-field",
								children: [
									react_jsx_runtime.jsx("label", { children: "Workspace (chemin abs du dépôt git)" }),
									react_jsx_runtime.jsxs("input", {
										value: workspace,
										list: "stq-workspaces",
										placeholder: "/Users/…/mon-projet",
										onChange: (event) => setWorkspace(event.target.value),
										spellCheck: false,
									}),
									react_jsx_runtime.jsx("datalist", {
										id: "stq-workspaces",
										children: (meta?.workspaces ?? []).map((ws) =>
											react_jsx_runtime.jsx("option", { value: ws.path }, ws.path),
										),
									}),
								],
							}),
							react_jsx_runtime.jsxs("div", {
								className: "stq-field",
								children: [
									react_jsx_runtime.jsx("label", { children: "Modèle (fournisseur + modèle)" }),
									react_jsx_runtime.jsxs("div", {
										className: "stq-row",
										style: { gap: "6px" },
										children: [
											providers.length > 0
												? react_jsx_runtime.jsxs("select", {
														value: effProvider,
														style: { maxWidth: "45%" },
														onChange: (event) => setProvider(event.target.value),
														children: [
															...providers.map((row) =>
																react_jsx_runtime.jsx(
																	"option",
																	{ value: row.id, title: row.id, children: optionLabel(row) },
																	row.id,
																),
															),
															effProvider && !providerIds.includes(effProvider)
																? react_jsx_runtime.jsx(
																		"option",
																		{ value: effProvider, children: `${effProvider} (hors catalogue)` },
																		effProvider,
																	)
																: null,
														].filter(Boolean),
													})
												: react_jsx_runtime.jsx("input", {
														value: provider,
														placeholder: "fournisseur",
														onChange: (event) => setProvider(event.target.value),
														spellCheck: false,
													}),
											modelRows.length > 0
												? react_jsx_runtime.jsxs("select", {
														value: effModel,
														onChange: (event) => setModelName(event.target.value),
														children: [
															...modelRows.map((row) =>
																react_jsx_runtime.jsx(
																	"option",
																	{ value: row.id, title: row.id, children: optionLabel(row) },
																	row.id,
																),
															),
															effModel && !modelIds.includes(effModel)
																? react_jsx_runtime.jsx(
																		"option",
																		{ value: effModel, children: `${effModel} (hors catalogue)` },
																		effModel,
																	)
																: null,
														].filter(Boolean),
													})
												: react_jsx_runtime.jsx("input", {
														value: provider === effProvider ? modelName : "",
														placeholder: "nom-du-modèle",
														onChange: (event) => setModelName(event.target.value),
														spellCheck: false,
													}),
										],
									}),
									react_jsx_runtime.jsx("div", {
										className: "stq-hint",
										children:
											modelRows.length > 0
												? "Même liste que le sélecteur de modèle de la fenêtre de chat."
												: "Catalogue indisponible pour ce fournisseur : saisissez l'id exact du modèle.",
									}),
								],
							}),
						],
					}),
					react_jsx_runtime.jsx(CronField, { value: cron, onChange: setCron }),
					react_jsx_runtime.jsx(SkillField, {
						value: skill,
						onChange: setSkill,
						workspace: workspace,
					}),
					react_jsx_runtime.jsxs("div", {
						className: "stq-field",
						children: [
							react_jsx_runtime.jsx("label", { children: "Prompt (injecté au LLM à chaque déclenchement)" }),
							react_jsx_runtime.jsx("textarea", {
								value: prompt,
								placeholder: "Ce que l'agent doit faire dans le worktree à chaque exécution…",
								onChange: (event) => setPrompt(event.target.value),
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						className: "stq-row",
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "stq-toggle",
								onClick: () => setEnabled((current) => !current),
								children: react_jsx_runtime.jsx("span", {
									className: enabled ? "stq-dot" : "stq-dot off-dot",
									"data-status": enabled ? "done" : undefined,
									style: enabled ? undefined : { background: "#55555c" },
								}),
							}),
							react_jsx_runtime.jsx("span", {
								className: "stq-meta",
								children: enabled ? "Tâche activée" : "Tâche en pause",
							}),
							react_jsx_runtime.jsx("div", {
								className: "stq-actions",
								style: { marginLeft: "auto" },
								children: react_jsx_runtime.jsxs(react.Fragment, {
									children: [
										react_jsx_runtime.jsx("button", {
											type: "button",
											className: "stq-btn",
											onClick: onCancel,
											children: "Annuler",
										}),
										react_jsx_runtime.jsx("button", {
											type: "button",
											className: "stq-btn primary",
											disabled: !ready,
											onClick: submit,
											children: initial?.id ? "Enregistrer" : "Créer la tâche",
										}),
									],
								}),
							}),
						],
					}),
					react_jsx_runtime.jsx("div", {
						className: "stq-hint",
						children:
							"À chaque déclenchement : un worktree est créé depuis main à jour, l'itération LLM y tourne sans supervision, puis une PR GitHub est ouverte.",
					}),
				],
			});
		}
		//#endregion

		//#region task row
		function TaskRow({ task, runs, onEdit, onChanged }) {
			const [busy, setBusy] = react.useState(false);
			const taskRuns = runs.filter((run) => run.taskId === task.id).slice(0, 4);
			const activeRun = taskRuns.find((run) => ACTIVE_STATUSES.includes(run.status));

			const act = (promise) => {
				setBusy(true);
				promise.then(onChanged).catch(() => onChanged()).finally(() => setBusy(false));
			};
			const toggleEnabled = () => {
				act(
					updateTask(task.id, { enabled: !task.enabled }).then(() => undefined),
				);
			};
			const remove = () => {
				if (!window.confirm(`Supprimer définitivement cette tâche planifiée ?`)) return;
				act(deleteTask(task.id).then(() => undefined));
			};
			const runNow = () => {
				setBusy(true);
				runTaskNow(task.id).then(onChanged).catch(() => onChanged()).finally(() => setBusy(false));
			};

			return react_jsx_runtime.jsxs("div", {
				className: task.enabled ? "stq-task" : "stq-task off",
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "stq-task-main",
						children: [
							react_jsx_runtime.jsx("span", { className: "stq-cron-badge", children: task.cron }),
							react_jsx_runtime.jsx("span", {
								className: "stq-ws",
								title: task.workspace,
								children: workspaceLabel(task.workspace),
							}),
							react_jsx_runtime.jsx("span", { className: "stq-model", children: modelLabel(task) }),
							task.skill
								? react_jsx_runtime.jsx("span", {
										className: "stq-model",
										title: `skill ${task.skill.source}:${task.skill.id}`,
										children: `◆ ${task.skill.id}`,
									})
								: null,
							react_jsx_runtime.jsx("div", {
								className: "stq-actions",
								children: react_jsx_runtime.jsxs(react.Fragment, {
									children: [
										activeRun
											? react_jsx_runtime.jsxs("span", {
													className: "stq-meta",
													children: [
														react_jsx_runtime.jsx("span", { className: "stq-dot", "data-status": activeRun.status }),
														` ${activeRun.status}…`,
													],
												})
											: react_jsx_runtime.jsx("button", {
													type: "button",
													className: "stq-btn small",
													disabled: busy,
													onClick: runNow,
													title: "Déclencher une itération maintenant",
													children: "Exécuter",
												}),
										react_jsx_runtime.jsx("button", {
											type: "button",
											className: "stq-btn small",
											disabled: busy,
											onClick: onEdit,
											children: "Éditer",
										}),
										react_jsx_runtime.jsx("button", {
											type: "button",
											className: "stq-toggle",
											disabled: busy,
											onClick: toggleEnabled,
											title: task.enabled ? "Mettre en pause" : "Réactiver",
											children: react_jsx_runtime.jsx("span", {
												className: "stq-dot",
												"data-status": task.enabled ? "done" : undefined,
												style: task.enabled ? undefined : { background: "#55555c" },
											}),
										}),
										react_jsx_runtime.jsx("button", {
											type: "button",
											className: "stq-btn small danger",
											disabled: busy,
											onClick: remove,
											title: "Supprimer la tâche",
											children: "✕",
										}),
									],
								}),
							}),
						],
					}),
					react_jsx_runtime.jsx("div", { className: "stq-prompt", title: task.prompt, children: task.prompt }),
					react_jsx_runtime.jsx("div", {
						className: "stq-meta",
						children: [
							task.enabled
								? task.nextRunAt
									? `prochain tirage ${formatWhen(task.nextRunAt)}`
									: "cron invalide"
								: "en pause",
							task.lastRunAt ? `· dernière exécution ${formatWhen(task.lastRunAt)}` : "",
							task.lastStatus ? ` (${task.lastStatus})` : "",
						]
							.filter(Boolean)
							.join(" "),
					}),
					taskRuns.length > 0
						? react_jsx_runtime.jsx("div", {
								className: "stq-runs",
								children: taskRuns.map((run) => {
									const label = `${run.status}${run.prNumber != null ? ` · PR #${run.prNumber}` : ""}`;
									return react_jsx_runtime.jsx(
										"a",
										{
											className: "stq-run",
											href: run.prUrl ?? "#",
											target: "_blank",
											rel: "noreferrer",
											title: [
												formatWhen(run.startedAt),
												run.error ?? "",
												run.note ?? "",
												run.worktreePath ?? "",
											]
												.filter(Boolean)
												.join("\n"),
											onClick: run.prUrl
												? undefined
												: (event) => {
														event.preventDefault();
													},
											children: [
												react_jsx_runtime.jsx("span", {
													className: "stq-dot",
													"data-status": run.status,
													key: "dot",
												}),
												label,
											],
										},
										run.id,
									);
								}),
							})
						: null,
				],
			});
		}
		//#endregion

		//#region page
		function ScheduledTasksPage() {
			const [meta, setMeta] = react.useState(null);
			const [tasks, setTasks] = react.useState([]);
			const [runs, setRuns] = react.useState([]);
			const [editing, setEditing] = react.useState(null); // null | {} (create) | task (edit)
			const [error, setError] = react.useState("");

			const refresh = react.useCallback(() => {
				getTasks()
					.then((payload) => {
						setTasks(Array.isArray(payload?.tasks) ? payload.tasks : []);
						setError("");
					})
					.catch((err) => setError(String(err.message ?? err)));
				getRuns()
					.then((payload) => setRuns(Array.isArray(payload?.runs) ? payload.runs : []))
					.catch(() => {});
			}, []);

			react.useEffect(() => {
				let live = true;
				getMeta()
					.then((payload) => {
						if (live) setMeta(payload);
					})
					.catch(() => {});
				refresh();
				const timer = window.setInterval(refresh, 10_000);
				return () => {
					live = false;
					window.clearInterval(timer);
				};
			}, [refresh]);

			return react_jsx_runtime.jsxs("div", {
				className: "stq-root",
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "stq-head",
						children: [
							react_jsx_runtime.jsxs("div", {
								children: [
									react_jsx_runtime.jsx("h2", { className: "stq-title", children: "Scheduled Tasks" }),
									react_jsx_runtime.jsx("div", {
										className: "stq-sub",
										children: "Prompts exécutés sur un cron : worktree depuis main, itération LLM autonome, puis pull request.",
									}),
								],
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "stq-btn primary",
								onClick: () => setEditing(editing ? null : {}),
								children: editing ? "Fermer" : "＋ Nouvelle tâche",
							}),
						],
					}),
					error ? react_jsx_runtime.jsx("div", { className: "stq-error", children: error }) : null,
					editing
						? react_jsx_runtime.jsx(TaskForm, {
								initial: editing.id ? editing : null,
								meta,
								onCancel: () => setEditing(null),
								onSaved: () => {
									setEditing(null);
									refresh();
								},
							})
						: null,
					tasks.length === 0 && !editing
						? react_jsx_runtime.jsx("div", {
								className: "stq-empty",
								children: "Aucune tâche planifiée. Créez-en une avec « ＋ Nouvelle tâche ».",
							})
						: react_jsx_runtime.jsx("div", {
								className: "stq-list",
								children: tasks.map((task) =>
									editing && editing.id === task.id ? null : (
										react_jsx_runtime.jsx(
											TaskRow,
											{
												task,
												runs,
												onEdit: () => setEditing(task),
												onChanged: refresh,
											},
											task.id,
										)
									),
								),
							}),
				],
			});
		}
		//#endregion

		//#region plugin body
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "scheduled-tasks",
						order: 55,
						label: "Scheduled Tasks",
					},
					ScheduledTasksPage,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
