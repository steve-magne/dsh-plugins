# @dsh-plugins/scheduled-tasks

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin:
run prompts on a **cron schedule** — codex-app style background work for the
web surface.

```
 Settings modal
┌──────────────────────────────────────────────────────────┐
│ General · Appearance · Plugins · [Scheduled Tasks]       │
│ ────────────────────────────────────────────────────────  │
│  Scheduled Tasks                        [＋ Nouvelle tâche] │
│  ┌────────────────────────────────────────────────────┐  │
│  │ [0 9 * * 1-5] cyber-harp   deepseek/deepseek-chat   │  │
│  │ Audit les dépendances obsolètes et ouvre une PR…    │  │
│  │ prochain tirage lundi à 09:00 · dernière: done      │  │
│  │ ● done · PR #77   ● error   (Exécuter Éditer ⏻ ✕)   │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Behavior

1. The browser half adds a **"Scheduled Tasks" page to the Settings modal**
   (`settings.section`): a create/edit form — **workspace** (absolute path of
   the target git repository), **model** (provider + model), **cron**
   (5-field, with a live preview of the next occurrences) and the **prompt**
   injected into the LLM at every firing — above the list of defined tasks
   with their recent runs (status, PR links, notes).
2. Tasks persist in ONE JSON file under `$DSH_HOME`
   (default `~/.dsh/scheduled-tasks.json`); schedules survive harness
   restarts. A firing missed while the harness was down is skipped, never
   replayed.
3. Each firing runs three phases:
   - **worktree** — an isolated git worktree is cut under
     `<repo>/.dsh/worktrees/sched-<task>-<stamp>` from an up-to-date `main`
     (best-effort `git fetch` + fast-forward of the LOCAL main; failures
     degrade gracefully, nothing is ever rebased or overwritten);
   - **running** — ONE unattended LLM iteration executes there through the
     harness's own `agents` service (`agents.create()` → `followup()` →
     `whenIdle()` → `sessions.flush()`, the dsh-headless pattern), with the
     task's provider/model pinned through scoped waterfall listeners; the
     prompt frames the run as autonomous: commit everything, no questions,
     do not push or open PRs itself;
   - **landing** — uncommitted leftovers are committed deterministically,
     the branch is pushed and a GitHub pull request is opened via `gh`
     (adopting an existing PR for the branch), degrading with an explicit
     note when the origin is not GitHub or `gh` fails.
4. Runs are recorded (bounded tail) and visible per task in the settings
   page; `Exécuter` fires a task immediately, `⏻` pauses it without deleting.

Removing the plugin restores the stock Settings exactly; tasks and their
store file remain on disk until deleted through the API or by hand.

## How it fits DSH

Dual-face cordis plugin, the same shape as every plugin in this repo:

| Half | File | Role |
| --- | --- | --- |
| Host | `lib/index.js` | Registers the `/scheduled-tasks/api` prefix route on `ctx.webServer`; owns the scheduler tick + durable store; reads optional services (`agents`, `sessions`, `agentDefaultModel`, `workspaceRegistry`, `llm`) defensively |
| Host | `lib/runner.js` | One firing: git plumbing over `ctx.subprocess`, in-process agent iteration, `gh` landing |
| Host | `lib/cron.js` | Dependency-free 5-field cron parser + next-run math (vixie day-pair semantics) |
| Host | `lib/store.js` | Atomic JSON persistence (tmp+rename) with validation |
| Browser | `lib/client.js` | Lazy-CJS factory bundle registering one additive `settings.section` entry |

The web surface serves the bundle automatically: the node half scans Loader
entries declaring `dsh.client: { platform: "web" }` and publishes
`exports["./client"]` at `/plugins/@dsh-plugins/scheduled-tasks/client.js`.

## Install

```bash
# 1. Link the package into the web-surface profile's plugin tree
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-plugins
ln -s /Users/stevemagne/workspace/dsh-plugins/packages/scheduled-tasks \
      ~/.dsh/profiles/web/node_modules/@dsh-plugins/scheduled-tasks

# 2. Mount it as a Loader entry (~/.dsh/profiles/web/cordis.patch.yml)
#    - insert:
#        - id: scheduled-tasks
#          name: '@dsh-plugins/scheduled-tasks'
#          config:
#            cwd: /path/to/default-workspace   # optional

# 3. Restart the harness — the web surface has no config hot-reload.
```

### Config (row `config`)

| Key | Default | Meaning |
| --- | --- | --- |
| `storePath` | `<DSH_HOME>/scheduled-tasks.json` | Where tasks + runs persist |
| `baseBranch` | auto (`main` → `master` → `origin/HEAD`) | Force the base branch instead of detecting it |
| `ghPath` | resolve `gh` on PATH | Explicit GitHub CLI executable |
| `pollMs` | `15000` | Scheduler tick period (≥ 1000) |
| `maxRunMs` | `1800000` | Whole-iteration budget before the agent is torn down (min 60 s) |
| `maxRuns` | `100` | Retained run-record tail in the store |
| `debug` | `false` | Log best-effort failures with `console.warn` |

## HTTP API (loopback only)

All endpoints answer JSON under the prefix route:

- `GET  /scheduled-tasks/api/meta` → defaults (current model selection), providers/models, known workspaces, store path
- `GET  /scheduled-tasks/api/tasks` → task views incl. projected `nextRunAt`
- `POST /scheduled-tasks/api/tasks` `{workspace, model:{provider,model}|string, cron, prompt, enabled?}` → `201` task
- `PUT  /scheduled-tasks/api/tasks/:id` → partial update (same fields)
- `DELETE /scheduled-tasks/api/tasks/:id` → remove the task (runs history stays until pruned)
- `POST /scheduled-tasks/api/tasks/:id/run` → `202` enqueue one immediate firing
- `GET  /scheduled-tasks/api/runs[?taskId=]` → recorded runs, newest first
- `GET  /scheduled-tasks/api/cron-preview?expr=<cron>` → next 3 occurrences + French description, `400` when invalid

Trust posture matches the harness web server itself: loopback bind, no auth,
plus a Host allowlist (`localhost`/`127.0.0.1`/`[::1]`) against DNS rebinding
and a capped request body. **Scheduled iterations execute tools with the full
privileges of the harness process inside the chosen workspace** — treat the
prompt field like you would treat a shell alias anyone with localhost access
can trigger.

## Tests

```bash
node test/unit.mjs           # cron engine + store validation/persistence
node test/run.mjs            # full pipeline over REAL temp repos + stub agents + fake gh
node test/client-check.mjs   # client-bundle contract (factory form, settings.section entry)
```
