import { tmux } from "./tmux";
import { registerBuiltinHandlers } from "./handlers";
import { pushCapture, pushPreviews, broadcastSessions, sendBusyAgents } from "./engine.capture";
import { StatusDetector } from "./engine.status";
import { broadcastTeams } from "./engine.teams";
import type { FeedEvent } from "./lib/feed";
import type { MawWS, Handler } from "./types";

type SessionInfo = { name: string; windows: { index: number; name: string; active: boolean }[] };

export class MawEngine {
  private clients = new Set<MawWS>();
  private handlers = new Map<string, Handler>();
  private lastContent = new Map<MawWS, string>();
  private lastPreviews = new Map<MawWS, Map<string, string>>();
  private sessionCache = { sessions: [] as SessionInfo[], json: "" };
  private status = new StatusDetector();

  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private sessionInterval: ReturnType<typeof setInterval> | null = null;
  private previewInterval: ReturnType<typeof setInterval> | null = null;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private teamsInterval: ReturnType<typeof setInterval> | null = null;
  private lastTeamsJson = { value: "" };
  private feedUnsub: (() => void) | null = null;

  private feedBuffer: FeedEvent[];
  private feedListeners: Set<(event: FeedEvent) => void>;

  constructor({ feedBuffer, feedListeners }: { feedBuffer: FeedEvent[]; feedListeners: Set<(event: FeedEvent) => void> }) {
    this.feedBuffer = feedBuffer;
    this.feedListeners = feedListeners;
    registerBuiltinHandlers(this);
  }

  on(type: string, handler: Handler) { this.handlers.set(type, handler); }

  // --- WebSocket lifecycle ---

  handleOpen(ws: MawWS) {
    this.clients.add(ws);
    this.startIntervals();
    if (this.sessionCache.sessions.length > 0) {
      ws.send(JSON.stringify({ type: "sessions", sessions: this.sessionCache.sessions }));
      sendBusyAgents(ws, this.sessionCache.sessions);
    } else {
      tmux.listAll().then(sessions => {
        this.sessionCache.sessions = sessions;
        ws.send(JSON.stringify({ type: "sessions", sessions }));
        sendBusyAgents(ws, sessions);
      }).catch(() => {});
    }
    ws.send(JSON.stringify({ type: "feed-history", events: this.feedBuffer.slice(-50) }));
  }

  handleMessage(ws: MawWS, msg: string | Buffer) {
    try {
      const data = JSON.parse(msg as string);
      const handler = this.handlers.get(data.type);
      if (handler) handler(ws, data, this);
    } catch {}
  }

  handleClose(ws: MawWS) {
    this.clients.delete(ws);
    this.lastContent.delete(ws);
    this.lastPreviews.delete(ws);
    this.stopIntervals();
  }

  // --- Public (handlers use these) ---

  async pushCapture(ws: MawWS) { return pushCapture(ws, this.lastContent); }
  async pushPreviews(ws: MawWS) { return pushPreviews(ws, this.lastPreviews); }

  // --- Intervals ---

  private startIntervals() {
    if (this.captureInterval) return;
    this.captureInterval = setInterval(() => {
      for (const ws of this.clients) this.pushCapture(ws);
    }, 50);
    this.sessionInterval = setInterval(async () => {
      this.sessionCache.sessions = await broadcastSessions(this.clients, this.sessionCache);
    }, 5000);
    this.previewInterval = setInterval(() => {
      for (const ws of this.clients) this.pushPreviews(ws);
    }, 2000);
    this.statusInterval = setInterval(() => {
      this.status.detect(this.sessionCache.sessions, this.clients, this.feedListeners);
    }, 3000);
    // Watch Agent Teams every 3s — broadcast changes to UI
    this.teamsInterval = setInterval(() => {
      broadcastTeams(this.clients, this.lastTeamsJson);
    }, 3000);

    const listener = (event: FeedEvent) => {
      const msg = JSON.stringify({ type: "feed", event });
      for (const ws of this.clients) ws.send(msg);
    };
    this.feedListeners.add(listener);
    this.feedUnsub = () => this.feedListeners.delete(listener);
  }

  private stopIntervals() {
    if (this.clients.size > 0) return;
    if (this.captureInterval) { clearInterval(this.captureInterval); this.captureInterval = null; }
    if (this.sessionInterval) { clearInterval(this.sessionInterval); this.sessionInterval = null; }
    if (this.previewInterval) { clearInterval(this.previewInterval); this.previewInterval = null; }
    if (this.statusInterval) { clearInterval(this.statusInterval); this.statusInterval = null; }
    if (this.teamsInterval) { clearInterval(this.teamsInterval); this.teamsInterval = null; }
    if (this.feedUnsub) { this.feedUnsub(); this.feedUnsub = null; }
  }
}
