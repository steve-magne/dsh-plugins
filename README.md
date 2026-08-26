# dsh-plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) — dual-face cordis packages that extend the harness **web surface**
(`http://127.0.0.1:3080`). Deliberately kept out of product repositories:
harness tooling evolves on its own cadence and must not trigger product
releases or inherit product quality gates.

## Plugins

| Plugin | What it adds to the web surface |
| --- | --- |
| [`@dsh-plugins/command-deck`](packages/command-deck/) | Right-docked sidebar: save shell commands, run them on the host, stream their output, stop them in one click |
| [`@dsh-plugins/worktree-launcher`](packages/worktree-launcher/) | One isolated git worktree (`<repo>/.dsh/worktrees/dsh-word-word-word`, based on an up-to-date main) materialized for every new chat session, with an ON-by-default toggle in the composer |
| [`@dsh-plugins/create-pr`](packages/create-pr/) | One-click GitHub PR from a "Create PR" button beside the Worktree toggle: deterministic git/gh plumbing, one LLM call for the conventional-commit message, and a CI watchdog that wakes the owning session to fix failures |
| [`@dsh-plugins/scheduled-tasks`](packages/scheduled-tasks/) | "Scheduled Tasks" page in the Settings modal: cron-scheduled prompts (workspace, model, cron, prompt) where each firing cuts an isolated worktree from up-to-date main, runs one unattended LLM iteration inside it, then pushes the branch and opens a GitHub PR |
| [`@dsh-plugins/agent-terminal`](packages/agent-terminal/) | "Agent Terminal" overlay: interactive takeover console — allocate terminals on the harness host (PTY when available), watch their live output, type into them, interrupt them |
| [`@dsh-plugins/voice-input`](packages/voice-input/) | Mic toggle in the composer tool row: on-device voice dictation through the browser Speech API or a loopback-only local ASR server (whisper.cpp style) |
| [`@dsh-plugins/issue-starter`](packages/issue-starter/) | "Issues → Sessions" overlay: preview a GitHub issue, cut an isolated worktree from an up-to-date base, and launch a live agent session scoped to it (nudge included) |
| [`@dsh-plugins/mission-control`](packages/mission-control/) | "Mission Control" overlay: a GitHub-Copilot-app-style *My Work* triage inbox — review requests, your open PRs, assigned issues — each hand-offable to a running agent session in an isolated worktree |
| [`@dsh-plugins/changes-lens`](packages/changes-lens/) | "Changes Lens" overlay: a Copilot-app-style *Changes canvas* over any checkout — branch/sync state, staged/unstaged/untracked inventory with +/- stats, capped unified diffs, and recovery snapshots pinned under `refs/dsh-changes-lens/*` |
| [`@dsh-plugins/merge-pilot`](packages/merge-pilot/) | "Merge Pilot" overlay: a Copilot-app-style *Agent Merge* — register any PR and a host-side supervisor watches CI + reviews, wakes your session with failure logs or reviewer objections, then merges (squash/merge/rebase) when conditions are met |

## Repository layout

```
packages/<plugin>/
├── package.json     # "dsh": {"client": {"platform": "web"}} + exports["./client"]
├── README.md        # plugin-specific docs (install, config, API)
├── lib/index.js     # host half — cordis plugin (apply/inject), ESM
└── lib/client.js    # browser half — lazy-CJS factory bundle, no build step
```

## Installing a plugin into a DSH profile

Two artifacts, both outside this repo:

1. A symlink from the profile's plugin tree (node resolution base for the
   harness Loader):
   ```bash
   mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-plugins
   ln -s "$PWD/packages/command-deck" \
         ~/.dsh/profiles/web/node_modules/@dsh-plugins/command-deck
   ```
2. A Loader entry appended to the profile's user patch layer
   (`~/.dsh/profiles/web/cordis.patch.yml`):
   ```yaml
   - insert:
       - id: command-deck
         name: '@dsh-plugins/command-deck'
         config: {}
   ```

Then restart the harness — the web surface has **no config hot-reload**, so new
entries mount at boot only. Uninstall = remove both artifacts + restart.

## Marketplaces & npm publication

This repo carries the GitHub topic
[`dsh-plugin`](https://github.com/topics/dsh-plugin), which is what the
emerging DSH marketplaces crawl: [dshfind](https://dshfind.com) syncs the topic
daily, [deepseekplugin.org](https://deepseekplugin.org) indexes it, and verified
registries such as [YELEBAI/dsh-plugin-marketplace](https://github.com/YELEBAI/dsh-plugin-marketplace)
scan `topic:dsh-plugin` every two hours before validating manifests and loader
entries for one-click install.

Every package is independently publishable to npm under the `@dsh-plugins`
scope. Each manifest points back here via `repository.directory`, so a
marketplace listing deep-links straight to the plugin's subfolder, and its
`keywords` open with `dsh-plugin` / `deepseek-harness` for npm-search-based
discovery. Publishing one plugin (requires owning the `@dsh-plugins` scope on
npmjs.com):

```bash
cd packages/command-deck
npm publish                                   # publishConfig already forces public access
git tag command-deck-v0.1.0 && git push origin command-deck-v0.1.0   # registries pin exact refs
```

Tag releases as `<package>-v<version>` so GitHub-source installs can be pinned
to a precise ref instead of a moving `main`.

## Tests

Each plugin is self-tested without cordis (stubbed services over real
subprocesses / a stubbed browser surface):

```bash
pnpm test    # runs every package's suites
```

## Pre-commit guard

Every commit passes through [`scripts/marketplace-guard.mjs`](scripts/marketplace-guard.mjs)
(via `.githooks/pre-commit`, activate on a fresh clone with
`git config core.hooksPath .githooks`). It guarantees that the files the DSH
scan and the marketplaces read are present — per-plugin `package.json`,
`README.md`, `lib/index.js`, `lib/client.js`; root `LICENSE.md`,
`pnpm-workspace.yaml`, listing rows in this README — normalizes every manifest
to the canonical marketplace shape (`repository.directory`, keywords prefix,
`files` whitelist, `publishConfig`, exports contract), re-stages what it
repaired (staged files only, never sweeps unrelated work-in-progress), checks
the three-way identity package name ↔ client registration id, and runs
`node --check` over each shipped `lib/*.js`. Anything it cannot derive is
reported as a hard error instead of being scaffolded. Run it standalone with
`node scripts/marketplace-guard.mjs [--fix]`.

See [AGENTS.md](AGENTS.md) for the architecture contract every plugin here
must follow.

## License

[MIT](LICENSE.md).
