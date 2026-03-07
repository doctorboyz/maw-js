const DEFAULT_HOST = process.env.MAW_HOST || "white.local";
const IS_LOCAL = DEFAULT_HOST === "local" || DEFAULT_HOST === "localhost";

export async function ssh(cmd: string, host = DEFAULT_HOST): Promise<string> {
  const local = host === "local" || host === "localhost" || IS_LOCAL;
  const args = local ? ["bash", "-c", cmd] : ["ssh", host, cmd];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(err.trim() || `exit ${code}`);
  }
  return text.trim();
}

export interface Window {
  index: number;
  name: string;
  active: boolean;
}

export interface Session {
  name: string;
  windows: Window[];
}

export async function listSessions(host?: string): Promise<Session[]> {
  const raw = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null", host);
  const sessions: Session[] = [];
  for (const s of raw.split("\n").filter(Boolean)) {
    const winRaw = await ssh(
      `tmux list-windows -t '${s}' -F '#{window_index}:#{window_name}:#{window_active}' 2>/dev/null`,
      host,
    );
    const windows = winRaw.split("\n").filter(Boolean).map(w => {
      const [idx, name, active] = w.split(":");
      return { index: +idx, name, active: active === "1" };
    });
    sessions.push({ name: s, windows });
  }
  return sessions;
}

export function findWindow(sessions: Session[], query: string): string | null {
  const q = query.toLowerCase();
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.toLowerCase().includes(q)) return `${s.name}:${w.index}`;
    }
  }
  if (query.includes(":")) return query;
  return null;
}

export async function capture(target: string, lines = 25, host?: string): Promise<string> {
  // -e preserves ANSI escape sequences (colors)
  return ssh(`tmux capture-pane -t '${target}' -e -p 2>/dev/null | tail -${lines}`, host);
}

export async function sendKeys(target: string, text: string, host?: string): Promise<void> {
  const escaped = text.replace(/'/g, "'\\''");
  await ssh(`tmux send-keys -t '${target}' -- '${escaped}' Enter`, host);
}
