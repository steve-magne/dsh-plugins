/**
 * Durable task + run storage for @dsh-plugins/scheduled-tasks.
 *
 * One JSON file (default under `~/.dsh`), written atomically (tmp + rename),
 * holding the scheduled tasks and a bounded tail of run records so schedules
 * survive harness restarts. Pure validation helpers are exported separately
 * for tests.
 */

import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { nextRunAfter } from "./cron.js";

export const STORE_VERSION = 1;
export const MAX_PROMPT_CHARS = 20_000;
export const DEFAULT_MAX_RUNS = 100;

function storeError(status, message) {
	return Object.assign(new Error(message), { status });
}

/**
 * Normalize the `model` field: `{provider, model}` object, or a
 * `"provider/model"` string (split on the FIRST slash; the model part may
 * itself contain further slashes), or a bare model id combined with
 * `defaultProvider`.
 */
export function normalizeModel(input, defaultProvider) {
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const provider = String(input.provider ?? "").trim();
		const model = String(input.model ?? "").trim();
		if (!provider || !model) {
			throw storeError(400, "model: 'provider' and 'model' are both required");
		}
		return { provider, model };
	}
	const text = String(input ?? "").trim();
	if (!text) throw storeError(400, "model is required");
	const slash = text.indexOf("/");
	if (slash > 0) {
		const provider = text.slice(0, slash).trim();
		const model = text.slice(slash + 1).trim();
		if (provider && model) return { provider, model };
		throw storeError(400, `model: cannot read '${text}'`);
	}
	if (!defaultProvider) {
		throw storeError(
			400,
			`model: '${text}' needs a provider ('provider/model' form or the row's defaultProvider)`,
		);
	}
	return { provider: defaultProvider, model: text };
}

/**
 * Validate one task-shaped input into its stored fields.
 * @param {object} input raw JSON body (create) or patch (update).
 * @param {{defaultProvider?: string}} [options]
 */
export function validateTaskFields(input, options = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw storeError(400, "request body must be a JSON object");
	}
	const workspaceRaw = String(input.workspace ?? "").trim();
	if (!workspaceRaw) throw storeError(400, "workspace is required");
	if (!isAbsolute(workspaceRaw)) {
		throw storeError(400, `workspace must be an absolute path: ${workspaceRaw}`);
	}
	const model = normalizeModel(input.model ?? input.modelSelection, options.defaultProvider);
	const cron = String(input.cron ?? "").trim();
	if (!cron) throw storeError(400, "cron is required");
	try {
		nextRunAfter(cron, Date.now());
	} catch (error) {
		throw storeError(400, String(error?.message ?? error));
	}
	const prompt = String(input.prompt ?? "").trim();
	if (!prompt) throw storeError(400, "prompt is required");
	if (prompt.length > MAX_PROMPT_CHARS) {
		throw storeError(400, `prompt exceeds ${MAX_PROMPT_CHARS} characters`);
	}
	return {
		workspace: resolve(workspaceRaw),
		model,
		cron,
		prompt,
		enabled: input.enabled === undefined ? true : Boolean(input.enabled),
	};
}

function publicTask(task) {
	return {
		id: task.id,
		workspace: task.workspace,
		model: { ...task.model },
		cron: task.cron,
		prompt: task.prompt,
		enabled: task.enabled,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		lastRunAt: task.lastRunAt ?? null,
		lastStatus: task.lastStatus ?? null,
	};
}

function publicRun(run) {
	return {
		id: run.id,
		taskId: run.taskId,
		status: run.status,
		branch: run.branch ?? null,
		worktreePath: run.worktreePath ?? null,
		sessionId: run.sessionId ?? null,
		prUrl: run.prUrl ?? null,
		prNumber: run.prNumber ?? null,
		note: run.note ?? null,
		error: run.error ?? null,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt ?? null,
	};
}

/**
 * Build the task store.
 * @param {object} deps
 * @param {string} deps.filePath - absolute JSON file path.
 * @param {() => number} [deps.now] - injectable clock.
 * @param {(message: string) => void} [deps.warn] - sink for recoverable errors.
 * @param {number} [deps.maxRuns] - retained run-record tail (newest kept).
 */
export function createTaskStore(deps) {
	const filePath = deps.filePath;
	const now = typeof deps.now === "function" ? deps.now : Date.now;
	const warn = typeof deps.warn === "function" ? deps.warn : () => {};
	const maxRuns =
		Number.isInteger(deps.maxRuns) && deps.maxRuns > 0 ? deps.maxRuns : DEFAULT_MAX_RUNS;

	/** Insertion-ordered maps. */
	const tasks = new Map();
	const runs = new Map();
	let loaded = false;

	async function load() {
		if (loaded) return;
		loaded = true;
		let text;
		try {
			text = await readFile(filePath, "utf8");
		} catch {
			return; // first boot: no store yet
		}
		let data;
		try {
			data = JSON.parse(text);
		} catch (error) {
			warn(`scheduled-tasks: store file unreadable, starting empty (${error?.message ?? error})`);
			return;
		}
		for (const task of Array.isArray(data?.tasks) ? data.tasks : []) {
			if (task && typeof task.id === "string" && task.model && typeof task.cron === "string") {
				tasks.set(task.id, task);
			}
		}
		for (const run of Array.isArray(data?.runs) ? data.runs : []) {
			if (run && typeof run.id === "string" && typeof run.taskId === "string") {
				runs.set(run.id, run);
			}
		}
	}

	async function save() {
		await mkdir(dirname(filePath), { recursive: true });
		const payload = JSON.stringify(
			{ version: STORE_VERSION, tasks: [...tasks.values()], runs: [...runs.values()] },
			null,
			"\t",
		);
		const tmp = `${filePath}.${process.pid}.tmp`;
		await writeFile(tmp, `${payload}\n`, "utf8");
		await rename(tmp, filePath);
	}

	function listTasks() {
		return [...tasks.values()].map(publicTask);
	}

	function getTask(id) {
		return tasks.get(String(id ?? ""));
	}

	function listRuns(taskId) {
		const all = [...runs.values()];
		const filtered = taskId ? all.filter((run) => run.taskId === taskId) : all;
		return filtered.map(publicRun).sort((a, b) => b.startedAt - a.startedAt);
	}

	async function addTask(input, options) {
		const fields = validateTaskFields(input, options);
		const record = {
			id: randomUUID(),
			...fields,
			createdAt: now(),
			updatedAt: now(),
			lastRunAt: null,
			lastStatus: null,
		};
		tasks.set(record.id, record);
		await save();
		return publicTask(record);
	}

	async function updateTask(id, patch, options) {
		const existing = tasks.get(String(id ?? ""));
		if (!existing) throw storeError(404, `unknown scheduled task: ${id}`);
		const merged = {
			workspace: patch.workspace !== undefined ? patch.workspace : existing.workspace,
			model:
				patch.model !== undefined
					? patch.model
					: patch.provider !== undefined && patch.modelName !== undefined
						? { provider: patch.provider, model: patch.modelName }
						: existing.model,
			cron: patch.cron !== undefined ? patch.cron : existing.cron,
			prompt: patch.prompt !== undefined ? patch.prompt : existing.prompt,
			enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled,
		};
		const fields = validateTaskFields(merged, options);
		Object.assign(existing, fields, { updatedAt: now() });
		await save();
		return publicTask(existing);
	}

	async function removeTask(id) {
		const key = String(id ?? "");
		const existing = tasks.get(key);
		if (!existing) throw storeError(404, `unknown scheduled task: ${id}`);
		tasks.delete(key);
		await save();
		return publicTask(existing);
	}

	async function setTaskEnabled(id, enabled) {
		return updateTask(id, { enabled: Boolean(enabled) });
	}

	function markStarted(taskId, runRecord) {
		const task = tasks.get(taskId);
		if (task) {
			task.lastRunAt = runRecord.startedAt;
			task.lastStatus = runRecord.status;
		}
	}

	async function recordRun(record) {
		runs.set(record.id, record);
		// Bound the tail: keep the newest maxRuns entries.
		const ordered = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
		for (const stale of ordered.slice(maxRuns)) runs.delete(stale.id);
		markStarted(record.taskId, record);
		await save();
		return publicRun(record);
	}

	return {
		load,
		save,
		listTasks,
		getTask,
		addTask,
		updateTask,
		removeTask,
		setTaskEnabled,
		recordRun,
		listRuns,
	};
}
