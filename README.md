# maw.js

> Multi-Agent Workflow — remote tmux orchestra control via SSH

## Install

```bash
bunx --bun maw@github:Soul-Brews-Studio/maw.js#main ls
```

## Usage

```bash
maw ls                      # list sessions + windows
maw peek                    # one-line summary per agent
maw peek neo                # see neo's screen
maw hey neo how are you     # send message to neo
maw neo /recap              # shorthand: agent + message
maw neo                     # shorthand: peek agent
maw serve                   # web UI on :3456
```

## Env

```bash
export MAW_HOST=white.local   # SSH target (default)
```

## Evolution

```
maw.env.sh (Oct 2025) → oracles() zsh (Mar 2026) → maw.js (Mar 2026)
   30+ shell cmds         ghq-based launcher         Bun/TS + Web UI
```
