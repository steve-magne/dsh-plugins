# @dsh-plugins/create-pr

One-click GitHub pull requests from the DSH web surface. A **Create PR**
button renders in the composer tool row (`conversation.input.left`, order 45 —
right beside the [`worktree-launcher`](../worktree-launcher/) toggle) and hands
the current session's work to a host-side pipeline.

## What one click does

Every deterministic step is plain code/CLI — the LLM is used exactly once, for
the commit message:

1. **Resolve** the repository: request `root` → owning session's `cwd` → row
   config `cwd`. Refuses the base branch (`main`/`master`) and non-GitHub
   origins.
2. **Commit** uncommitted work (`git add -A` + `git commit`). The
   conventional-commit message comes from ONE `ctx.llm` streaming call over a
   truncated `git diff --cached --stat`/diff digest; off-format answers fall
   back to a deterministic `docs:/test:/chore:` message derived from file
   paths. With a clean tree the existing `base..HEAD` commits are summarized
   instead.
3. **Push** the branch (`git push -u origin <branch>`).
4. **Open** the PR (`gh pr create -R owner/repo --head … --title … --body …`);
   a PR already open for the branch is adopted, never duplicated.
5. **Watch CI (the hook mechanism).** A per-run watchdog polls
   `gh pr view --json statusCheckRollup` on a timer until every check settles.
   Polling (not webhooks) because the harness binds loopback only. On failure:
   - fetches the failing run's logs (`gh run list` → `gh run view --log-failed`,
     tail capped);
   - wakes the OWNING SESSION with `agent.followup(...)` (a plugin-source,
     notice-form user message) so the very session that did the work analyzes
     the error, fixes it, commits `fix: …`, and pushes the same branch;
   - keeps polling the same PR and flips to `passed` when CI recovers.
   Budgets: `maxFixRounds` auto-fix wakes, then terminal `failed`;
   `maxWatchMs` total watch, then `expired`. An empty rollup is tolerated for
   `checksGracePolls` polls before counting as "no checks" (`passed`).

## HTTP API (`/create-pr/api`, loopback-only)

| Route | Purpose |
| --- | --- |
| `POST /create` `{sessionId?, root?, draft?}` | start a run; `202` returns its record |
| `GET /runs` | recent runs |
| `GET /runs/<id>` | one run's status/record |
| `POST /runs/<id>/cancel` | stop the watchdog, mark `cancelled` |

Run statuses: `preparing → checking → committing → pushing → creating →
waiting-ci → fixing? → passed | failed | expired | cancelled | error`.

## Row config

```yaml
- insert:
    - id: create-pr
      name: '@dsh-plugins/create-pr'
      config:
        cwd: /path/to/project        # default repo when no root/session resolves
        # baseBranch: main           # force the PR base (default: gh default)
        # draft: false               # open draft PRs
        # pollIntervalMs: 15000      # watchdog period
        # checksGracePolls: 4        # empty-rollup tolerance
        # maxFixRounds: 2            # auto-fix wake budget
        # maxWatchMs: 1800000        # total watch budget
        # ghPath: /opt/homebrew/bin/gh
        # debug: true                # console.warn diagnostics
```

## Prerequisites

- `gh` installed and authenticated (`gh auth status`) with `repo` scope.
- The project has an `origin` remote on github.com.
- Work sits on a feature branch (the base branch is refused).

## Security posture

Same trust model as the other plugins in this repo: the harness web server
binds loopback without auth by design; this surface adds the Host allowlist
(localhost/127.0.0.1/[::1]) against DNS rebinding and caps request bodies.
Git/gh commands execute with the full privileges of the harness process; `gh`
authenticates from the host user's keyring. Child env is scrubbed of
credential-shaped names by the harness subprocess service.

## Tests

```bash
node test/run.mjs          # full pipeline offline: real temp repos + scripted fake gh
node test/client-check.mjs # client bundle contract in a VM
```
