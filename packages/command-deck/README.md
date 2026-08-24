# @dsh-plugins/command-deck

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: a
**Command Deck** for the web surface (`http://127.0.0.1:3080`) — a
right-docked sidebar where you save shell commands, run them on the harness
host, watch their output stream in, and stop them with one click.

```
⚡ Command Deck   ← floating chip, bottom-right of the shell
┌──────────────────────────────┐
│ ⚡ Command Deck            ✕ │  Esc closes
│ Name (optional)              │
│ Shell command…        + Add  │
│ COMMANDS                     │
│ ▶ pnpm dev            🗑     │  saved locally (localStorage)
│ ▶ pnpm --filter web test 🗑  │
│ RUNS                         │
│ ● pnpm dev          running  │
│ │ [streaming stdout/stderr]  │
│ │               ■ Stop       │
└──────────────────────────────┘
```

## How it fits DSH

Dual-face cordis plugin, the same shape as the built-ins:

| Half | File | Role |
| --- | --- | --- |
| Host | `lib/index.js` | Registers a `prefix` route `/command-deck/api` on `ctx.webServer`; runs commands through `ctx.subprocess` (collect-mode stdio, tree-scoped `terminate()`); keeps an in-memory run registry |
| Browser | `lib/client.js` | Lazy-CJS factory bundle; injects a component into the runtime-owned **`shell.overlay`** slot; zero deps beyond shell-seeded React |

The browser discovers the client bundle automatically: the node half of
`dsh-client-modules` scans Loader entries for packages declaring
`dsh.client: { platform: "web" }`, hashes `exports["./client"]` into
`window.__DSH_BOOT__`, and serves it at
`/plugins/@dsh-plugins/command-deck/client.js`.

## Install

```bash
# 1. Link the package into the web-surface profile's plugin tree
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-plugins
ln -s /Users/stevemagne/workspace/dsh-plugins/packages/command-deck \
      ~/.dsh/profiles/web/node_modules/@dsh-plugins/command-deck

# 2. Mount it as a Loader entry (~/.dsh/profiles/web/cordis.patch.yml)
#    - insert:
#        - id: command-deck
#          name: '@dsh-plugins/command-deck'
#          config:
#            cwd: /path/to/your/default/working/directory

# 3. Restart the harness (quit dsh and relaunch) — the web surface has no
#    config hot-reload; new entries mount at boot.
```

> A future `pnpm install` inside the profile may prune foreign symlinks —
> recreate step 1 if the deck stops loading after a profile reinstall.

### Config (row `config`)

| Key | Default | Meaning |
| --- | --- | --- |
| `cwd` | harness process cwd | Default working directory; each run may override |
| `shell` | `/bin/bash` | Executable launched as `argv[0]` |
| `shellArgs` | `["-c"]` | Arguments inserted before your command string |
| `maxFinishedRuns` | `100` | FIFO cap on retained settled runs |

## HTTP API (loopback only)

All endpoints answer JSON under the prefix route:

- `POST   /command-deck/api/runs` `{command, label?, cwd?}` → `201` run record
- `GET    /command-deck/api/runs` → registry snapshot, newest first
- `POST   /command-deck/api/runs/:id/stop` → tree-scoped SIGTERM→SIGKILL
- `DELETE /command-deck/api/runs/:id` → discard (stops first when still running)
- `GET    /command-deck/api/runs/:id/output?out=&err=` → incremental deltas
  (`{text, nextOffset, lossy}` per stream; offsets are caller-owned)

Trust posture matches the harness web server itself: loopback bind, no auth,
plus a Host allowlist (`localhost`/`127.0.0.1`/`[::1]`) against DNS rebinding.
Commands execute with the full privileges of the harness process — treat the
deck like a terminal into your machine.

Run records are in-memory: they survive page reloads while the harness lives
(still-running ones are re-adopted by the panel) and end with the harness.

## Tests

```bash
node test/run.mjs           # host half vs stub subprocess over real processes
node test/client-check.mjs  # client-bundle contract (factory form, slot entry)
```
