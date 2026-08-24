/**
 * Client-bundle contract check for @dsh-plugins/scheduled-tasks: executes
 * lib/client.js in a stubbed browser surface (module loader, document,
 * window), materializes the factory with stub React externals, asserts the
 * Settings-modal slot registration, and smoke-renders the settings page.
 *
 *   node test/client-check.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const bundlePath = fileURLToPath(new URL("../lib/client.js", import.meta.url));
const source = readFileSync(bundlePath, "utf8");

// ---- stub browser surface --------------------------------------------------

const registrations = [];
const sandbox = {
	document: {
		querySelector: () => null,
		createElement: () => ({
			dataset: {},
			set textContent(value) {
				this._css = value;
			},
			get textContent() {
				return this._css;
			},
		}),
		head: {
			appendChild(node) {
				sandbox.appendedStyle = node;
			},
		},
	},
};
sandbox.window = sandbox;
sandbox.window.__ModuleLoader__ = {
	load(registration) {
		registrations.push(registration);
	},
};

vm.createContext(sandbox);
new vm.Script(source, { filename: "lib/client.js" }).runInContext(sandbox);

assert.equal(registrations.length, 1, "script must register exactly one factory");
const registration = registrations[0];
assert.equal(
	registration.id,
	"@dsh-plugins/scheduled-tasks",
	"registration id must equal the package name",
);
assert.equal(typeof registration.factory, "function", "registration must carry a factory");

// ---- manifest contract ------------------------------------------------------
// The harness client-module scan resolves `<name>/package.json`; without an
// explicit "./package.json" export Node throws ERR_PACKAGE_PATH_NOT_EXPORTED
// and the scan silently DROPS the plugin from the browser boot graph.
const manifest = JSON.parse(
	readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
assert.equal(manifest.exports?.["./package.json"], "./package.json");
assert.equal(manifest.exports?.["./client"], "./lib/client.js");
assert.equal(manifest.dsh?.client?.platform, "web");

// ---- materialize ------------------------------------------------------------

function makeStubReact() {
	const hooks = {
		useState: (init) => [typeof init === "function" ? init() : init, () => {}],
		useEffect: () => undefined,
		useRef: (value) => ({ current: value }),
		useCallback: (fn) => fn,
		useMemo: (factory) => factory(),
		Fragment: "Fragment",
	};
	return hooks;
}
const jsxStub = (type, props) => ({ type, props });
const requireStub = (specifier) => {
	if (specifier === "react") return makeStubReact();
	if (specifier === "react/jsx-runtime") return { jsx: jsxStub, jsxs: jsxStub };
	throw new Error(`unexpected external request: ${specifier}`);
};

let exportsFace;
assert.doesNotThrow(
	() => {
		exportsFace = registration.factory(requireStub);
	},
	"factory must materialize without touching real DOM/network",
);
assert.equal(typeof exportsFace.apply, "function");
assert.deepEqual([...exportsFace.inject], ["slots"]);

// ---- plugin body behavior ---------------------------------------------------

const injectedSlots = [];
const registeredEntries = [];
const fakeCtx = {
	slots: {
		inject(slotName, factory) {
			injectedSlots.push(slotName);
			factory();
		},
		register(options, component) {
			registeredEntries.push({ options, component });
			return () => {};
		},
	},
};
exportsFace.apply(fakeCtx);

assert.deepEqual(injectedSlots, ["settings.section"], "must contribute one Settings section");
assert.equal(registeredEntries.length, 1);
const entry = registeredEntries[0];
assert.equal(entry.options.name, "settings.section");
assert.equal(entry.options.id, "scheduled-tasks");
assert.equal(entry.options.label, "Scheduled Tasks");
assert.equal(typeof entry.component, "function");

// ---- smoke render -----------------------------------------------------------

const tree = entry.component({});
assert.equal(tree.type, "div");
assert.match(String(tree.props.className), /stq-root/);
const rendered = JSON.stringify(tree);
assert.ok(rendered.includes("Scheduled Tasks"), "page carries its title");
assert.ok(rendered.includes("Nouvelle tâche"), "create button present on the empty state");
assert.ok(rendered.includes("Aucune tâche planifiée"), "empty state invites creating a task");

// ---- stylesheet -------------------------------------------------------------

assert.ok(sandbox.appendedStyle, "bundle must inject its stylesheet at materialization");
assert.match(sandbox.appendedStyle.textContent, /\.stq-root\{/);
// Native control popups (select dropdowns, datalist suggestions) follow the
// used color-scheme; the app never declares one page-wide, so the form opts
// its own subtree in per active theme — otherwise popup text renders dark on
// this dark UI (unreadable).
const css = sandbox.appendedStyle.textContent;
assert.match(css, /\.stq-root\{color-scheme:light;/);
assert.match(css, /body\[data-ds-dark-theme\] \.stq-root\{color-scheme:dark\}/);

// ---- skill selector contract -------------------------------------------------
// The form offers an optional skill context right above the Prompt textarea:
// one select fed by GET /skills?workspace=… with two groups (the edited
// project's `.agents/skills` and the profile's `<DSH_HOME>/skills`). In this
// hand-written bundle source order == DOM order inside TaskForm.
assert.match(
	source,
	/getSkills\s*=\s*\(workspace\)\s*=>\s*apiFetch\(`\/skills/,
	"bundle must fetch the /skills endpoint",
);
assert.ok(source.includes("SkillField"), "bundle defines the skill field component");
const skillFieldAt = source.indexOf('"stq-field stq-skill"');
const promptLabelAt = source.indexOf('children: "Prompt (injecté');
assert.ok(skillFieldAt > -1, "skill field carries its marker class");
assert.ok(promptLabelAt > -1, "prompt label present");
assert.ok(
	skillFieldAt < promptLabelAt,
	"skill selector must render ABOVE the Prompt textarea (source order)",
);
for (const fragment of ["Projet (.agents/skills)", "Profil DSH", "— Aucune —", "(introuvable)"]) {
	assert.ok(source.includes(fragment), `skill select carries '${fragment}'`);
}
assert.ok(source.includes("parseSkillValue"), "submission encodes {source,id} for the API");

console.log("client-bundle contract OK:");
console.log("  - registers under id @dsh-plugins/scheduled-tasks");
console.log("  - injects 'settings.section' as entry 'scheduled-tasks' labeled 'Scheduled Tasks'");
console.log("  - page smoke-renders with create button + empty state");
console.log("  - skill selector above the Prompt field: /skills fetch, both optgroups, fallback option");
console.log("  - stylesheet injected at materialization, themed color-scheme for native popups");
