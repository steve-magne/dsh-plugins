# @dsh-plugins/merge-pilot

DeepSeek Harness plugin bringing the GitHub-Copilot-app **“Agent Merge”**
pillar to the DSH web surface: register **any** pull request and a host-side
supervisor loop carries it through review, checks, and merge conditions while
you stay focused on judgment work.

## What it adds

A `🛬 Merge Pilot` toggle chip in the shell overlay layer opens a
right-docked panel. Paste a PR reference (URL, `o/r#123`, `#123`) and the
host-side pilot starts watching:

| Situation | What the pilot does |
| --- | --- |
| CI pending | keeps polling (`pollMs`) |
| CI failed | fetches failed-step logs (`gh run view --log-failed`) and **wakes the owning session** via `agents.get(sessionId).followup(...)` with an analysis-ready message (bounded by `maxFixRounds`) |
| Changes requested | lists the objecting reviewers (`latestReviews`) and wakes the session to address each thread |
| Green + approved + mergeable + non-draft | flips to `ready`; with **auto-merge** it runs `gh pr merge --squash/--merge/--rebase` itself (attempt budget, cooldown) |
| Merged / closed / budget exhausted | terminal statuses `merged`, `closed`, `expired`, or `blocked` (keeps polling so manual fixes are picked up) |

Statuses, check summaries, review badges, notes and a per-pilot timeline are
rendered live; manual actions: **⇓ Merge now**, **■ Stop** (cancel), forget.

Composes with [`@dsh-plugins/create-pr`](../create-pr) (create → its CI fix
loop) and [`@dsh-plugins/worktree-launcher`](../worktree-launcher)
(isolated branches) but depends on none of them.

## Install

```bash
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-plugins
ln -s "$PWD/packages/merge-pilot" \
      ~/.dsh/profiles/web/node_modules/@dsh-plugins/merge-pilot
```

Append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: merge-pilot
      name: '@dsh-plugins/merge-pilot'
      config:
        cwd: /path/to/default/repo   # repo whose origin resolves owner/name
        # mode: squash               # squash | merge | rebase
        # autoMerge: false           # merge automatically once ready
        # defaultSessionId: my-session-id   # wake target when none given
```

Restart the harness — the web surface has no config hot-reload.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `cwd` | harness cwd | Repo used for origin-derived slug fallback. |
| `defaultSessionId` | *(none)* | Session woken when a request omits one. |
| `mode` | `squash` | Default merge method (`squash\|merge\|rebase`). |
| `autoMerge` | `false` | Default auto-merge policy. |
| `deleteBranch` | `false` | Pass `--delete-branch` on merges. |
| `pollMs` | `60000` | Poll period (min 10 ms; tests use small values). |
| `checksGracePolls` | `4` | Empty-rollup patience before "no checks". |
| `maxFixRounds` | `3` | Followup wake budget per pilot. |
| `maxMergeAttempts` | `3` | Auto-merge attempt budget. |
| `maxWatchMs` | 24 h | Total watch budget per pilot. |
| `ghPath` | `PATH` lookup | Explicit `gh` binary. |

## HTTP API

All endpoints live under `/merge-pilot/api` on the loopback-only harness web
server (Host allowlist enforced, bodies capped at 64 KiB):

- `POST /pilots` `{pullRequest, repo?, sessionId?, mode?, autoMerge?, deleteBranch?}` → `201` pilot
- `GET /pilots` → `{pilots[], pollHintMs}`
- `GET /pilots/:id`
- `POST /pilots/:id/merge` `{mode?}` → merge now (409 with gh's error on failure)
- `POST /pilots/:id/cancel` → stop watching
- `DELETE /pilots/:id` → forget

## Trust posture

The harness web server binds loopback without auth by design; this surface
adds the Host allowlist (localhost/127.0.0.1/[::1]) against DNS rebinding.
The pilot runs read-only `gh` queries plus, only on your explicit request,
`gh pr merge`. Commands execute with the full privileges of the harness
process; `gh` uses the host user's keyring authentication. Session wakes post
messages into YOUR agent sessions — never push or force anything themselves;
the model decides how to comply, exactly like any other user prompt.

## Tests

```bash
node packages/merge-pilot/test/run.mjs          # host half over a fake gh
node packages/merge-pilot/test/client-check.mjs # browser-bundle contract
```
