/**
 * @dsh-plugins/scheduled-tasks — host half.
 *
 * A DeepSeek Harness (cordis) plugin that runs prompts on a cron schedule,
 * codex-app style:
 *
 *   - the browser half adds a **"Scheduled Tasks" page to the Settings
 *     modal** (`settings.section`): a create/edit form (workspace, model,
 *     cron, prompt) plus the list of defined tasks and their recent runs;
 *   - tasks persist in ONE JSON file under `$DSH_HOME` (default
 *     `~/.dsh/scheduled-tasks.json`) so schedules survive restarts; firings
 *     missed while the harness was down are skipped, never replayed;
 *   - each firing (@see lib/runner.js): an isolated git worktree is cut
 *     from an up-to-date `main` under `<repo>/.dsh/worktrees/`, ONE
 *     unattended LLM iteration runs there through the harness's own
 *     `agents` service (provider/model pinned per task), then the branch is
 *     pushed and a GitHub pull request is opened (or adopted) via `gh`.
 *
 * HTTP surface: a loopback-only JSON API under `/scheduled-tasks/api`.
 *
 * Trust posture matches every plugin in this repository: the harness web
 * server binds loopback without auth by design; this surface adds the Host
 * allowlist (localhost/127.0.0.1/[::1]) against DNS rebinding and caps
 * request bodies. Scheduled iterations execute tools with the full
 * privileges of the harness process inside the chosen workspace.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describeCron, nextRunAfter, nextRunsAfter } from "./cron.js";
import { createScheduledRunner } from "./runner.js";
import { createTaskStore, normalizeModel } from "./store.js";

/** Services this plugin needs before activation. */
export const inject = ["webServer", "subprocess"];

const API_PREFIX = "/scheduled-tasks/api";
const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_POLL_MS = 15_000;

/** Default durable store location: `<DSH_HOME|~/.dsh>/scheduled-tasks.json`. */
export function defaultStorePath(env = process.env) {
	const raw = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : null;
	return raw ? join(resolve(raw), "scheduled-tasks.json") : join(homedir(), ".dsh", "scheduled-tasks.json");
}

function httpStatusError(status, message) {
	return Object.assign(new Error(message), { status });
}

// ------------------------------------------------------------------ factory

/**
 * Build the scheduled-tasks controller (HTTP + scheduler), factored out of
 * {@link apply} so tests drive it over mock req/res with stub services.
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable.
 * @param {{create?: Function}} [deps.agents] - ctx.agents service (optional at build time).
 * @param {{flush?: Function}} [deps.sessions] - ctx.sessions service (optional).
 * @param {() => ({provider?: string, model?: string}|undefined)} [deps.defaultModel].
 * @param {() => Array<{id?: string, path?: string, title?: string}>} [deps.listWorkspaces].
 * @param {{listProviders?: Function, listModels?: Function}} [deps.llm] - ctx.llm (optional).
 * @param {string} deps.storePath - absolute JSON persistence path.
 * @param {string} [deps.baseBranch] - force the worktree base branch.
 * @param {string} [deps.ghPath] - explicit gh executable.
 * @param {number} [deps.pollMs] - scheduler tick period.
 * @param {number} [deps.maxRunMs] - per-firing iteration budget.
 * @param {(message: string) => void} [deps.warn].
 * @param {{setTimeout?: Function, clearTimeout?: Function}} [deps.timers].
 * @param {() => number} [deps.now].
 */
export function createScheduledTasks(deps) {
	const warn = typeof deps.warn === "function" ? deps.warn : () => {};
	const now = typeof deps.now === "function" ? deps.now : Date.now;
	const scheduleTick =
		typeof deps.timers?.setTimeout === "function"
			? deps.timers.setTimeout.bind(deps.timers)
			: (fn, ms) => setTimeout(fn, ms);
	const cancelTick =
		typeof deps.timers?.clearTimeout === "function"
			? deps.timers.clearTimeout.bind(deps.timers)
			: (handle) => clearTimeout(handle);
	const defaultModel =
		typeof deps.defaultModel === "function" ? deps.defaultModel : () => undefined;
	const listWorkspaces =
		typeof deps.listWorkspaces === "function" ? deps.listWorkspaces : () => [];
	const llm = deps.llm && typeof deps.llm === "object" ? deps.llm : undefined;
	const pollMs = Number.isFinite(deps.pollMs) && deps.pollMs >= 1_000 ? deps.pollMs : DEFAULT_POLL_MS;

	const store = createTaskStore({
		filePath: deps.storePath,
		now,
		warn,
		maxRuns: Number.isFinite(deps.maxRuns) ? deps.maxRuns : undefined,
	});

	const runner = createScheduledRunner({
		spawn: deps.spawn,
		resolveExecutable: deps.resolveExecutable,
		agents: deps.agents,
		sessions: deps.sessions,
		recordRun: (snapshot) => store.recordRun(snapshot),
		baseBranch: deps.baseBranch,
		ghPath: deps.ghPath,
		maxRunMs: deps.maxRunMs,
		warn,
		timers: deps.timers,
		now,
	});

	// ------------------------------------------------------------ scheduler

	/** taskId -> next scheduled epoch ms (memory-only projection). */
	const nextRuns = new Map();
	/** Task ids with a firing currently queued or running. */
	const active = new Set();
	let chain = Promise.resolve();
	let tickHandle;

	function enqueueFire(taskId) {
		if (active.has(taskId)) return false;
		active.add(taskId);
		chain = chain
			.then(() => {
				const task = store.getTask(taskId);
				if (!task || !task.enabled) return undefined;
				return runner.execute(task);
			})
			.catch((error) => {
				warn(`scheduled-tasks: firing ${taskId} crashed: ${error?.message ?? error}`);
			})
			.finally(() => {
				active.delete(taskId);
			});
		return true;
	}

	async function tick() {
		const nowMs = now();
		for (const task of store.listTasks()) {
			if (!task.enabled) {
				nextRuns.delete(task.id);
				continue;
			}
			const scheduled = nextRuns.get(task.id);
			if (scheduled !== undefined && scheduled <= nowMs) {
				nextRuns.delete(task.id);
				enqueueFire(task.id);
				continue;
			}
			if (scheduled === undefined) {
				try {
					nextRuns.set(task.id, nextRunAfter(task.cron, nowMs));
				} catch (error) {
					warn(`scheduled-tasks: task ${task.id} has an invalid cron (${error?.message ?? error})`);
				}
			}
		}
	}

	function startScheduler() {
		if (tickHandle !== undefined) return;
		const loop = () => {
			tickHandle = scheduleTick(() => {
				void Promise.resolve()
					.then(() => tick())
					.catch((error) => warn(`scheduled-tasks: scheduler tick failed: ${error?.message ?? error}`))
					.finally(loop);
			}, pollMs);
		};
		loop();
	}

	function stopScheduler() {
		if (tickHandle === undefined) return;
		cancelTick(tickHandle);
		tickHandle = undefined;
	}

	// ----------------------------------------------------------------- meta

	/** Task views with a best-effort `nextRunAt` projection for the UI. */
	function listTasksView() {
		const nowMs = now();
		return store.listTasks().map((task) => {
			let nextRunAt = null;
			if (task.enabled) {
				nextRunAt = nextRuns.get(task.id) ?? null;
				if (nextRunAt === null || nextRunAt <= nowMs) {
					try {
						nextRunAt = nextRunAfter(task.cron, nowMs);
						if (!nextRuns.has(task.id)) nextRuns.set(task.id, nextRunAt);
					} catch {
						nextRunAt = null;
					}
				}
			}
			return { ...task, nextRunAt };
		});
	}

	function defaultSelection() {
		try {
			return defaultModel() ?? undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Settings-form metadata. The provider/model lists MIRROR the chat
	 * window's model picker (`buildModelCatalog` in dsh-host-apiproxy): every
	 * provider from `llm.listProviders()` keyed by its routable ID, plus one
	 * model group per provider from `llm.listModels(id)`. Ids are the values
	 * tasks store and the runner pins; names are presentation only, so a
	 * display name must never end up where an id belongs (that mismatch made
	 * `listModels` throw and the form's model list render empty). One failing
	 * provider degrades to an empty group instead of blanking the whole list.
	 */
	async function buildMeta() {
		const selection = defaultSelection();
		const providers = [];
		if (llm && typeof llm.listProviders === "function") {
			try {
				for (const entry of await llm.listProviders()) {
					const id = typeof entry === "string" ? entry : entry?.id ?? entry?.name;
					if (typeof id !== "string" || !id || providers.some((row) => row.id === id)) continue;
					const name =
						typeof entry === "object" && typeof entry?.name === "string" && entry.name
							? entry.name
							: id;
					providers.push({ id, name });
				}
			} catch {
				/* provider directory unavailable: the form degrades to free text */
			}
		}
		const groups = await Promise.all(
			providers.map(async (provider) => {
				const models = [];
				if (llm && typeof llm.listModels === "function") {
					try {
						for (const entry of await llm.listModels(provider.id)) {
							const id = typeof entry === "string" ? entry : entry?.id ?? entry?.name;
							if (typeof id !== "string" || !id || models.some((row) => row.id === id)) continue;
							const name =
								typeof entry === "object" && typeof entry?.name === "string" && entry.name
									? entry.name
									: id;
							models.push({ id, name });
						}
					} catch {
						/* this provider's catalog is unreadable; keep its group empty */
					}
				}
				return { provider, models };
			}),
		);
		const workspaces = [];
		try {
			for (const workspace of listWorkspaces()) {
				const path = typeof workspace?.path === "string" ? workspace.path : "";
				if (!path) continue;
				workspaces.push({
					id: typeof workspace.id === "string" ? workspace.id : path,
					path,
					title: typeof workspace.title === "string" ? workspace.title : "",
				});
			}
		} catch {
			/* registry unavailable: the form falls back to free-text paths */
		}
		return {
			defaults: selection ? { provider: selection.provider, model: selection.model } : null,
			providers,
			groups: groups.filter((group) => group.models.length > 0),
			workspaces,
			storePath: deps.storePath,
		};
	}

	// ------------------------------------------------------------------ http

	async function readBody(req) {
		let size = 0;
		const chunks = [];
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) throw new Error("request body too large");
			chunks.push(chunk);
		}
		if (chunks.length === 0) return {};
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new Error("request body is not valid JSON");
		}
	}

	function sendJson(res, statusCode, payload) {
		res.writeHead(statusCode, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(JSON.stringify(payload));
	}

	function isLocalHost(req) {
		const raw = req.headers.host ?? "";
		let hostname = "";
		try {
			hostname = new URL(`http://${raw}`).hostname;
		} catch {
			return false;
		}
		return (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "[::1]" ||
			hostname === "::1"
		);
	}

	function modelOptions(body) {
		return { defaultProvider: body?.defaultProvider ?? defaultSelection()?.provider };
	}

	async function handle(req, res) {
		if (!isLocalHost(req)) {
			sendJson(res, 403, { error: "scheduled-tasks: local connections only" });
			return;
		}
		let url;
		try {
			url = new URL(req.url ?? "/", "http://invalid.local");
		} catch {
			sendJson(res, 400, { error: "malformed request URL" });
			return;
		}
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		const method = (req.method ?? "GET").toUpperCase();
		try {
			await store.load();

			if (method === "GET" && pathname === `${API_PREFIX}/meta`) {
				sendJson(res, 200, await buildMeta());
				return;
			}

			if (method === "GET" && pathname === `${API_PREFIX}/tasks`) {
				sendJson(res, 200, { tasks: listTasksView() });
				return;
			}

			if (method === "POST" && pathname === `${API_PREFIX}/tasks`) {
				const body = await readBody(req);
				const task = await store.addTask(body, modelOptions(body));
				nextRuns.delete(task.id);
				sendJson(res, 201, task);
				return;
			}

			const taskMatch = pathname.match(/^\/scheduled-tasks\/api\/tasks\/([^/]+)(\/run)?$/);
			if (taskMatch) {
				const taskId = decodeURIComponent(taskMatch[1]);
				if (taskMatch[2]) {
					if (method !== "POST") {
						sendJson(res, 405, { error: "use POST to run a task now" });
						return;
					}
					const task = store.getTask(taskId);
					if (!task) {
						sendJson(res, 404, { error: `unknown scheduled task: ${taskId}` });
						return;
					}
					const queued = enqueueFire(taskId);
					sendJson(res, 202, { taskId, queued, alreadyActive: !queued });
					return;
				}
				if (method === "PUT") {
					const body = await readBody(req);
					const task = await store.updateTask(taskId, body, modelOptions(body));
					nextRuns.delete(taskId);
					sendJson(res, 200, task);
					return;
				}
				if (method === "DELETE") {
					const task = await store.removeTask(taskId);
					nextRuns.delete(taskId);
					active.delete(taskId); // a queued firing will find nothing and no-op
					sendJson(res, 200, task);
					return;
				}
				sendJson(res, 405, { error: "use PUT or DELETE on a task" });
				return;
			}

			if (method === "GET" && pathname === `${API_PREFIX}/runs`) {
				const taskId = url.searchParams.get("taskId") ?? undefined;
				sendJson(res, 200, { runs: store.listRuns(taskId) });
				return;
			}

			if (method === "GET" && pathname === `${API_PREFIX}/cron-preview`) {
				const expression = url.searchParams.get("expr") ?? "";
				try {
					const next = nextRunsAfter(expression, now(), 3).map((ms) => new Date(ms).toISOString());
					sendJson(res, 200, { next, description: describeCron(expression) });
				} catch (error) {
					sendJson(res, 400, { error: String(error?.message ?? error) });
				}
				return;
			}

			if (method === "POST" && pathname === `${API_PREFIX}/model-normalize`) {
				const body = await readBody(req);
				sendJson(res, 200, normalizeModel(body.model ?? body, modelOptions(body).defaultProvider));
				return;
			}

			sendJson(res, 404, { error: `no such scheduled-tasks endpoint: ${method} ${pathname}` });
		} catch (error) {
			const status = typeof error?.status === "number" ? error.status : 500;
			sendJson(res, status, { error: String(error?.message ?? error) });
		}
	}

	async function shutdown() {
		stopScheduler();
		nextRuns.clear();
		active.clear();
		await runner.quiesce().catch(() => {});
		await store.save().catch(() => {});
	}

	return {
		handle,
		shutdown,
		startScheduler,
		stopScheduler,
		tick,
		store,
		buildMeta,
		enqueueFire,
	};
}

/**
 * Cordis plugin body: wire the controller to harness services and clean up
 * behind the plugin fiber.
 * @param {object} ctx - host cordis context (`webServer` + `subprocess` injected).
 * @param {object} [config] - row config
 *   `{ storePath?, baseBranch?, ghPath?, pollMs?, maxRunMs?, maxRuns?, debug? }`.
 */
export function apply(ctx, config) {
	const options = config ?? {};

	// Every scheduler timer belongs to this fiber: cleared on dispose.
	const timers = new Set();
	const safeSchedule = (fn, ms) => {
		const handle = setTimeout(() => {
			timers.delete(handle);
			fn();
		}, ms);
		timers.add(handle);
		return handle;
	};
	const safeCancel = (handle) => {
		clearTimeout(handle);
		timers.delete(handle);
	};

	const controller = createScheduledTasks({
		spawn: (spec) => ctx.subprocess.spawn(spec),
		resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
		agents: ctx.get("agents"),
		sessions: ctx.get("sessions"),
		defaultModel: () => {
			const service = ctx.get("agentDefaultModel");
			if (!service) return undefined;
			try {
				return service.currentSelection();
			} catch {
				return undefined;
			}
		},
		listWorkspaces: () => {
			const registry = ctx.get("workspaceRegistry");
			if (!registry || typeof registry.list !== "function") return [];
			try {
				return registry.list();
			} catch {
				return [];
			}
		},
		llm: ctx.get("llm"),
		storePath:
			typeof options.storePath === "string" && options.storePath.trim()
				? resolve(options.storePath.trim())
				: defaultStorePath(),
		baseBranch: typeof options.baseBranch === "string" ? options.baseBranch : undefined,
		ghPath: typeof options.ghPath === "string" ? options.ghPath : undefined,
		pollMs: Number.isFinite(options.pollMs) ? options.pollMs : undefined,
		maxRunMs: Number.isFinite(options.maxRunMs) ? options.maxRunMs : undefined,
		maxRuns: Number.isFinite(options.maxRuns) ? options.maxRuns : undefined,
		warn: options.debug ? (message) => console.warn(message) : undefined,
		timers: { setTimeout: safeSchedule, clearTimeout: safeCancel },
	});

	const disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: (req, res) => {
			void controller.handle(req, res);
		},
	});

	void controller.store.load().then(
		() => {
			controller.startScheduler();
			void controller.tick().catch(() => {});
		},
		() => {},
	);

	ctx.on("dispose", () => {
		disposeRoute();
		controller.stopScheduler();
		void controller.shutdown();
	});
}
