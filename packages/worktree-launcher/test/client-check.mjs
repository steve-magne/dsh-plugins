/**
 * Client-bundle contract check: executes lib/client.js in a stubbed browser
 * surface (module loader, document, window), materializes the factory with
 * stub React externals, asserts the plugin face (`inject`/`apply`), its two
 * conversation-slot registrations, and smoke-renders both components.
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
	"@dsh-plugins/worktree-launcher",
	"registration id must equal the package name (boot-graph id)",
);
assert.equal(
	typeof registration.factory,
	"function",
	"registration must carry a factory",
);

// ---- manifest contract ------------------------------------------------------
// The harness client-module scan resolves `<name>/package.json` from the
// profile directory; Node throws ERR_PACKAGE_PATH_NOT_EXPORTED when `exports`
// does not declare the subpath, and the scan swallows that error — the plugin
// then silently never reaches the browser boot graph (host half still runs).
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
assert.equal(
	manifest.exports?.["./package.json"],
	"./package.json",
	"exports must expose ./package.json or the boot-graph scan drops this plugin",
);
assert.equal(
	manifest.exports?.["./client"],
	"./lib/client.js",
	"exports must map ./client to the browser bundle",
);

// ---- stub externals -------------------------------------------------------

function makeStubReact() {
	const hooks = {
		useState: (init) => [typeof init === "function" ? init() : init, () => {}],
		useEffect: () => undefined,
		useRef: (value) => ({ current: value }),
		useCallback: (fn) => fn,
		useMemo: (factory) => factory(),
	};
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
	["conversation.input.left", "conversation.composer.dock"],
	"must contribute to the composer tool row and the composer dock",
);
assert.equal(registeredEntries.length, 2);
const [toggleEntry, chipEntry] = registeredEntries;
assert.equal(toggleEntry.options.name, "conversation.input.left");
assert.equal(toggleEntry.options.id, "worktree-toggle");
assert.equal(typeof toggleEntry.component, "function");
assert.equal(chipEntry.options.name, "conversation.composer.dock");
assert.equal(chipEntry.options.id, "worktree-chip");
assert.equal(chipEntry.options.order, 10);
assert.equal(typeof chipEntry.component, "function");

// ---- component smoke render ------------------------------------------------

// Default state comes from localStorage ("absent" -> enabled).
const toggleTree = toggleEntry.component({});
assert.equal(toggleTree.type, "button", "toggle renders a <button>");
assert.equal(toggleTree.props["data-testid"], "worktree-toggle");
assert.equal(toggleTree.props["aria-pressed"], "true", "worktree defaults ON");

// Without a bound worktree record the chip renders nothing at all.
const idleChip = chipEntry.component({ session: { sessionId: "session-x" } });
assert.equal(idleChip, null, "chip must render null while no record exists");

// ---- stylesheet ------------------------------------------------------------

assert.ok(
	sandbox.appendedStyle,
	"bundle must inject its stylesheet at materialization",
);
assert.match(
	sandbox.appendedStyle.textContent,
	/\.wtl-toggle\{/,
	"stylesheet must style the toggle",
);

console.log("client-bundle contract OK:");
console.log("  - registers under id @dsh-plugins/worktree-launcher");
console.log("  - injects 'conversation.input.left' as entry 'worktree-toggle'");
console.log("  - injects 'conversation.composer.dock' as entry 'worktree-chip'");
console.log("  - toggle defaults to aria-pressed=true; chip hides while unbound");
console.log("  - stylesheet injected at materialization");
