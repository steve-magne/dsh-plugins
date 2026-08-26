/**
 * Client-bundle contract check: executes lib/client.js in a stubbed browser
 * surface (module loader, document, window), materializes the factory with
 * stub React externals, and asserts the plugin face (`inject`/`apply`) and
 * its shell.overlay slot registration.
 *
 *   node test/client-check.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const bundlePath = fileURLToPath(new URL("../lib/client.js", import.meta.url));
const source = readFileSync(bundlePath, "utf8");

// ---- stub browser surface -------------------------------------------------

const registrations = [];
const sandbox = {
	window: {},
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
sandbox.window = sandbox; // window === globalThis inside the script
sandbox.window.__ModuleLoader__ = {
	load(registration) {
		registrations.push(registration);
	},
};

vm.createContext(sandbox);
new vm.Script(source, { filename: "lib/client.js" }).runInContext(sandbox);

assert.equal(
	registrations.length,
	1,
	"script must register exactly one factory",
);
const registration = registrations[0];
assert.equal(
	registration.id,
	"@dsh-plugins/mission-control",
	"registration id must equal the package name (boot-graph id)",
);
assert.equal(
	typeof registration.factory,
	"function",
	"registration must carry a factory",
);

// ---- stub externals -------------------------------------------------------

function makeStubReact() {
	const hooks = {};
	for (const name of [
		"useState",
		"useEffect",
		"useRef",
		"useCallback",
		"useMemo",
	]) {
		hooks[name] = (...args) => ({ hook: name, args });
	}
	return hooks;
}
const jsxStub = (type, props) => ({ type, props });
const requireStub = (specifier) => {
	if (specifier === "react") return makeStubReact();
	if (specifier === "react/jsx-runtime") return { jsx: jsxStub, jsxs: jsxStub };
	throw new Error(`unexpected external request: ${specifier}`);
};

// ---- materialize ----------------------------------------------------------

let exportsFace;
assert.doesNotThrow(() => {
	exportsFace = registration.factory(requireStub);
}, "factory must materialize without touching real DOM/network");
assert.equal(typeof exportsFace.apply, "function", "exports must expose apply");
assert.ok(Array.isArray(exportsFace.inject), "exports must expose inject");
assert.deepEqual(
	[...exportsFace.inject],
	["slots"],
	"plugin declares exactly the slots service",
);

// ---- plugin body behavior --------------------------------------------------

const injectedSlots = [];
const registeredEntries = [];
const fakeCtx = {
	slots: {
		inject(slotName, factory) {
			injectedSlots.push(slotName);
			const disposer = factory();
			assert.equal(
				typeof disposer,
				"function",
				"slots.inject factory must return the registration disposer",
			);
		},
		register(options, component) {
			registeredEntries.push({ options, component });
			return () => {};
		},
	},
};
exportsFace.apply(fakeCtx);

assert.deepEqual(
	injectedSlots,
	["shell.overlay"],
	"must contribute to the shell.overlay slot",
);
assert.equal(registeredEntries.length, 1);
assert.equal(registeredEntries[0].options.name, "shell.overlay");
assert.equal(registeredEntries[0].options.id, "mission-control");
assert.equal(
	typeof registeredEntries[0].component,
	"function",
	"entry component must be a React function component",
);

assert.ok(
	sandbox.appendedStyle,
	"bundle must inject its stylesheet at materialization",
);
assert.match(
	sandbox.appendedStyle.textContent,
	/\.mc-panel\{/,
	"stylesheet must style the mission-control panel",
);

console.log("client-bundle contract OK:");
console.log("  - registers under id @dsh-plugins/mission-control");
console.log("  - injects into slot 'shell.overlay' as entry 'mission-control'");
console.log("  - stylesheet injected at materialization");
