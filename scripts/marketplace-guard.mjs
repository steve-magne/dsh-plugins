#!/usr/bin/env node
// Marketplace guard — pre-commit enforcement of the repo's packaging contract.
//
// What it guarantees before every commit:
//   1. Every packages/<id> carries the files the DSH marketplaces and the
//      harness scan require: package.json, README.md, lib/index.js, lib/client.js.
//   2. Every manifest carries the marketplace metadata (repository.directory,
//      keywords, files whitelist, publishConfig, …) in a canonical form.
//   3. The three-way identity holds: package name ↔ client registration id
//      (lib/client.js `window.__ModuleLoader__.load({ id: … })`).
//   4. Root artifacts exist: LICENSE.md, workspace glob, private root with
//      repository, root README listing every plugin.
//   5. Every shipped lib/*.js parses (node --check).
//
// Usage:
//   node scripts/marketplace-guard.mjs          # check only
//   node scripts/marketplace-guard.mjs --fix    # normalize manifests, restage
//
// Derivable manifest fields are rewritten canonically; everything else
// (version, description, extra keywords) is author intent and only validated.
// Missing README/lib files are reported, never scaffolded.

import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OWNER_REPO = "steve-magne/dsh-plugins";
const GIT_URL = `git+https://github.com/${OWNER_REPO}.git`;
const FIX = process.argv.includes("--fix");

let failed = false;
const rewritten = [];

function fail(message) {
	failed = true;
	console.error(`✗ ${message}`);
}
function ok(message) {
	console.log(`✓ ${message}`);
}

const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
}).trim();

// ---------------------------------------------------------------------------
// Expected manifest shape for one plugin directory.
// ---------------------------------------------------------------------------

function expectedManifest(dir) {
	return {
		name: `@dsh-plugins/${dir}`,
		keywordsPrefix: ["dsh-plugin", "deepseek-harness"],
		homepage: `https://github.com/${OWNER_REPO}/tree/main/packages/${dir}#readme`,
		bugs: { url: `https://github.com/${OWNER_REPO}/issues` },
		repository: { type: "git", url: GIT_URL, directory: `packages/${dir}` },
		license: "MIT",
		author: { name: "Steve Magne", url: "https://github.com/steve-magne" },
		type: "module",
		main: "./lib/index.js",
		exports: {
			".": "./lib/index.js",
			"./client": "./lib/client.js",
			"./package.json": "./package.json",
		},
		files: ["lib", "README.md"],
		publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
	};
}

// Canonical key order; anything unknown is appended sorted so diffs stay stable.
const KEY_ORDER = [
	"name",
	"version",
	"description",
	"keywords",
	"homepage",
	"bugs",
	"repository",
	"license",
	"author",
	"type",
	"main",
	"exports",
	"files",
	"publishConfig",
	"dsh",
];

function deepEqual(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Overlay the expected fields onto the current manifest (author data kept). */
function normalizeManifest(pkg, expected, dir) {
	const out = {};
	for (const key of KEY_ORDER) {
		if (key === "name") out.name = expected.name;
		else if (key === "keywords") {
			const rest = Array.isArray(pkg.keywords)
				? pkg.keywords.filter((k) => !expected.keywordsPrefix.includes(k))
				: [];
			out.keywords = [...expected.keywordsPrefix, ...rest];
		} else if (key === "dsh") {
			out.dsh =
				pkg.dsh && pkg.dsh.client ? pkg.dsh : { client: { platform: "web", inject: [] } };
		} else if (key === "version" || key === "description") {
			if (pkg[key] !== undefined) out[key] = pkg[key];
		} else if (pkg[key] !== undefined || expected[key] !== undefined) {
			out[key] = expected[key] ?? pkg[key];
		}
	}
	for (const key of Object.keys(pkg)
		.filter((k) => !KEY_ORDER.includes(k) && k !== "private")
		.sort()) {
		out[key] = pkg[key];
	}
	return out;
}

function validateManifestContent(pkg, dir) {
	const rel = `packages/${dir}`;
	if (!pkg.version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(String(pkg.version))) {
		fail(`${rel}: "version" missing or not semver`);
	}
	if (!pkg.description || !String(pkg.description).trim()) {
		fail(`${rel}: "description" empty — marketplaces render it on the plugin card`);
	}
	if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("dsh-plugin")) {
		fail(`${rel}: "keywords" must include "dsh-plugin" (npm-search discovery)`);
	}
	if (pkg.private === true) {
		fail(`${rel}: "private": true blocks npm publication (remove it)`);
	}
	if (pkg.exports?.["./package.json"] !== "./package.json") {
		fail(
			`${rel}: exports must declare "./package.json" or the boot-graph scan silently drops the client bundle`,
		);
	}
	if (pkg.dsh?.client?.platform !== "web" || !Array.isArray(pkg.dsh?.client?.inject)) {
		fail(`${rel}: "dsh": {"client": {"platform": "web", "inject": []}} declaration missing`);
	}
}

// ---------------------------------------------------------------------------
// Per-plugin checks.
// ---------------------------------------------------------------------------

const pkgsDir = path.join(REPO, "packages");
const dirs = fs
	.readdirSync(pkgsDir, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort();

if (dirs.length === 0) fail("packages/ contains no plugin directory");

for (const dir of dirs) {
	const rel = path.join("packages", dir);
	const pkgPath = path.join(rel, "package.json");

	// --- presence -----------------------------------------------------------
	for (const required of ["README.md", path.join("lib", "index.js"), path.join("lib", "client.js")]) {
		if (!fs.existsSync(path.join(REPO, rel, required))) {
			fail(`${rel}/${required} missing — required by the marketplace listing and the DSH scan`);
		}
	}

	// --- manifest ------------------------------------------------------------
	if (!fs.existsSync(path.join(REPO, pkgPath))) {
		fail(`${pkgPath} missing`);
		continue;
	}
	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(REPO, pkgPath), "utf8"));
	} catch (error) {
		fail(`${pkgPath} is not valid JSON (${error.message})`);
		continue;
	}

	const expected = expectedManifest(dir);
	const normalized = normalizeManifest(pkg, expected, dir);

	if (!deepEqual(normalized, pkg)) {
		if (FIX) {
			fs.writeFileSync(
				path.join(REPO, pkgPath),
				JSON.stringify(normalized, null, "\t") + "\n",
			);
			rewritten.push(pkgPath);
			ok(`${pkgPath} normalized`);
		} else {
			fail(`${pkgPath} deviates from the canonical marketplace shape — run scripts/marketplace-guard.mjs --fix`);
		}
	}

	validateManifestContent(FIX ? normalized : pkg, dir);

	// --- three-way identity ---------------------------------------------------
	const clientPath = path.join(REPO, rel, "lib", "client.js");
	if (fs.existsSync(clientPath)) {
		const source = fs.readFileSync(clientPath, "utf8");
		const id = FIX ? normalized.name : pkg.name;
		const pattern = new RegExp(
			`__ModuleLoader__\\.load\\(\\{\\s*id:\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
		);
		if (!pattern.test(source)) {
			fail(
				`${rel}/lib/client.js does not register under id "${id}" — package name and loader id must stay identical`,
			);
		}
		if (!/exports\.apply\s*=/.test(source)) {
			fail(`${rel}/lib/client.js never assigns exports.apply — the bundle would mount nothing`);
		}
	}

	// --- README mentions the package ------------------------------------------
	const readmePath = path.join(REPO, rel, "README.md");
	if (fs.existsSync(readmePath)) {
		const readme = fs.readFileSync(readmePath, "utf8");
		const id = FIX ? normalized.name : pkg.name;
		if (!readme.includes(id)) {
			fail(`${rel}/README.md never mentions "${id}"`);
		}
	}

	// --- every shipped JS file parses ------------------------------------------
	const libDir = path.join(REPO, rel, "lib");
	if (fs.existsSync(libDir)) {
		for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith(".js"))) {
			const result = spawnSync(process.execPath, ["--check", path.join(libDir, file)], {
				encoding: "utf8",
			});
			if (result.status !== 0) {
				fail(`${rel}/lib/${file} fails node --check:\n${result.stderr}`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Root-level checks.
// ---------------------------------------------------------------------------

if (!fs.existsSync(path.join(REPO, "LICENSE.md"))) {
	fail("LICENSE.md missing at the repo root — GitHub then reports license: null on marketplace cards");
}

const workspaceYaml = path.join(REPO, "pnpm-workspace.yaml");
if (
	fs.existsSync(workspaceYaml) &&
	!fs.readFileSync(workspaceYaml, "utf8").includes("packages/*")
) {
	fail('pnpm-workspace.yaml must define the "packages/*" workspace glob');
}

const rootPkgPath = path.join(REPO, "package.json");
if (fs.existsSync(rootPkgPath)) {
	try {
		const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
		if (rootPkg.private !== true) fail("root package.json must stay private: true (never publish the monorepo)");
		if (rootPkg.repository?.url !== GIT_URL) fail("root package.json repository.url must point at github.com/steve-magne/dsh-plugins");
	} catch (error) {
		fail(`root package.json is not valid JSON (${error.message})`);
	}
}

const rootReadme = fs.existsSync(path.join(REPO, "README.md"))
	? fs.readFileSync(path.join(REPO, "README.md"), "utf8")
	: "";
for (const dir of dirs) {
	if (rootReadme && !rootReadme.includes(dir)) {
		fail(`README.md at the root does not mention packages/${dir} — every plugin needs a listing row`);
	}
}

// ---------------------------------------------------------------------------
// Restage what --fix touched (only files already staged; never sweep WIP).
// ---------------------------------------------------------------------------

if (FIX && rewritten.length > 0) {
	const staged = new Set(
		execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8", cwd: REPO })
			.split("\n")
			.filter(Boolean),
	);
	for (const file of rewritten) {
		if (staged.has(file)) {
			execFileSync("git", ["add", file], { cwd: REPO });
			ok(`${file} re-staged after normalization`);
		} else {
			fail(
				`${file} was auto-corrected but is not staged — run \`git add ${file}\`, otherwise the commit ships the stale manifest`,
			);
		}
	}
}

// ---------------------------------------------------------------------------

if (failed) {
	console.error(
		`\nmarketplace-guard: ${FIX ? "could not fully repair" : "pre-commit check failed"} — fix the ✗ items above.`,
	);
	process.exit(1);
}
console.log(
	rewritten.length > 0
		? `\nmarketplace-guard: OK (${rewritten.length} manifest(s) normalized)`
		: "\nmarketplace-guard: OK",
);
