import { ssh } from "./ssh";
import { loadConfig } from "./config";
import type { ServerWebSocket } from "bun";

interface PtySession {
  proc: ReturnType<typeof Bun.spawn>;
  target: string;
  viewers: Set<ServerWebSocket<any>>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, PtySession>();

function isLocalHost(): boolean {
  const host = process.env.MAW_HOST || loadConfig().host || "white.local";
  return host === "local" || host === "localhost";
}

function findSession(ws: ServerWebSocket<any>): PtySession | undefined {
  for (const s of sessions.values()) {
    if (s.viewers.has(ws)) return s;
  }
}

export function handlePtyMessage(ws: ServerWebSocket<any>, msg: string | Buffer) {
  if (typeof msg !== "string") {
    // Binary → keystroke to PTY stdin
    const session = findSession(ws);
    if (session?.proc.stdin) {
      session.proc.stdin.write(msg as Buffer);
      session.proc.stdin.flush();
    }
    return;
  }

  // JSON control message
  try {
    const data = JSON.parse(msg);
    if (data.type === "attach") attach(ws, data.target, data.cols || 120, data.rows || 40);
    else if (data.type === "resize") resize(ws, data.cols, data.rows);
    else if (data.type === "detach") detach(ws);
  } catch {}
}

export function handlePtyClose(ws: ServerWebSocket<any>) {
  detach(ws);
}

async function attach(ws: ServerWebSocket<any>, target: string, cols: number, rows: number) {
  // Sanitize target: only allow safe characters
  const safe = target.replace(/[^a-zA-Z0-9\-_:.]/g, "");
  if (!safe) return;

  // Detach from any existing session
  detach(ws);

  // Join existing PTY session?
  let session = sessions.get(safe);
  if (session) {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    session.viewers.add(ws);
    ws.send(JSON.stringify({ type: "attached", target: safe }));
    return;
  }

  const sessionName = safe.split(":")[0];
  const c = Math.max(1, Math.min(500, Math.floor(cols)));
  const r = Math.max(1, Math.min(200, Math.floor(rows)));

  // Select the target window before attaching
  try { await ssh(`tmux select-window -t '${safe}' 2>/dev/null`); } catch {}

  // Spawn PTY via script(1) — creates a real pseudo-terminal
  let args: string[];
  if (isLocalHost()) {
    const cmd = `stty rows ${r} cols ${c} 2>/dev/null; TERM=xterm-256color tmux attach-session -t '${sessionName}'`;
    args = ["script", "-qfc", cmd, "/dev/null"];
  } else {
    const host = process.env.MAW_HOST || loadConfig().host || "white.local";
    args = ["ssh", "-tt", host, `TERM=xterm-256color tmux attach-session -t '${sessionName}'`];
  }

  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, TERM: "xterm-256color" },
  });

  session = { proc, target: safe, viewers: new Set([ws]), cleanupTimer: null };
  sessions.set(safe, session);

  ws.send(JSON.stringify({ type: "attached", target: safe }));

  // Resize tmux pane to match viewer dimensions
  resizeTarget(safe, c, r);

  // Stream PTY stdout → all viewers as binary frames
  const s = session;
  const reader = proc.stdout!.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const v of s.viewers) {
          try { v.send(value); } catch {}
        }
      }
    } catch {}
    // PTY process ended
    sessions.delete(safe);
    for (const v of s.viewers) {
      try { v.send(JSON.stringify({ type: "detached", target: safe })); } catch {}
    }
  })();
}

function resize(ws: ServerWebSocket<any>, cols: number, rows: number) {
  const session = findSession(ws);
  if (session) resizeTarget(session.target, cols, rows);
}

function resizeTarget(target: string, cols: number, rows: number) {
  const c = Math.max(1, Math.min(500, Math.floor(cols)));
  const r = Math.max(1, Math.min(200, Math.floor(rows)));
  ssh(`tmux resize-pane -t '${target}' -x ${c} -y ${r} 2>/dev/null`).catch(() => {});
}

function detach(ws: ServerWebSocket<any>) {
  for (const [target, session] of sessions) {
    if (!session.viewers.has(ws)) continue;
    session.viewers.delete(ws);
    if (session.viewers.size === 0) {
      // Grace period before killing PTY
      session.cleanupTimer = setTimeout(() => {
        try { session.proc.kill(); } catch {}
        sessions.delete(target);
      }, 5000);
    }
  }
}
