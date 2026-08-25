/**
 * Client-bundle contract check: executes lib/client.js in a stubbed browser
 * surface (module loader, document, window), materializes the factory with
 * stub React externals, and asserts the plugin face (`inject`/`apply`) and
 * its conversation.input.left slot registration.
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
		querySelectorAll: () => [],
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
sandbox.Event = class Event {};
sandbox.HTMLTextAreaElement = class HTMLTextAreaElement {};

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
	"@dsh-plugins/voice-input",
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
	["conversation.input.left"],
	"must contribute to the composer tool row slot",
);
assert.equal(registeredEntries.length, 1);
assert.equal(registeredEntries[0].options.name, "conversation.input.left");
assert.equal(registeredEntries[0].options.id, "voice-mic");
assert.ok(registeredEntries[0].options.order > 45, "sits after create-pr in the tool row");
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
	/\.vi-btn\{/,
	"stylesheet must style the mic button",
);
assert.match(source, /webkitSpeechRecognition|SpeechRecognition/, "webapi engine present");
assert.match(source, /MediaRecorder/, "local recording engine present");
assert.ok(
	source.includes('"/voice-input/api"') && source.includes('"/transcribe"'),
	"calls its own host endpoint",
);

console.log("client-bundle contract OK:");
console.log("  - registers under id @dsh-plugins/voice-input");
console.log("  - injects into slot 'conversation.input.left' as entry 'voice-mic'");
console.log("  - both engines referenced; stylesheet injected at materialization");
