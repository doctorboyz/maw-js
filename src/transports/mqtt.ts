/**
 * MQTT transport — cross-host real-time messaging via oracle-mesh-signal.
 *
 * Topic structure:
 *   oracle/{name}/inbox       — direct messages to an oracle
 *   oracle/{name}/status      — presence (busy/ready/idle/crashed)
 *   oracle/{name}/heartbeat   — alive ping
 *   fleet/{host}/sessions     — session list broadcast
 *   fleet/{host}/feed         — feed events (real-time)
 *
 * Uses raw WebSocket MQTT (no npm dependency needed — Bun has native WebSocket).
 * Falls back to TCP MQTT via mqtt.js if available.
 */

import type { Transport, TransportTarget, TransportMessage, TransportPresence } from "../transport";
import type { FeedEvent } from "../lib/feed";

export interface MqttConfig {
  broker: string;          // e.g. "ws://signal.oraclenet.org:9001" or "mqtt://localhost:1883"
  clientId?: string;       // defaults to "maw-{hostname}"
  username?: string;
  password?: string;
  selfName: string;        // this host's oracle fleet name (for heartbeat)
  selfHost: string;        // this host's hostname
}

// Simple MQTT v3.1.1 packet encoder/decoder over WebSocket
// Keeps us dependency-free — Bun's native WebSocket handles the connection

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const PINGRESP = 13;

function encodeString(s: string): Uint8Array {
  const buf = new TextEncoder().encode(s);
  const len = new Uint8Array(2);
  len[0] = (buf.length >> 8) & 0xff;
  len[1] = buf.length & 0xff;
  return concat(len, buf);
}

function encodeRemainingLength(len: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    bytes.push(b);
  } while (len > 0);
  return new Uint8Array(bytes);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}

function buildConnect(clientId: string, username?: string, password?: string): Uint8Array {
  const protocol = encodeString("MQTT");
  const level = new Uint8Array([4]); // MQTT 3.1.1
  let flags = 0x02; // Clean session
  const parts: Uint8Array[] = [protocol, level];

  if (username) flags |= 0x80;
  if (password) flags |= 0x40;
  parts.push(new Uint8Array([flags]));

  // Keep alive 60s
  parts.push(new Uint8Array([0, 60]));

  // Payload
  parts.push(encodeString(clientId));
  if (username) parts.push(encodeString(username));
  if (password) parts.push(encodeString(password));

  const payload = concat(...parts);
  const header = new Uint8Array([CONNECT << 4]);
  return concat(header, encodeRemainingLength(payload.length), payload);
}

function buildSubscribe(packetId: number, topics: string[]): Uint8Array {
  const idBytes = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
  const topicParts = topics.map((t) => concat(encodeString(t), new Uint8Array([0]))); // QoS 0
  const payload = concat(idBytes, ...topicParts);
  const header = new Uint8Array([(SUBSCRIBE << 4) | 0x02]);
  return concat(header, encodeRemainingLength(payload.length), payload);
}

function buildPublish(topic: string, message: string): Uint8Array {
  const topicBytes = encodeString(topic);
  const msgBytes = new TextEncoder().encode(message);
  const payload = concat(topicBytes, msgBytes);
  const header = new Uint8Array([PUBLISH << 4]); // QoS 0, no retain
  return concat(header, encodeRemainingLength(payload.length), payload);
}

function buildPingreq(): Uint8Array {
  return new Uint8Array([PINGREQ << 4, 0]);
}

/** Parse a PUBLISH packet — returns { topic, payload } or null */
function parsePublish(data: Uint8Array): { topic: string; payload: string } | null {
  if ((data[0] >> 4) !== PUBLISH) return null;

  // Decode remaining length
  let multiplier = 1;
  let remainingLength = 0;
  let i = 1;
  let byte: number;
  do {
    byte = data[i++];
    remainingLength += (byte & 0x7f) * multiplier;
    multiplier *= 128;
  } while ((byte & 0x80) !== 0);

  // Topic length
  const topicLen = (data[i] << 8) | data[i + 1];
  i += 2;

  const topic = new TextDecoder().decode(data.slice(i, i + topicLen));
  i += topicLen;

  // QoS > 0 would have packet ID here — we use QoS 0

  const payload = new TextDecoder().decode(data.slice(i, 1 + (i - 1) + remainingLength - (i - 1 - 1) + 1));
  // Simpler: payload is everything after topic
  const payloadStart = i;
  const payloadBytes = data.slice(payloadStart, 1 + remainingLength + (i - 1 - remainingLength > 0 ? 0 : 0));

  // Recalculate: the fixed header is (1 byte type + remaining length encoding)
  const headerSize = i - topicLen - 2; // bytes before topic length
  const payloadEnd = headerSize + remainingLength;
  const payloadStr = new TextDecoder().decode(data.slice(payloadStart, 1 + (data.length > payloadEnd ? payloadEnd : data.length)));

  return { topic, payload: new TextDecoder().decode(data.slice(payloadStart)) };
}

export class MqttTransport implements Transport {
  readonly name = "mqtt";
  private _connected = false;
  private ws: WebSocket | null = null;
  private config: MqttConfig;
  private packetId = 1;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private msgHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();

  constructor(config: MqttConfig) {
    this.config = config;
  }

  get connected() { return this._connected; }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(this.config.broker);
        ws.binaryType = "arraybuffer";

        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("MQTT connection timeout"));
        }, 10_000);

        ws.onopen = () => {
          const clientId = this.config.clientId || `maw-${this.config.selfHost}-${Date.now()}`;
          ws.send(buildConnect(clientId, this.config.username, this.config.password));
        };

        ws.onmessage = (ev) => {
          const data = new Uint8Array(ev.data as ArrayBuffer);
          const type = data[0] >> 4;

          if (type === CONNACK) {
            clearTimeout(timeout);
            this._connected = true;
            this.ws = ws;
            this.subscribeTopics();
            this.startPing();
            this.startHeartbeat();
            console.log(`[mqtt] connected to ${this.config.broker}`);
            resolve();
          } else if (type === PUBLISH) {
            this.handleIncoming(data);
          } else if (type === PINGRESP) {
            // OK
          }
        };

        ws.onclose = () => {
          this._connected = false;
          this.ws = null;
          this.stopPing();
          this.stopHeartbeat();
          this.scheduleReconnect();
        };

        ws.onerror = (err) => {
          clearTimeout(timeout);
          console.error("[mqtt] connection error:", err);
          reject(err);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  async disconnect(): Promise<void> {
    this.stopPing();
    this.stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  async send(target: TransportTarget, message: string): Promise<boolean> {
    if (!this.ws || !this._connected) return false;

    const topic = `oracle/${target.oracle}/inbox`;
    const payload = JSON.stringify({
      from: this.config.selfName,
      body: message,
      timestamp: Date.now(),
    });

    try {
      this.ws.send(buildPublish(topic, payload));
      return true;
    } catch {
      return false;
    }
  }

  async publishPresence(presence: TransportPresence): Promise<void> {
    if (!this.ws || !this._connected) return;

    const topic = `oracle/${presence.oracle}/status`;
    this.ws.send(buildPublish(topic, JSON.stringify(presence)));
  }

  async publishFeed(event: FeedEvent): Promise<void> {
    if (!this.ws || !this._connected) return;

    const topic = `fleet/${this.config.selfHost}/feed`;
    this.ws.send(buildPublish(topic, JSON.stringify(event)));
  }

  onMessage(handler: (msg: TransportMessage) => void) {
    this.msgHandlers.add(handler);
  }

  onPresence(handler: (p: TransportPresence) => void) {
    this.presenceHandlers.add(handler);
  }

  onFeed(handler: (e: FeedEvent) => void) {
    this.feedHandlers.add(handler);
  }

  /** MQTT can reach any remote target */
  canReach(target: TransportTarget): boolean {
    return !!target.host && target.host !== "local" && target.host !== "localhost";
  }

  // --- Private ---

  private subscribeTopics() {
    if (!this.ws) return;

    const topics = [
      `oracle/+/inbox`,       // Direct messages to any oracle on this host
      `oracle/+/status`,      // Presence updates
      `oracle/+/heartbeat`,   // Heartbeats
      `fleet/+/feed`,         // Feed events from other hosts
      `fleet/+/sessions`,     // Session lists from other hosts
    ];

    this.ws.send(buildSubscribe(this.packetId++, topics));
  }

  private handleIncoming(data: Uint8Array) {
    const parsed = parsePublish(data);
    if (!parsed) return;

    const { topic, payload } = parsed;
    const parts = topic.split("/");

    try {
      // oracle/{name}/inbox → message
      if (parts[0] === "oracle" && parts[2] === "inbox") {
        const msg = JSON.parse(payload);
        for (const h of this.msgHandlers) {
          h({
            from: msg.from || "unknown",
            to: parts[1],
            body: msg.body || msg.message || payload,
            timestamp: msg.timestamp || Date.now(),
            transport: "mqtt",
          });
        }
      }

      // oracle/{name}/status → presence
      if (parts[0] === "oracle" && parts[2] === "status") {
        const p = JSON.parse(payload);
        for (const h of this.presenceHandlers) h(p);
      }

      // fleet/{host}/feed → feed event
      if (parts[0] === "fleet" && parts[2] === "feed") {
        // Don't echo our own feed events
        if (parts[1] !== this.config.selfHost) {
          const event = JSON.parse(payload);
          for (const h of this.feedHandlers) h(event);
        }
      }
    } catch {
      // Malformed payload — ignore
    }
  }

  private startPing() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this._connected) {
        this.ws.send(buildPingreq());
      }
    }, 30_000);
  }

  private stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this._connected) {
        const topic = `oracle/${this.config.selfName}/heartbeat`;
        this.ws.send(buildPublish(topic, JSON.stringify({
          host: this.config.selfHost,
          timestamp: Date.now(),
        })));
      }
    }, 30_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    console.log("[mqtt] reconnecting in 5s...");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, 5_000);
  }
}
