# dsh-plugins — Instructions agents

## What this repository is

Dual-face [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) plugins extending the harness **web surface**. Hard boundaries:

- **No dependencies.** Plugins run inside the harness's own module graph; every
  runtime dep is a supply-chain and resolution risk for zero benefit. The
  browser half may only `require()` the shell-seeded baseline: `react`,
  `react/jsx-runtime`, `@deepseek-ai/cordis`. The host half receives everything
  through cordis injection (`ctx.webServer`, `ctx.subprocess`, …).
- **Not a product repo.** Nothing here may import from or couple to any product
  codebase (cyber-harp, etc.). A plugin that starts needing product logic has
  outgrown this repo.
- **No build step.** Both halves are hand-written source files shipped as-is.

## DSH plugin architecture contract (verified against dsh 0.1.1-rc.2)

### Package shape

```jsonc
{
  "name": "@dsh-plugins/<id>",          // = boot-graph id AND Loader row name
  "type": "module",
  "exports": {
    ".": "./lib/index.js",              // host half (cordis plugin body)
    "./client": "./lib/client.js"       // browser half (served as /plugins/<name>/client.js)
  },
  "dsh": { "client": { "platform": "web", "inject": [] } }
}
```

The harness's `dsh-client-modules` node half scans active Loader entries for
`dsh.client` declarations, hashes `exports["./client"]` into
`window.__DSH_BOOT__`, and serves each bundle. **`dsh.client.inject` lists
module-graph requests (other packages' bundles), not cordis services** — leave
it empty unless you genuinely need another plugin's client bundle.

### Browser half format

Lazy CJS, exactly this registration form (script execution only REGISTERS the
factory; the body runs at materialization):

```js
window.__ModuleLoader__.load({
  id: "@dsh-plugins/<id>",              // MUST equal the package name
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // …CSS via an idempotent <style data-plugin-css="<pkg>/<file>"> tag…
    const inject = ["slots"];           // cordis SERVICES the apply body needs
    function apply(ctx) { /* … */ }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
```

UI contribution goes through the slot registry:
`ctx.slots.inject("<slot>", () => ctx.slots.register({ name: "<slot>", id,
order? }, Component))`. Useful slots: `shell.overlay` (list-kind, root scope —
rendered inside `.overlayLayer`: `position:absolute; inset:0;
pointer-events:none`, children re-enable pointer events). Prefer
`position:absolute` anchoring inside the overlay layer over `position:fixed`
(a transformed ancestor would change what fixed resolves against). Styling
uses the page's `--dsw-*` alias tokens with literal fallbacks.

### Host half format

Ordinary cordis plugin: named `inject` array + `apply(ctx, config)`; clean up
via `ctx.on("dispose")` (route disposer first, then service teardown).

- `ctx.webServer.register({ kind: 'prefix'|'exact', path, handler })` — a
  duplicate `(kind, path)` **throws** (composition-level contract); the call
  returns a disposer. Handlers own the full response lifecycle.
- `ctx.subprocess.spawn(spec)` — the spec is fully explicit (`argv`, `cwd`,
  per-stream `stdio`, `graceMs`); argv is never shell-interpreted (pass
  `['bash','-c',command]` yourself). Collect-mode readers are **offset-based
  and non-consuming** (`readFrom(offset)` → `{text, nextOffset, lossy}`),
  readable after exit. `terminate()` is tree-scoped SIGTERM→grace→SIGKILL.
  Child env is scrubbed of credential-shaped and `DSH_*` names automatically.

### Activation reality

The web surface **disables the HMR/config-watcher service**: editing
`~/.dsh/profiles/web/cordis.patch.yml` does nothing on a running instance.
Every new/changed Loader entry mounts at the next harness start. Say so; never
claim live activation.

Renaming a package touches three places that must stay identical:
`package.json` name ↔ `lib/client.js` registration id ↔ profile patch row
(`id`/`name`). After a rename: re-create the symlink under the new scope dir,
edit the patch row, restart the harness.

## Workflow

1. Read before writing; locate the touched feature across BOTH halves (a host
   endpoint usually implies a client caller and vice versa).
2. Keep business logic factored out of the cordis `apply` body into exported
   factories taking stub-able deps (see `packages/command-deck/lib/index.js`:
   `createCommandDeck({spawn, resolveExecutable, …})`) so tests run without
   cordis.
3. Validate: `pnpm test` (host-half suite drives handlers through mock req/res
   against real child processes; client-half suite executes the factory in a
   VM with stub React/DOM and asserts the slot contract). Plus
   `node --check lib/*.js`.
4. Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`).

## Security posture

Plugins register plain HTTP routes on the harness web server, which binds
loopback by default and ships without auth by design. Every new surface here
must at minimum enforce the Host allowlist pattern (`localhost` /
`127.0.0.1` / `::1`) against DNS rebinding, cap request-body size, validate
paths/directories before use, and document that commands execute with the full
privileges of the harness process. Never widen the bind without saying so
loudly.

## Never assume

DSH internals above were verified against `0.1.1-rc.2`. When something behaves
unexpectedly, inspect the installed packages under the running harness's
checkout (README files of `@deepseek-ai/*` packages are excellent) instead of
guessing from memory.
