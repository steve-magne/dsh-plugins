/**
 * Client-bundle contract check: executes lib/client.js in a stubbed browser
 * surface (module loader, document, window), materializes the factory with
 * stub React externals, asserts the plugin face (`inject`/`apply`), its
 * conversation-slot registration beside the Worktree toggle, and smoke-renders
 * the button.
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
	"@dsh-plugins/create-pr",
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

function makeStubReact(stateQueue = []) {
	const hooks = {
		useState: (init) => {
			if (stateQueue.length > 0) return [stateQueue.shift(), () => {}];
			return [typeof init === "function" ? init() : init, () => {}];
		},
		useEffect: () => undefined,
		useRef: (value) => ({ current: value }),
		useCallback: (fn) => fn,
		useMemo: (factory) => factory(),
	};
	return hooks;
}
const jsxStub = (type, props) => ({ type, props });
const requireWith = (react) => (specifier) => {
	if (specifier === "react") return react;
	if (specifier === "react/jsx-runtime") return { jsx: jsxStub, jsxs: jsxStub };
	throw new Error(`unexpected external request: ${specifier}`);
};
const requireStub = requireWith(makeStubReact());

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
	"must contribute to the composer tool row",
);
assert.equal(registeredEntries.length, 1);
const [buttonEntry] = registeredEntries;
assert.equal(buttonEntry.options.name, "conversation.input.left");
assert.equal(buttonEntry.options.id, "create-pr-button");
// The Worktree toggle sits at order 40; this button renders right beside it.
assert.equal(buttonEntry.options.order, 45);
assert.equal(typeof buttonEntry.component, "function");

// ---- component smoke render ------------------------------------------------

const tree = buttonEntry.component({});
assert.equal(tree.type, "span", "button renders inside a positioning span");
const rawChildren = tree.props.children;
const button = Array.isArray(rawChildren) ? rawChildren[0] : rawChildren;
assert.equal(button.type, "button", "idle state renders a <button>");
assert.equal(button.props["data-testid"], "create-pr-button");
assert.equal(button.props.disabled, false, "idle button is clickable");
const [dot, label] = button.props.children;
assert.ok(dot.props.className.includes("cpr-dot"));
assert.equal(label.props.children, "Create PR", "idle label is 'Create PR'");

// ---- stylesheet ------------------------------------------------------------

assert.ok(
	sandbox.appendedStyle,
	"bundle must inject its stylesheet at materialization",
);
assert.match(
	sandbox.appendedStyle.textContent,
	/\.cpr-btn\{/,
	"stylesheet must style the create-pr button",
);
assert.match(
	sandbox.appendedStyle.textContent,
	/\.cpr-btn\.merged\{[^}]*#ab7df8/,
	"stylesheet must carry the VIOLET merged pill rule",
);
assert.match(
	sandbox.appendedStyle.textContent,
	/\.cpr-dot\.merged\{/,
	"stylesheet must carry the violet merged dot rule",
);

// ---- merged / passed pill rendering ---------------------------------------
// The component closes over the `react` external of ITS materialization, so
// each scripted state needs its own factory call with a seeded useState queue
// ([run, busy, error]).

function componentWithRun(run) {
	const entries = [];
	const face = registration.factory(
		requireWith(makeStubReact([run, false, null])),
	);
	face.apply({
		slots: {
			inject(slotName, factory) {
				factory();
			},
			register(options, component) {
				entries.push(component);
				return () => {};
			},
		},
	});
	assert.equal(entries.length, 1);
	return entries[0]({});
}

{
	const tree = componentWithRun({
		id: "run-merged",
		branch: "feat/widget",
		status: "merged",
		prNumber: 7,
		prUrl: "https://github.com/acme/widget/pull/7",
		prTitle: "feat(widget): ship it",
		checks: [],
		note: "merged upstream at 2026-02-06T12:00:00Z",
	});
	const children = tree.props.children;
	const link = Array.isArray(children) ? children[0] : children;
	assert.equal(link.type, "a", "a merged PR renders as a link pill");
	assert.equal(link.props.href, "https://github.com/acme/widget/pull/7");
	assert.ok(
		/\bcpr-btn merged\b/.test(link.props.className),
		`merged pill must carry the violet class, got ${link.props.className}`,
	);
	const [dot, label] = link.props.children;
	assert.ok(/\bcpr-dot merged\b/.test(dot.props.className), "merged dot must be violet");
	assert.equal(label.props.children, "merged #7", "merged label reads 'merged #n'");
}

{
	const tree = componentWithRun({
		id: "run-passed",
		branch: "feat/widget",
		status: "passed",
		prNumber: 7,
		prUrl: "https://github.com/acme/widget/pull/7",
		checks: [],
	});
	const children = tree.props.children;
	const link = Array.isArray(children) ? children[0] : children;
	assert.equal(link.type, "a");
	assert.ok(
		/\bcpr-btn ok\b/.test(link.props.className),
		"a merely-passed PR stays GREEN, distinct from the violet merged pill",
	);
	assert.equal(link.props.children[1].props.children, "✓ #7");
}

console.log("client-bundle contract OK:");
console.log("  - registers under id @dsh-plugins/create-pr");
console.log("  - injects 'conversation.input.left' as entry 'create-pr-button' (order 45)");
console.log("  - idle render: <button data-testid=create-pr-button> 'Create PR'");
console.log("  - pill lifecycle: green on CI pass, VIOLET ('merged #n') when merged");
console.log("  - stylesheet injected at materialization");
