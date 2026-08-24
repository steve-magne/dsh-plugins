/**
 * Skill discovery for @dsh-plugins/scheduled-tasks.
 *
 * A "skill" is the standard agent-skills unit: one directory holding a
 * `SKILL.md` whose optional front matter carries `name` / `description`.
 * Two sources feed the task form's selector:
 *
 *   - `profile` — the harness profile's own skills, `<DSH_HOME>/skills/`
 *     (the directory `dsh-skill-filesystem` owns; default `~/.dsh/skills`);
 *   - `project` — the scheduled workspace's skills,
 *     `<workspace>/.agents/skills/`.
 *
 * The runner re-reads the SKILL.md at every firing so edits to a skill
 * apply to subsequent runs. Everything degrades silently to empty lists /
 * thrown read errors — a missing or unreadable skill never breaks listing.
 */

import { homedir } from "node:os";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

export const SKILL_FILE = "SKILL.md";
export const PROJECT_SKILLS_PARTS = [".agents", "skills"];
export const SKILL_SOURCES = new Set(["profile", "project"]);

/** Default profile skills root: `<DSH_HOME|~/.dsh>/skills`. */
export function defaultSkillsRoot(env = process.env) {
	const raw = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : null;
	return raw ? join(resolve(raw), "skills") : join(homedir(), ".dsh", "skills");
}

/**
 * Normalize a task's `skill` reference: `{source, id}`, `"source:id"`,
 * nullish → `null`. Ids are single folder names — path separators, `..`
 * segments, leading dots and colons are rejected so a reference can never
 * escape its source root.
 */
export function normalizeSkillRef(input) {
	if (input === undefined || input === null || input === "") return null;
	let source = input;
	let id = input;
	if (typeof input === "object" && !Array.isArray(input)) {
		source = input.source;
		id = input.id ?? input.name;
	} else if (typeof input === "string") {
		const colon = input.indexOf(":");
		if (colon > 0) {
			source = input.slice(0, colon);
			id = input.slice(colon + 1);
		} else {
			throw Object.assign(new Error(`skill: '${input}' must be 'profile:<id>' or 'project:<id>'`), {
				status: 400,
			});
		}
	}
	source = String(source ?? "").trim();
	id = typeof id === "string" ? id.trim() : "";
	if (!SKILL_SOURCES.has(source)) {
		throw Object.assign(new Error(`skill: source must be 'profile' or 'project' (got '${source}')`), {
			status: 400,
		});
	}
	if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes(":") || id.startsWith(".")) {
		throw Object.assign(new Error(`skill: '${id}' is not a valid skill folder name`), { status: 400 });
	}
	return { source, id };
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Split a SKILL.md into its front-matter fields and body. No front matter →
 * the whole text is the body. Duplicate keys keep their first occurrence.
 */
export function parseSkillDocument(text) {
	const raw = String(text ?? "");
	const match = raw.match(FRONT_MATTER);
	if (!match) return { name: undefined, description: undefined, body: raw };
	let name;
	let description;
	for (const line of match[1].split(/\r?\n/)) {
		const field = line.match(/^(name|description)\s*:\s*(.*?)\s*$/);
		if (!field) continue;
		const value = field[2].replace(/^["'](.*)["']$/, "$1").trim();
		if (!value) continue;
		if (field[1] === "name") name ??= value;
		else description ??= value;
	}
	return { name, description, body: raw.slice(match[0].length) };
}

function isAbsoluteWorkspace(workspace) {
	return typeof workspace === "string" && isAbsolute(workspace.trim());
}

// ------------------------------------------------------------------ factory

/**
 * Build the skill catalog.
 * @param {object} [deps]
 * @param {string} [deps.profileRoot] - profile skills directory (`<DSH_HOME>/skills`).
 * @param {typeof import("node:fs/promises").readdir} [deps.readDir].
 * @param {typeof import("node:fs/promises").readFile} [deps.readFile].
 * @param {typeof import("node:fs/promises").stat} [deps.stat].
 * @param {(message: string) => void} [deps.warn].
 */
export function createSkillCatalog(deps = {}) {
	const profileRoot = deps.profileRoot;
	const readDir = deps.readDir ?? readdir;
	const readFileDep = deps.readFile ?? readFile;
	const statDep = deps.stat ?? stat;
	const warn = typeof deps.warn === "function" ? deps.warn : () => {};

	/**
	 * Resolve `id` inside `root`, refusing anything that would climb out of
	 * it (absolute paths, traversal segments, symlinks are tolerated but the
	 * final containment check still holds for plain names).
	 */
	function childPath(root, id) {
		if (typeof root !== "string" || !root) return undefined;
		if (typeof id !== "string" || !id) return undefined;
		if (id.includes("/") || id.includes("\\") || id.includes("..") || id.startsWith(".")) return undefined;
		const base = resolve(root);
		const child = resolve(base, id);
		return child.startsWith(base + sep) ? child : undefined;
	}

	async function collect(root, source) {
		if (!root) return [];
		let entries;
		try {
			entries = await readDir(root, { withFileTypes: true });
		} catch {
			return []; // absent or unreadable root: an empty group, nothing more
		}
		const found = [];
		for (const entry of entries) {
			const name = typeof entry === "string" ? entry : entry?.name;
			if (typeof name !== "string" || !name || name.startsWith(".")) continue;
			try {
				const file = join(root, name, SKILL_FILE);
				const info = await statDep(file);
				if (!info.isFile()) continue;
				const parsed = parseSkillDocument(await readFileDep(file, "utf8"));
				found.push({
					source,
					id: name,
					name: parsed.name || name,
					description: parsed.description ?? "",
				});
			} catch (error) {
				warn(`scheduled-tasks: skill '${source}:${name}' unreadable: ${error?.message ?? error}`);
			}
		}
		return found.sort((a, b) => a.id.localeCompare(b.id));
	}

	/**
	 * Both groups for the form's selector. A relative/absent workspace yields
	 * an empty project group while the profile group still answers.
	 */
	async function list(workspace) {
		const projectRoot =
			isAbsoluteWorkspace(workspace)
				? join(resolve(workspace.trim()), ...PROJECT_SKILLS_PARTS)
				: undefined;
		const [profile, project] = await Promise.all([
			collect(profileRoot, "profile"),
			collect(projectRoot, "project"),
		]);
		return { profile, project };
	}

	/**
	 * Read one skill's document for injection into a firing's context.
	 * Resolves against the ORIGINAL workspace (never the worktree — the
	 * `.agents/` tree is not guaranteed to exist in a fresh checkout).
	 * Throws when unreadable; returns undefined for a nullish reference.
	 */
	async function read(ref, workspace) {
		const normalized = normalizeSkillRef(ref);
		if (!normalized) return undefined;
		const root =
			normalized.source === "profile"
				? profileRoot
				: isAbsoluteWorkspace(workspace)
					? join(resolve(workspace.trim()), ...PROJECT_SKILLS_PARTS)
					: undefined;
		const dir = root && childPath(root, normalized.id);
		if (!dir) throw new Error(`invalid skill reference '${normalized.source}:${normalized.id}'`);
		const parsed = parseSkillDocument(await readFileDep(join(dir, SKILL_FILE), "utf8"));
		return {
			source: normalized.source,
			id: normalized.id,
			name: parsed.name || normalized.id,
			body: parsed.body.trim(),
		};
	}

	return { list, read };
}
