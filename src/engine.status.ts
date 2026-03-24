import { capture } from "./ssh";
import { tmux } from "./tmux";
import type { FeedEvent } from "./lib/feed";
import type { MawWS } from "./types";

interface AgentState {
  hash: string;
  changedAt: number;
  status: string;
}

interface SessionInfo {
  name: string;
  windows: { index: number; name: string; active: boolean }[];
}

/** Strip Claude Code status bar lines before hashing (they change constantly even when idle) */
function stripStatusBar(content: string): string {
  return content.split('\n').filter(line => {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (/^[\s─━]+$/.test(plain)) return false;
    if (/📁/.test(plain)) return false;
    if (/📡/.test(plain)) return false;
    if (/⏵/.test(plain)) return false;
    if (/^\s*❯\s*$/.test(plain)) return false;
    if (/current:.*latest:/.test(plain)) return false;
    if (/bypass permissions/.test(plain)) return false;
    if (/auto-accept/.test(plain)) return false;
    if (/^\s*$/.test(plain)) return false;
    return true;
  }).join('\n');
}

/**
 * Hybrid status detection: pane command + screen hash.
 * - Not running claude → idle
 * - Running claude + screen changing → busy
 * - Running claude + stable 15s → ready
 */
export class StatusDetector {
  private state = new Map<string, AgentState>();

  async detect(
    sessions: SessionInfo[],
    clients: Set<MawWS>,
    feedListeners: Set<(event: FeedEvent) => void>,
  ) {
    if (clients.size === 0 || sessions.length === 0) return;

    const agents = sessions.flatMap(s =>
      s.windows.map(w => ({ target: `${s.name}:${w.index}`, name: w.name, session: s.name }))
    );

    const cmds = await tmux.getPaneCommands(agents.map(a => a.target));

    const captures = await Promise.allSettled(
      agents.map(async a => ({ target: a.target, content: await capture(a.target, 20) }))
    );
    const contentMap = new Map<string, string>();
    for (const r of captures) {
      if (r.status === "fulfilled") contentMap.set(r.value.target, r.value.content);
    }

    const now = Date.now();
    for (const { target, name, session } of agents) {
      const cmd = (cmds[target] || "").toLowerCase();
      const isAgent = /claude|codex|node/i.test(cmd);
      const content = contentMap.get(target) || "";
      const hash = Bun.hash(stripStatusBar(content)).toString(36);
      const prev = this.state.get(target);

      let status: string;
      if (!isAgent) {
        status = "idle";
      } else if (!prev || hash !== prev.hash) {
        status = "busy";
      } else if (now - prev.changedAt < 15_000) {
        status = "busy";
      } else {
        status = "ready";
      }

      const changedAt = (!prev || hash !== prev.hash) ? now : prev.changedAt;
      this.state.set(target, { hash, changedAt, status });

      if (prev && status !== prev.status) {
        const event: FeedEvent = {
          timestamp: new Date().toISOString(),
          oracle: name.replace(/-oracle$/, ""),
          host: "local",
          event: status === "busy" ? "PreToolUse" : status === "ready" ? "Stop" : "SessionEnd",
          project: session,
          sessionId: "",
          message: status === "busy" ? "working" : status === "ready" ? "waiting" : "idle",
          ts: now,
        };
        const msg = JSON.stringify({ type: "feed", event });
        for (const ws of clients) ws.send(msg);
        for (const fn of feedListeners) fn(event);
      }
    }
  }
}
