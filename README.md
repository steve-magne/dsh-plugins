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

## Tests

Each plugin is self-tested without cordis (stubbed services over real
subprocesses / a stubbed browser surface):

```bash
pnpm test    # runs every package's suites
```

See [AGENTS.md](AGENTS.md) for the architecture contract every plugin here
must follow.
