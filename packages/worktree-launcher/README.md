# @dsh-plugins/worktree-launcher

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
(inspired by Codex, the Claude Code app and
[worktree-mgr](https://github.com/JohnXu22786/worktree-mgr)): every **new chat
session** gets its own isolated git worktree, so parallel sessions never step
on each other's files.

```
 composer tool row (inside the card)              under the card
┌─────────────────────────────────────────────┐  ┌──────────────────────────────┐
│ [access] [plan] (🟢 Worktree)   [model] [↑] │  │ ● dsh-azure-cinder-calm  ⧉  │
└─────────────────────────────────────────────┘  └──────────────────────────────┘
        toggle — ON by default                        branch + copyable path
```

## Behavior

1. The browser half adds a **Worktree toggle to the chat window** (`conversation.input.left`),
   **active by default**, persisted in `localStorage` and synced to a host-side
   preference.
2. When a brand-new session publishes (`agent/session-start`, source `startup`
   only), it is marked eligible. Resumed, forked, compacted sessions and
   subagents never are.
3. On that session's **first real message** (`agent/inbox/claimed`, turn 1 —
   the event whose payload actually carries `turn`)
   the host materializes the worktree:
   - location `<repo>/.dsh/worktrees/dsh-word-word-word`;
   - branch `dsh-` + three random words joined by `-`, minted collision-free;
   - base = up-to-date main: `git fetch origin main`, then — "git pull au
     besoin" — a real `git pull --ff-only` when main is checked out (the usual
     case: your workspace), else a non-forced refspec fast-forward. Divergence,
     conflicts and offline all fail *harmlessly*: nothing is ever rebased or
     overwritten, and the worktree still bases on the last known remote tip;
   - `.dsh/worktrees/` is added to `.git/info/exclude` (local-only) so
     `git status` stays clean.
4. A scoped system-prompt section tells the model to run everything inside the
   worktree for that session; a chip under the composer shows branch and path.
   While a worktree is still materializing, the host holds that session's
   `system-prompt/assemble` waterfall (bounded by the fetch budget) so turn 1
   never assembles without the section — the model cannot accidentally work
   in the shared checkout.
5. **Session-list git badges.** A headless overlay entry polls
   `GET /api/session-states` and paints a small git logo on each sidebar
   session row — between the row's title and its relative-time label — colored
   by the live GitHub state of that worktree's branch:

   | Logo | Meaning |
   | --- | --- |
   | 🟢 green | worktree created, no PR for the branch yet |
   | 🔵 blue | a PR is open for the branch (checks passing, running or absent) |
   | 🔴 red | problem: a check failed, or the PR was closed unmerged |
   | 🟣 purple | the PR was merged |

   The host resolves each session's display title through the optional
   `sessionQuery` service and asks `gh pr view <branch> --json
   number,url,state,statusCheckRollup` per branch behind a TTL cache
   (`prTtlMs`). Rows are matched **by title** in the browser and painted via a
   `data-wtl-git` attribute plus pure CSS — no React-managed child node is ever
   touched. Degradation is graceful: without `gh`, without a GitHub origin, or
   when titles cannot be resolved, every badge simply stays green (or absent).

Removing the plugin (or flipping the toggle off) restores the stock composer
exactly; existing worktrees are left on disk for you to keep or prune via the
API. The badges require `gh` to be installed and authenticated (`gh auth
status`) with `repo` scope for anything beyond green.

## How it fits DSH

Dual-face cordis plugin, the same shape as `@dsh-plugins/command-deck`:

| Half | File | Role |
| --- | --- | --- |
| Host | `lib/index.js` | Registers a `prefix` route `/worktree-launcher/api` on `ctx.webServer`; runs git through `ctx.subprocess`; listens to `agent/session-start` / `agent/inbox/claimed` (plus a bounded `system-prompt/assemble` gate); contributes a scoped `systemPrompt.section` |
| Browser | `lib/client.js` | Lazy-CJS factory bundle; injects into the runtime-owned `conversation.input.left`, `conversation.composer.dock` and `shell.overlay` slots (the last one paints the session-list git badges); zero deps beyond shell-seeded React |

The browser discovers the client bundle automatically: the node half of
`dsh-client-modules` scans Loader entries for packages declaring
`dsh.client: { platform: "web" }`, hashes `exports["./client"]` into
`window.__DSH_BOOT__`, and serves it at
`/plugins/@dsh-plugins/worktree-launcher/client.js`.

## Install

```bash
# 1. Link the package into the web-surface profile's plugin tree
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-plugins
ln -s /Users/stevemagne/workspace/dsh-plugins/packages/worktree-launcher \
      ~/.dsh/profiles/web/node_modules/@dsh-plugins/worktree-launcher

# 2. Mount it as a Loader entry (~/.dsh/profiles/web/cordis.patch.yml)
#    - insert:
#        - id: worktree-launcher
#          name: '@dsh-plugins/worktree-launcher'

# 3. Restart the harness (quit dsh and relaunch) — the web surface has no
#    config hot-reload; new entries mount at boot.
```

### Config (row `config`)

| Key | Default | Meaning |
| --- | --- | --- |
| `cwd` | harness process cwd | Default repo for manual creates without an explicit root (auto mode always uses the session cwd) |
| `enabled` | `true` | Initial value of the auto-worktree preference (the toggle overrides at runtime) |
| `baseBranch` | auto (`main` → `master` → `origin/HEAD`) | Force the base branch instead of detecting it |
| `fetchTimeoutMs` | `20000` | Budget for `git fetch` / `git pull --ff-only` before degrading gracefully |
| `ghPath` | PATH lookup | Explicit `gh` binary for the PR-status probes |
| `prTtlMs` | `60000` | Cache TTL per branch before the badge feed re-runs `gh pr view` |
| `ghTimeoutMs` | `10000` | Budget for one `gh pr view` call |
| `debug` | `false` | Log best-effort failures (auto-create errors, exclude-file issues, gh probes) with `console.warn` |

## HTTP API (loopback only)

All endpoints answer JSON under the prefix route:

- `GET    /worktree-launcher/api/pref` → `{enabled}`
- `PUT    /worktree-launcher/api/pref` `{enabled:boolean}` → saved preference
- `POST   /worktree-launcher/api/worktrees` `{root?, sessionId?}` → `201` record
  (`{branch, path, root, baseBranch, baseSha, mainUpdated, note, sessionId, createdAt}`),
  `200` with `created:false` when the session is already bound
- `GET    /worktree-launcher/api/worktrees` → registry snapshot, newest first
- `GET    /worktree-launcher/api/worktrees/:branch` → one record
- `DELETE /worktree-launcher/api/worktrees/:branch[?force=1]` → remove a
  worktree (`git worktree remove`; dirty trees need `?force=1`). The minted
  `dsh-*` branch is deliberately kept on removal — it may carry commits you
  still want; drop it yourself with `git branch -D` when done.
- `GET    /worktree-launcher/api/by-session/:sessionId` → record bound to a session
- `GET    /worktree-launcher/api/session-states` → badge feed: `{states:[{sessionId,
  title, state: created\|pr\|problem\|merged, branch, prNumber?, prUrl?}]}` — one
  entry per worktree whose session title resolved (records newest first)

### Sibling contract: `bindings.json`

Every bind/unbind also rewrites `<repo>/.dsh/worktrees/bindings.json`
(inside the git-excluded area):

```json
{ "version": 1, "bindings": [ { "sessionId": "…", "branch": "dsh-…", "path": "/abs/path", "root": "…", "baseBranch": "main", "createdAt": 0 } ] }
```

[@dsh-plugins/create-pr](../create-pr/) reads this index to route its
pipeline at the owning session's worktree — plugins never import each other,
so this plain file is the shared vocabulary. The index intentionally survives
harness restarts.

Trust posture matches the harness web server itself: loopback bind, no auth,
plus a Host allowlist (`localhost`/`127.0.0.1`/`[::1]`) against DNS rebinding
and a capped request body. Git commands execute with the full privileges of
the harness process — this surface can update and create branches in any
repository the process can reach.

## Tests

```bash
node test/run.mjs           # host half over REAL temp git repos (local bare origin)
node test/client-check.mjs  # client-bundle contract (factory form, slot entries)
```
