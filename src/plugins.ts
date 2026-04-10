/**
 * Plugin System v2 — 4-phase lifecycle hooks.
 *
 * Inspired by cmmakerclub/MQTT-Connector (Nat's Arduino lib, 2016):
 *   - Hook signature IS the permission (pointer=modify, value=read, bool*=cancel)
 *   - Lifecycle sequence: GATE → FILTER → HANDLE → LATE
 *
 * Plugin authors write:
 *   export default function(hooks) {
 *     hooks.gate("PreToolUse", (event) => event.oracle !== "blocked"); // cancel
 *     hooks.filter("*", (event) => ({ ...event, message: redact(event.message) })); // modify
 *     hooks.on("SessionStart", (event) => console.log(event)); // observe
 *     hooks.late("*", (event) => auditLog(event)); // guaranteed cleanup
 *   }
 */

import type { FeedEvent, FeedEventType } from "./lib/feed";

type Gate = (event: Readonly<FeedEvent>) => boolean;
type Filter = (event: FeedEvent) => FeedEvent;
type Handler = (event: Readonly<FeedEvent>) => void | Promise<void>;
type Late = (event: Readonly<FeedEvent>) => void;
export type MawPlugin = (hooks: MawHooks) => void | (() => void);

export interface MawHooks {
  /** Phase 0: GATE — return false to cancel the entire pipeline */
  gate(event: FeedEventType | "*", fn: Gate): void;
  /** Phase 1: FILTER — modify event before handlers see it (Drupal hook_alter) */
  filter(event: FeedEventType | "*", fn: Filter): void;
  /** Phase 2: HANDLE — observe/react to event (read-only) */
  on(event: FeedEventType | "*", fn: Handler): void;
  /** Phase 3: LATE — guaranteed cleanup, runs even if handlers error */
  late(event: FeedEventType | "*", fn: Late): void;
}

export interface PluginInfo {
  name: string;
  type: "ts" | "js" | "wasm-shared" | "wasm-wasi" | "unknown";
  source: "builtin" | "user";
  loadedAt: string;
  events: number;
  errors: number;
  lastEvent?: string;
  lastError?: string;
}

export class PluginSystem {
  private gates = new Map<string, Gate[]>();
  private filters = new Map<string, Filter[]>();
  private handlers = new Map<string, Handler[]>();
  private lates = new Map<string, Late[]>();
  private teardowns: Array<() => void> = [];
  private _plugins: PluginInfo[] = [];
  private _totalEvents = 0;
  private _totalErrors = 0;
  private _gated = 0;
  private _startedAt = new Date().toISOString();

  private _addTo<T>(map: Map<string, T[]>, event: string, fn: T) {
    const list = map.get(event);
    if (list) list.push(fn);
    else map.set(event, [fn]);
  }

  readonly hooks: MawHooks = {
    gate: (event, fn) => this._addTo(this.gates, event, fn),
    filter: (event, fn) => this._addTo(this.filters, event, fn),
    on: (event, fn) => this._addTo(this.handlers, event, fn),
    late: (event, fn) => this._addTo(this.lates, event, fn),
  };

  /**
   * Emit event through the 4-phase pipeline.
   * Returns true if event was processed, false if gated (cancelled).
   */
  async emit(event: FeedEvent): Promise<boolean> {
    this._totalEvents++;

    // Phase 0: GATE — any gate returning false cancels the pipeline
    const frozen = Object.freeze({ ...event });
    for (const fn of this.gates.get(event.event) ?? []) {
      try { if (fn(frozen) === false) { this._gated++; return false; } } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:gate] ${event.event}:`, (err as Error).message);
      }
    }
    for (const fn of this.gates.get("*") ?? []) {
      try { if (fn(frozen) === false) { this._gated++; return false; } } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:gate] *:`, (err as Error).message);
      }
    }

    // Phase 1: FILTER — modify event (mutable)
    for (const fn of this.filters.get(event.event) ?? []) {
      try { event = fn(event); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:filter] ${event.event}:`, (err as Error).message);
      }
    }
    for (const fn of this.filters.get("*") ?? []) {
      try { event = fn(event); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:filter] *:`, (err as Error).message);
      }
    }

    // Phase 2: HANDLE — observe (read-only)
    const readOnly = Object.freeze({ ...event });
    for (const fn of this.handlers.get(event.event) ?? []) {
      try { await fn(readOnly); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin] ${event.event}:`, (err as Error).message);
      }
    }
    for (const fn of this.handlers.get("*") ?? []) {
      try { await fn(readOnly); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin] *:`, (err as Error).message);
      }
    }

    // Phase 3: LATE — guaranteed cleanup (runs even if HANDLE threw)
    for (const fn of this.lates.get(event.event) ?? []) {
      try { fn(readOnly); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:late] ${event.event}:`, (err as Error).message);
      }
    }
    for (const fn of this.lates.get("*") ?? []) {
      try { fn(readOnly); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:late] *:`, (err as Error).message);
      }
    }

    // Update per-plugin stats
    for (const p of this._plugins) {
      p.events = this._totalEvents;
      p.lastEvent = event.event;
    }

    return true;
  }

  load(plugin: MawPlugin) {
    const teardown = plugin(this.hooks);
    if (typeof teardown === "function") this.teardowns.push(teardown);
  }

  register(name: string, type: PluginInfo["type"], source: PluginInfo["source"] = "user") {
    this._plugins.push({ name, type, source, loadedAt: new Date().toISOString(), events: 0, errors: 0 });
  }

  stats() {
    return {
      startedAt: this._startedAt,
      plugins: this._plugins,
      totalEvents: this._totalEvents,
      totalErrors: this._totalErrors,
      gated: this._gated,
      gates: Object.fromEntries([...this.gates].map(([k, v]) => [k, v.length])),
      filters: Object.fromEntries([...this.filters].map(([k, v]) => [k, v.length])),
      handlers: Object.fromEntries([...this.handlers].map(([k, v]) => [k, v.length])),
      lates: Object.fromEntries([...this.lates].map(([k, v]) => [k, v.length])),
    };
  }

  destroy() {
    for (const fn of this.teardowns) {
      try { fn(); } catch {}
    }
  }
}

/**
 * Load a WASM plugin. Contract:
 *   - Module exports `handle(ptr, len)` and `memory`
 *   - We write JSON event to shared memory, call handle()
 *   - OR: module exports `on_event` string array for filtering
 *   - Fallback: if module exports `_start` (WASI), run as subprocess per event
 */
async function loadWasmPlugin(system: PluginSystem, path: string, filename: string, source: PluginInfo["source"] = "user") {
  const { readFileSync } = require("fs");
  const wasmBytes = readFileSync(path);
  const mod = new WebAssembly.Module(wasmBytes);
  const exports = WebAssembly.Module.exports(mod);
  const exportNames = exports.map((e: { name: string }) => e.name);

  // Check for handle + memory pattern (shared memory plugin)
  if (exportNames.includes("handle") && exportNames.includes("memory")) {
    const instance = new WebAssembly.Instance(mod);
    const memory = instance.exports.memory as WebAssembly.Memory;
    const handle = instance.exports.handle as (ptr: number, len: number) => void;
    const encoder = new TextEncoder();

    system.load((hooks) => {
      hooks.on("*", (event) => {
        const json = encoder.encode(JSON.stringify(event));
        const buf = new Uint8Array(memory.buffer);
        buf.set(json, 0);
        handle(0, json.length);
      });
    });
    system.register(filename, "wasm-shared", source);
    console.log(`[plugin] loaded wasm: ${filename} (shared memory)`);
    return;
  }

  // Check for WASI module (_start export) — pass event as JSON via stdin
  if (exportNames.includes("_start")) {
    const { WASI } = require("wasi");
    system.load((hooks) => {
      hooks.on("*", (event) => {
        try {
          const input = Buffer.from(JSON.stringify(event) + "\n");
          let pos = 0;
          const wasi = new WASI({
            version: "preview1",
            args: [filename, event.event],
            env: {
              MAW_EVENT: event.event,
              MAW_ORACLE: event.oracle,
              MAW_HOST: event.host,
              MAW_MESSAGE: event.message,
              MAW_SESSION: event.sessionId,
              MAW_TIMESTAMP: event.timestamp,
            },
            getStdin: () => {
              const chunk = input.subarray(pos, pos + 4096);
              pos += chunk.length;
              return chunk.length > 0 ? chunk : null;
            },
            sendStdout: (data: Buffer) => process.stdout.write(data),
            sendStderr: (data: Buffer) => process.stderr.write(data),
          });
          const instance = new WebAssembly.Instance(mod, {
            wasi_snapshot_preview1: wasi.wasiImport,
          });
          wasi.start(instance);
        } catch {}
      });
    });
    system.register(filename, "wasm-wasi", source);
    console.log(`[plugin] loaded wasm: ${filename} (WASI)`);
    return;
  }

  // Skip — not a plugin-compatible WASM module (like demo.wasm with just add/mul)
  console.log(`[plugin] skipped wasm: ${filename} (no handle or _start export)`);
}

/**
 * Load plugins from a directory (convention: ~/.oracle/plugins/).
 *
 * Supported formats:
 *   .ts / .js  — TypeScript/JavaScript: export default function(hooks) { ... }
 *   .wasm      — WebAssembly: export handle(ptr, len) + memory, or WASI _start
 */
export async function loadPlugins(system: PluginSystem, dir: string, source: PluginInfo["source"] = "user") {
  const { readdirSync } = require("fs");
  const { join } = require("path");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f: string) =>
      f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".wasm")
    );
  } catch {
    return; // dir doesn't exist — no plugins, no error
  }
  for (const file of files) {
    const path = join(dir, file);
    try {
      if (file.endsWith(".wasm")) {
        await loadWasmPlugin(system, path, file, source);
      } else {
        const mod = await import(path);
        const plugin = mod.default ?? mod;
        if (typeof plugin === "function") {
          system.load(plugin);
          system.register(file, file.endsWith(".ts") ? "ts" : "js", source);
          console.log(`[plugin] loaded: ${file} (${source})`);
        }
      }
    } catch (err) {
      console.error(`[plugin] failed to load ${file}:`, (err as Error).message);
    }
  }
}
