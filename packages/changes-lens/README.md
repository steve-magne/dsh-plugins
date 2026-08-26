# @dsh-plugins/changes-lens

DeepSeek Harness plugin bringing the GitHub-Copilot-app **“Changes canvas”**
pillar to the DSH web surface: an inspectable surface over any local
checkout's pending work — the same way the Copilot app shows what an agent is
doing before you let it land.

## What it adds

A `◫ Changes Lens` toggle chip in the shell overlay layer opens a
right-docked panel over **any** directory on the harness host:

- **Branch & sync state** — current branch, upstream, `↑ahead ↓behind` badge
  (parsed from `git status -b --porcelain`);
- **File inventory** — one row per pending change with a colored status glyph,
  staged/unstaged/untracked classification (`git status --porcelain` merged
  with `git diff --numstat` + `--cached --numstat` for exact `+/−` line
  counts), auto-refreshed every 5 s while open;
- **Unified diff viewer** — per-file or whole-tree, worktree or staged view,
  add/delete/hunk coloring client-side, payloads hard-capped (512 KiB default)
  with an explicit truncation marker;
- **⌾ Snapshot** — pins the uncommitted *tracked* work into a recovery commit
  (`git stash create`, working tree untouched) referenced by
  `refs/dsh-changes-lens/<timestamp>-<sha>`: the same safety net the Copilot
  app applies before deleting session worktrees ("uncommitted work is
  snapshotted to a recovery ref"). List recent recovery refs from any clone of
  the repo with `git for-each-ref refs/dsh-changes-lens/`.

## Install

```bash
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-plugins
ln -s "$PWD/packages/changes-lens" \
      ~/.dsh/profiles/web/node_modules/@dsh-plugins/changes-lens
```

Append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: changes-lens
      name: '@dsh-plugins/changes-lens'
      config:
        defaultRoot: /path/to/your/project   # optional pre-filled root
```

Restart the harness — the web surface has no config hot-reload.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultRoot` | *(none)* | Checkout opened when the panel has no remembered root. |
| `maxDiffBytes` | `524288` | Hard cap on a single diff payload (truncated beyond). |
| `maxRecent` | `8` | MRU list of opened roots served by `GET /defaults`. |

## HTTP API

All endpoints live under `/changes-lens/api` on the loopback-only harness web
server (Host allowlist enforced, bodies capped at 64 KiB):

- `GET  /defaults` → `{defaultRoot, recent[]}`
- `POST /open` `{cwd}` → `{root, branch, upstream, ahead, behind}` (+ MRU remember)
- `GET  /status?root=…` → sync state + normalized entries + counts
- `GET  /diff?root=…&path=…&cached=0|1` → `{text, truncated}`
- `POST /snapshot` `{root}` → `{created, ref?, sha?, note?}`
- `POST /snapshots/list?root=…` → newest recovery refs of that repo

## Trust posture

The harness web server binds loopback without auth by design; this surface
adds the Host allowlist (localhost/127.0.0.1/[::1]) against DNS rebinding.
Read-only git plumbing except the snapshot pair (`stash create` +
`update-ref`) — never `checkout`, `reset`, or anything that mutates your
working tree. Paths are validated as existing directories inside a git
repository; pathspecs travel after `--`. Git executes with the full
privileges of the harness process.

Known limitation: exotic filenames quoted by `core.quotePath` are decoded
best-effort for display; rename rows show the destination path.

## Tests

```bash
node packages/changes-lens/test/run.mjs          # host half over real temp repos
node packages/changes-lens/test/client-check.mjs # browser-bundle contract
```
