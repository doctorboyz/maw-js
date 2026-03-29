/**
 * Transport abstraction layer for maw-js.
 *
 * The fleet currently communicates via tmux (local) and HTTP federation (peers).
 * This module introduces a pluggable transport interface so messaging can flow
 * through MQTT (oracle-mesh-signal), HTTP, or tmux depending on target location.
 *
 * Local targets → tmux (fast path, 50ms capture loop)
 * Remote targets → MQTT publish to oracle/{name}/inbox
 * Fallback → HTTP federation (existing peers[] mechanism)
 */

import type { FeedEvent } from "./lib/feed";

/** Where a message should be delivered */
export interface TransportTarget {
  oracle: string;        // e.g. "neo", "pulse"
  host?: string;         // e.g. "white.local", "remote-host" — null = local
  tmuxTarget?: string;   // e.g. "main:3" — only for local tmux
}

/** A message flowing through the transport */
export interface TransportMessage {
  from: string;          // sender oracle name
  to: string;            // recipient oracle name
  body: string;          // the actual message text
  timestamp: number;     // epoch ms
  transport: "tmux" | "mqtt" | "http";  // which channel carried it
}

/** Presence info broadcast by each host */
export interface TransportPresence {
  oracle: string;
  host: string;
  status: "busy" | "ready" | "idle" | "crashed" | "offline";
  timestamp: number;
}

/** Abstract transport — implementations handle different channels */
export interface Transport {
  readonly name: string;

  /** Connect / initialize */
  connect(): Promise<void>;

  /** Disconnect / cleanup */
  disconnect(): Promise<void>;

  /** Send a message to a target */
  send(target: TransportTarget, message: string): Promise<boolean>;

  /** Publish presence/heartbeat */
  publishPresence(presence: TransportPresence): Promise<void>;

  /** Publish a feed event to remote listeners */
  publishFeed(event: FeedEvent): Promise<void>;

  /** Register handler for incoming messages */
  onMessage(handler: (msg: TransportMessage) => void): void;

  /** Register handler for presence updates */
  onPresence(handler: (presence: TransportPresence) => void): void;

  /** Register handler for remote feed events */
  onFeed(handler: (event: FeedEvent) => void): void;

  /** Check if this transport can reach a given target */
  canReach(target: TransportTarget): boolean;

  /** Whether the transport is currently connected */
  readonly connected: boolean;
}

/**
 * TransportRouter — routes messages through the best available transport.
 *
 * Priority:
 * 1. tmux (local, fastest)
 * 2. MQTT (real-time, cross-host)
 * 3. HTTP federation (fallback, polling-based)
 */
export class TransportRouter {
  private transports: Transport[] = [];
  private messageHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();

  /** Register a transport (order matters — first match wins for send) */
  register(transport: Transport) {
    this.transports.push(transport);

    // Wire up incoming events from all transports
    transport.onMessage((msg) => {
      for (const h of this.messageHandlers) h(msg);
    });
    transport.onPresence((p) => {
      for (const h of this.presenceHandlers) h(p);
    });
    transport.onFeed((e) => {
      for (const h of this.feedHandlers) h(e);
    });
  }

  /** Connect all registered transports */
  async connectAll(): Promise<void> {
    await Promise.allSettled(this.transports.map((t) => t.connect()));
  }

  /** Disconnect all */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(this.transports.map((t) => t.disconnect()));
  }

  /** Send a message — routes through the first transport that can reach the target */
  async send(target: TransportTarget, message: string, from: string): Promise<{ sent: boolean; via: string }> {
    for (const t of this.transports) {
      if (t.connected && t.canReach(target)) {
        const ok = await t.send(target, message);
        if (ok) return { sent: true, via: t.name };
      }
    }
    return { sent: false, via: "none" };
  }

  /** Broadcast presence through all connected transports */
  async publishPresence(presence: TransportPresence): Promise<void> {
    await Promise.allSettled(
      this.transports
        .filter((t) => t.connected)
        .map((t) => t.publishPresence(presence)),
    );
  }

  /** Broadcast a feed event through all connected transports */
  async publishFeed(event: FeedEvent): Promise<void> {
    await Promise.allSettled(
      this.transports
        .filter((t) => t.connected)
        .map((t) => t.publishFeed(event)),
    );
  }

  onMessage(handler: (msg: TransportMessage) => void) {
    this.messageHandlers.add(handler);
  }

  onPresence(handler: (p: TransportPresence) => void) {
    this.presenceHandlers.add(handler);
  }

  onFeed(handler: (e: FeedEvent) => void) {
    this.feedHandlers.add(handler);
  }

  /** Get status of all transports */
  status(): { name: string; connected: boolean }[] {
    return this.transports.map((t) => ({ name: t.name, connected: t.connected }));
  }
}
