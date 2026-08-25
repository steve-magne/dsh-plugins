# @dsh-plugins/issue-starter

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin:
turn a GitHub issue into a **running agent session** — the GitHub-Copilot-app
"start work from an issue" workflow, inside the web surface.

```
 🐙 Issues   ← floating chip (bottom-left, above the Terminal chip)
┌──────────────────────────────────────────────────────┐
│ 🐙 Issues → Sessions                              ✕  │
│ Repository directory…                                │
│ Issue number or …/issues/123 URL      [Preview]      │
│ owner/repo (optional gh -R override)                 │
│ ┌ #42 · Fix the flux capacitor ─ [bug] [priority:high] ┐ │
│ │ The capacitor over-fluxes when…                     │ │
│ └──────────────────────────────────────────────────┘ │
│ Provider (optional) │ Model (optional)               │
│ Isolated worktree from an up-to-date base [🚀 Launch] │
│ Launched                                             │
│ ● #42 · Fix the flux capacitor   issue-42-20260614-093000 │
└──────────────────────────────────────────────────────┘
```

## What one click does

Every step is deterministic code — no LLM is spent by the plugin itself:

1. **Preview** — `gh issue view <ref> --json number,title,body,url,labels`
   fetches the issue (bare number or full `…/issues/N` URL; optional
   `owner/repo` override for cross-repo work).
2. **Isolate** — a git worktree `<repo>/.dsh/worktrees/issue-<n>-<stamp>` is
   cut on branch `issue-<n>-<stamp>`, based on the best-known tip of
   `main`/`master`: a best-effort `git fetch origin <base>` first, then the
   remote ref if reachable, else the local ref, else `HEAD`. Fetch failures
   degrade to an explicit note in the response — nothing is ever rebased or
   overwritten. `.dsh/worktrees/` lands in `.git/info/exclude`.
3. **Launch** — through the harness's own `agents` service
   (`agents.create()` with `meta: { cwd: worktreePath }`, optional pinned
   provider/model), then one framed opening prompt: understand the issue,
   implement it, keep checks green, commit conventionally, do NOT push or
   open PRs. The session appears in the sidebar like any other and keeps
   running while you close the panel.
4. **Track & nudge** — the plugin keeps a small registry (`GET /runs`);
   `POST /runs/:id/nudge {message}` injects a follow-up user message into the
   launched session later.

## Install

```bash
# 1. Link the package into the web-surface profile's plugin tree
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-plugins
ln -s /Users/stevemagne/workspace/dsh-plugins/packages/issue-starter \
      ~/.dsh/profiles/web/node_modules/@dsh-plugins/issue-starter

# 2. Mount it as a Loader entry (~/.dsh/profiles/web/cordis.patch.yml)
#    - insert:
#        - id: issue-starter
#          name: '@dsh-plugins/issue-starter'
#          config:
#            cwd: /path/to/your/default/repository
#            # ghPath: /opt/homebrew/bin/gh

# 3. Restart the harness — the web surface has no config hot-reload; new
#    entries mount at boot.
```

Requires `gh` authenticated (`gh auth status`) for issue fetching. Without
the harness `agents` service in the composition, preview still works but
launch answers 501.

## API

Prefix route `/issue-starter/api` (Host allowlist; bodies ≤ 64 KB):

| Method & path | Body | Effect |
| --- | --- | --- |
| `POST /issues/preview` | `{issue, cwd?, repo?}` | parsed digest (body truncated to 6 000 chars) |
| `POST /issues/start` | `{issue, cwd?, repo?, model?{provider,model}}` | isolate + launch; answers the run record |
| `GET /runs` | — | registry snapshot + `launchable` |
| `POST /runs/:id/nudge` | `{message}` | follow-up message into that session |
| `DELETE /runs/:id` | — | forget the entry (the session keeps running) |

> The launched session runs with the full privileges of the harness process
> and commits to a fresh local branch only — pushing/PRs stay explicit steps
> (see [`create-pr`](../create-pr/) for the one-click landing).

## Tests

```bash
node packages/issue-starter/test/run.mjs          # scripted git+gh table, fake agents service
node packages/issue-starter/test/client-check.mjs # bundle contract in a stubbed DOM
```
