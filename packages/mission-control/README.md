# @dsh-plugins/mission-control

DeepSeek Harness plugin bringing the GitHub-Copilot-app **“My Work”** pillar
to the DSH web surface: one aggregated **triage inbox** of the GitHub items
that need attention right now, where every item can be handed off — in one
click — to a running agent session working inside an isolated git worktree.

## What it adds

A `🗂 Mission Control` toggle chip in the shell overlay layer opens a
left-docked inbox fed by `gh search` reads against your authenticated host
`gh` CLI:

| Section | Read |
| --- | --- |
| Review requests | `gh search prs --review-requested=@me --state=open` |
| Your open PRs | `gh search prs --author=@me --state=open` |
| Issues assigned to you | `gh search issues is:issue --assignee=@me --state=open` |

Each row shows the title (opens on github.com), `owner/repo#number`, a check
status dot (`SUCCESS` / `FAILURE` / `PENDING`), draft and review-decision
badges (`approved`, `changes requested`, `review required`).

**→ Hand off** cuts an isolated worktree
(`.dsh/worktrees/mc-<number>-<timestamp>`) from an up-to-date main/master,
launches a live agent session scoped to the item through the harness
`agents` service (the same mechanism as [`@dsh-plugins/issue-starter`](../issue-starter)),
and frames the opening prompt from the issue body or PR description. Launched
sessions are listed at the bottom of the panel with a one-line nudge input;
the registry survives in memory until disposal (FIFO-capped).

## Install

```bash
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-plugins
ln -s "$PWD/packages/mission-control" \
      ~/.dsh/profiles/web/node_modules/@dsh-plugins/mission-control
```

Append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: mission-control
      name: '@dsh-plugins/mission-control'
      config: {}
```

Restart the harness — the web surface has no config hot-reload.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `cwd` | harness cwd | Fallback local checkout used when the panel path field is empty; `gh` runs from there so your `gh` auth/hosts config applies. |
| `ghPath` | `PATH` lookup | Explicit `gh` binary. |
| `maxRuns` | `20` | FIFO cap on retained handoff records. |
| `limit` | `15` | Per-section inbox cap (hard max 50). |

## HTTP API

All endpoints live under `/mission-control/api` on the loopback-only harness
web server (Host allowlist enforced, bodies capped at 64 KiB):

- `GET  /inbox` → `{sections:[{name, items[], error}], launchable, generatedAt}`
- `POST /handoff` `{item:{kind:"issue"\|"pr", url}, cwd?}` → `201` run record
- `GET  /runs` → `{runs[], launchable}`
- `POST /runs/<id>/nudge` `{message}` → forward a user message into the session
- `DELETE /runs/<id>` → forget the record (does not kill the session)

## Trust posture

The harness web server binds loopback without auth by design; this surface
adds the Host allowlist (localhost/127.0.0.1/[::1]) against DNS rebinding.
Reads execute `gh` with the full privileges of the harness process and your
keyring authentication; hand-off runs plain git plumbing (best-effort fetch,
never rebase/force) plus one agents-service session launch.

## Tests

```bash
node packages/mission-control/test/run.mjs          # host half over mock req/res
node packages/mission-control/test/client-check.mjs # browser-bundle contract
```
