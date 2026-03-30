# maw-js

> Multi-Agent Workflow — backend server, CLI, and federation mesh

## Architecture

```
Soul-Brews-Studio/maw-js          Soul-Brews-Studio/maw-ui
├── src/          (backend)        ├── src/          (React app)
│   ├── api/      (Hono routes)    │   ├── components/
│   ├── commands/ (CLI)            │   ├── hooks/
│   ├── engine/   (WebSocket)      │   ├── lib/
│   ├── transports/ (MQTT/HTTP)    │   └── main.tsx
│   └── views/    (static serve)   ├── office-8bit/  (Rust/WASM)
├── test/                          ├── shrine/
├── fleet/        (oracle configs) ├── wasm-vm/
├── ui/                            └── package.json
│   └── office/   ← built by maw-ui
└── package.json
```

**maw-js** = backend (API, WebSocket, CLI, transports, tmux).
**maw-ui** = frontend (React dashboard, built → deployed to `maw-js/ui/office/`).

## Quick Start

```bash
bunx --bun github:Soul-Brews-Studio/maw-js ls
bunx --bun github:Soul-Brews-Studio/maw-js peek neo
bunx --bun github:Soul-Brews-Studio/maw-js hey neo "how are you"
```

## Install

```bash
ghq get Soul-Brews-Studio/maw-js
cd $(ghq root)/github.com/Soul-Brews-Studio/maw-js
bun install && bun link
maw ls
```

## Server

```bash
cp maw.config.example.json maw.config.json
# Edit: host, ghqRoot, env (CLAUDE_CODE_OAUTH_TOKEN), pin, federationToken

pm2 start ecosystem.config.cjs    # backend on :3456
open http://localhost:3456         # serves ui/office/
```

## CLI

```bash
maw ls                          # list sessions + windows
maw peek [agent]                # see agent screen (or all)
maw hey <agent> <msg>           # send message to agent
maw peek node:agent             # remote peek via federation
maw hey node:agent <msg>        # remote send via federation
maw ping [node]                 # check peer connectivity
maw wake <oracle> [task]        # wake oracle in tmux
maw sleep <oracle> [window]     # gracefully stop window
maw fleet ls                    # list fleet configs
maw fleet snapshot              # save fleet state
maw done <window>               # auto-save + clean up
```

## Federation

Cross-machine agent communication with HMAC-SHA256 signing.

```bash
# Config (same token on both nodes)
{
  "node": "white",
  "federationToken": "your-shared-secret-min-16-chars",
  "namedPeers": [{ "name": "mba", "url": "http://mba.wg:3457" }]
}

# Talk across machines
maw hey mba:homekeeper "hello"     # → delivered ⚡ mba → homekeeper
maw peek mba:homekeeper            # → see their screen
maw ping                           # → ✅ mba — 42ms, auth: ok
```

## Deploy (frontend)

Frontend lives in [maw-ui](https://github.com/Soul-Brews-Studio/maw-ui). Deploy:

```bash
cd /path/to/maw-ui
bun run build
cp -r dist/* /path/to/maw-js/ui/office/
```

Dev server: `bun run dev` on maw-ui (:5173, proxies API to :3456).

## Web UI Routes

| Route | View |
|-------|------|
| `#dashboard` | Status cards, live feed, command center |
| `#fleet` | Stage or pitch formation |
| `#office` | Room grid — sessions as colored rooms |
| `#mission` | SVG constellation map |
| `#overview` | Compact agent grid |
| `#terminal` | Full-screen xterm.js PTY |
| `#chat` | AI conversation log |
| `#config` | JSON config editor |
| `/federation` | Mesh status + join guide |
| `/timemachine` | Fleet Time Machine (snapshot browser) |

## Evolution

```
maw.env.sh (Oct 2025) → oracles() zsh (Mar 2026) → maw.js (Mar 2026) → maw-js + maw-ui split (Mar 2026)
   30+ shell cmds         ghq-based launcher         Bun/TS monolith         backend + frontend repos
```
