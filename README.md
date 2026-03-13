# maw.js

> Multi-Agent Workflow — remote tmux orchestra control via SSH

**[Join Nat Weerawan's Subscribers Group!](https://www.facebook.com/groups/1461988771737551)** | [Watch the Demo](https://www.facebook.com/reel/1513957190087776)

## Quick Start (no install)

```bash
bunx --bun github:Soul-Brews-Studio/maw-js ls
bunx --bun github:Soul-Brews-Studio/maw-js peek neo
bunx --bun github:Soul-Brews-Studio/maw-js hey neo "how are you"
```

## Install (global)

```bash
# Clone + link
ghq get Soul-Brews-Studio/maw-js
cd $(ghq root)/github.com/Soul-Brews-Studio/maw-js
bun install && bun link

# Now use directly
maw ls
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
export MAW_HOST=white.local   # SSH target (default: local tmux)
```

## Web UIs

| Path | View |
|------|------|
| `/` | Terminal UI (ANSI, click to interact) |
| `/dashboard` | Orbital constellation |
| `/office` | Virtual office (React, SVG avatars) |

## Evolution

```
maw.env.sh (Oct 2025) → oracles() zsh (Mar 2026) → maw.js (Mar 2026)
   30+ shell cmds         ghq-based launcher         Bun/TS + Web UI
```
