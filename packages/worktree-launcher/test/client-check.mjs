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
assert.equal(typeof exportsFace.scanSessionRows, "function", "scanner must be exported for tests");
assert.equal(typeof exportsFace.normalizeTitle, "function", "title normalizer must be exported");

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
	["conversation.input.left", "conversation.composer.dock", "shell.overlay"],
	"must contribute to the composer tool row, the composer dock and the overlay painter",
);
assert.equal(registeredEntries.length, 3);
const [toggleEntry, chipEntry, badgesEntry] = registeredEntries;
assert.equal(toggleEntry.options.name, "conversation.input.left");
assert.equal(toggleEntry.options.id, "worktree-toggle");
assert.equal(typeof toggleEntry.component, "function");
assert.equal(chipEntry.options.name, "conversation.composer.dock");
assert.equal(chipEntry.options.id, "worktree-chip");
assert.equal(chipEntry.options.order, 10);
assert.equal(typeof chipEntry.component, "function");
assert.equal(badgesEntry.options.name, "shell.overlay");
assert.equal(badgesEntry.options.id, "session-git-badges");
assert.equal(typeof badgesEntry.component, "function");

// ---- component smoke render ------------------------------------------------

// Default state comes from localStorage ("absent" -> enabled).
const toggleTree = toggleEntry.component({});
assert.equal(toggleTree.type, "button", "toggle renders a <button>");
assert.equal(toggleTree.props["data-testid"], "worktree-toggle");
assert.equal(toggleTree.props["aria-pressed"], "true", "worktree defaults ON");

// Without a bound worktree record the chip renders nothing at all.
const idleChip = chipEntry.component({ session: { sessionId: "session-x" } });
assert.equal(idleChip, null, "chip must render null while no record exists");

// The badge painter is headless: it renders nothing and owns no DOM output.
const badgesTree = badgesEntry.component({});
assert.equal(badgesTree, null, "session-git-badges must render null");

// ---- session row scanner ----------------------------------------------------

// Minimal DOM stand-ins: just enough shape for scanSessionRows.
function fakeNode(tagName, { attrs = {}, children = [], text = "" } = {}) {
	const attributes = { ...attrs };
	return {
		tagName,
		children,
		textContent: text,
		getAttribute(name) {
			return attributes[name];
		},
		setAttribute(name, value) {
			attributes[name] = value;
		},
		removeAttribute(name) {
			delete attributes[name];
		},
		attr(name) {
			return attributes[name];
		},
	};
}

/** A sidebar session row: [status?, title, time, menu(button)]. */
function sessionRow(title, { withStatus = true } = {}) {
	const kids = [];
	if (withStatus) kids.push(fakeNode("span"));
	kids.push(fakeNode("span", { text: title }));
	kids.push(fakeNode("span", { text: "5min" }));
	kids.push(fakeNode("div", { attrs: { class: "rowActions" }, children: [fakeNode("button")] }));
	return fakeNode("div", { attrs: { role: "treeitem" }, children: kids });
}

const { scanSessionRows, normalizeTitle } = exportsFace;

assert.equal(normalizeTitle("  A \n B  "), "A B");

const body = fakeNode("body");
const sidebar = fakeNode("div", { attrs: { id: "sidebar" }, children: [] });
body.children.push(sidebar);

// A matched session row gets its state attribute…
const mergedRow = sessionRow("Refactor the parser");
// …an unknown-title row stays clean…
const strangerRow = sessionRow("Some other session");
// …workspace group rows (penultimate DIV) are never touched…
const workspaceRow = fakeNode("div", {
	attrs: { role: "treeitem" },
	children: [
		fakeNode("span"),
		fakeNode("div", { children: [fakeNode("span", { text: "Refactor the parser" })] }),
		fakeNode("div", { children: [fakeNode("button")] }),
	],
});
// …blank rows without a time/menu fail the structural test…
const blankRow = fakeNode("div", {
	attrs: { role: "treeitem" },
	children: [fakeNode("span", { text: "New Session" })],
});
// …and search results (heading/meta divs) do too.
const searchRow = fakeNode("div", {
	attrs: { role: "treeitem" },
	children: [
		fakeNode("div", { children: [fakeNode("span"), fakeNode("span", { text: "Refactor the parser" })] }),
		fakeNode("div"),
	],
});
sidebar.children.push(mergedRow, strangerRow, workspaceRow, blankRow, searchRow);

const statesByTitle = new Map([["Refactor the parser", "merged"]]);
scanSessionRows(body, statesByTitle);
assert.equal(mergedRow.attr("data-wtl-git"), "merged", "matched row is painted");
assert.equal(strangerRow.attr("data-wtl-git"), undefined, "unmatched row stays clean");
assert.equal(workspaceRow.attr("data-wtl-git"), undefined, "workspace rows untouched");
assert.equal(blankRow.attr("data-wtl-git"), undefined, "blank rows untouched");
assert.equal(searchRow.attr("data-wtl-git"), undefined, "search results untouched");

// A later pass must also CLEAR stale paint (state removed or node reused).
statesByTitle.clear();
const touched = scanSessionRows(body, statesByTitle);
assert.equal(mergedRow.attr("data-wtl-git"), undefined, "stale badge is cleared");
assert.ok(touched.has(mergedRow), "visited rows are reported for cleanup tracking");

// Whitespace in rendered titles normalizes before matching.
statesByTitle.set("Refactor the parser", "problem");
const messyRow = sessionRow("  Refactor\nthe   parser ");
sidebar.children.push(messyRow);
scanSessionRows(body, statesByTitle);
assert.equal(messyRow.attr("data-wtl-git"), "problem", "titles match after normalization");

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
assert.match(
	sandbox.appendedStyle.textContent,
	/\[data-wtl-git\] > span:nth-last-child\(2\)::before/,
	"stylesheet must draw the badge left of the relative-time label",
);
assert.match(sandbox.appendedStyle.textContent, /data-wtl-git="pr"[^}]*#4493f8/);
assert.match(sandbox.appendedStyle.textContent, /data-wtl-git="problem"[^}]*state-error-primary/);
assert.match(sandbox.appendedStyle.textContent, /data-wtl-git="merged"[^}]*#a371f7/);
assert.match(
	sandbox.appendedStyle.textContent,
	/mask:url\("data:image\/svg\+xml/,
	"badge glyph must be an inline masked SVG",
);

console.log("client-bundle contract OK:");
console.log("  - registers under id @dsh-plugins/worktree-launcher");
console.log("  - injects 'conversation.input.left' as entry 'worktree-toggle'");
console.log("  - injects 'conversation.composer.dock' as entry 'worktree-chip'");
console.log("  - injects 'shell.overlay' as headless entry 'session-git-badges'");
console.log("  - toggle defaults to aria-pressed=true; chip hides while unbound");
console.log("  - scanner paints only structurally-validated session rows by title");
console.log("  - stylesheet injected at materialization with the four badge colors");
