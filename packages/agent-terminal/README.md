# @dsh-plugins/agent-terminal

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin:
an **interactive takeover console** for the web surface
(`http://127.0.0.1:3080`) — the *steering* half of the GitHub-Copilot-app
workflow. Allocate terminals on the harness host, watch what actually runs
stream in live, type into them, and interrupt them, without leaving the chat.

```
 ▮ Terminal   ← floating chip, bottom-left of the shell
┌────────────────────────────────────────────────┐
│ ▮ Agent Terminal                        [pty] ✕│  Esc closes
│ Name… │ Working directory…                     │
│ Command to run (blank = interactive shell) [+ Terminal]
│ ● echo probe                    PIPE · live    │
│ │ hello-agent                                  │
│ │ $ _                                          │ [input: type a line] [Send] ^C ■ Stop
└────────────────────────────────────────────────┘
```

## Why

The stock harness surface can run commands (`command-deck`) but is
fire-and-forget: no stdin, no interrupt. Real steering needs a terminal you
can type into while it runs — a dev server to start/stop, a test watcher to
poke, a REPL to drive, an `ssh` session to babysit. This plugin adds exactly
that, in two backends chosen at allocation time:

| Backend | How | What works |
| --- | --- | --- |
| `pty` | `ctx.subprocess.spawnTerminal(...)` when the deployed subprocess provider exposes the PTY primitive | real pseudo-terminal: programs see a tty, `^C` actually delivers `SIGINT` to the foreground process group |
| `pipe` | plain managed spawn with `stdin: 'pipe'` (automatic fallback) | line-oriented interactivity — anything reading stdin (`cat`, REPLs, prompts); foreground signals answer 409 |

The header badge always shows which backend the host offers; the browser half
degrades accordingly (^C button hidden on pipe-backed cards).

## Behavior

1. The browser half adds a floating **▮ Terminal** chip (bottom-left) opening a
   right-docked console over the `shell.overlay` slot.
2. `+ Terminal` allocates one: optional name, working directory (persisted in
   `localStorage`; default = harness cwd), and either a command to run or a
   blank field for an **interactive shell** (`$SHELL`, config override).
3. Output streams into a bounded scrollback ring per terminal (default
   512 KB), served **offset-based** to any number of readers — deltas are
   never consumed, so a page reload simply re-reads from its last offset.
4. The input line sends text as-is; Enter appends `\n`. On PTY terminals
   `^C` signals the foreground group (`SIGINT`); `■ Stop` tree-terminates.
5. Live terminals survive page reloads (re-adopted on panel open) and are
   reaped on harness shutdown through the plugin's `dispose`.

## Install

```bash
# 1. Link the package into the web-surface profile's plugin tree
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-plugins
ln -s /Users/stevemagne/workspace/dsh-plugins/packages/agent-terminal \
      ~/.dsh/profiles/web/node_modules/@dsh-plugins/agent-terminal

# 2. Mount it as a Loader entry (~/.dsh/profiles/web/cordis.patch.yml)
#    - insert:
#        - id: agent-terminal
#          name: '@dsh-plugins/agent-terminal'
#          config:
#            cwd: /path/to/default/working/directory

# 3. Restart the harness — the web surface has no config hot-reload; new
#    entries mount at boot.
```

### Config

| Key | Default | Meaning |
| --- | --- | --- |
| `cwd` | process cwd | working directory used when a request omits one |
| `shell` | `$SHELL` else `/bin/bash` | interactive shell + `-c` runner |
| `maxTerminals` | `6` | cap on simultaneously LIVE terminals (409 beyond) |
| `scrollbackBytes` | `524288` | retained output budget per terminal (oldest trimmed first; readers get `lossy` deltas) |

## API

Prefix route `/agent-terminal/api` (Host allowlist: `localhost` / `127.0.0.1` /
`::1`; bodies capped at 64 KB; input writes at 8 000 chars):

| Method & path | Body | Effect |
| --- | --- | --- |
| `POST /terminals` | `{argv?, command?, cwd?, rows?, cols?, label?}` | allocate (`rows` ≤ 200, `cols` ≤ 500) |
| `GET /terminals` | — | registry snapshot + `ptyAvailable` |
| `GET /terminals/:id/output?offset=N` | — | `{out: {text, nextOffset, lossy}}` |
| `POST /terminals/:id/input` | `{text}` | write raw text |
| `POST /terminals/:id/signal` | `{signal}` | PTY only: `SIGINT`/`SIGTERM`/`SIGKILL`/`SIGTSTP`/`SIGHUP` |
| `POST /terminals/:id/stop` | — | tree-scoped terminate |
| `DELETE /terminals/:id` | — | stop if live, then discard |

> Terminals run with the full privileges of the harness process — same trust
> model as every local surface of this repo. The server binds loopback by
> design; do not widen it.

## Tests

```bash
node packages/agent-terminal/test/run.mjs          # both backends against stubbed services
node packages/agent-terminal/test/client-check.mjs # bundle contract in a stubbed DOM
```
