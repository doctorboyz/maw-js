/**
 * WASM Host Function Bridge — exposes maw SDK to WASM plugins.
 *
 * Host functions injected via WebAssembly importObject:
 *   maw_print(ptr, len)        — print string to stdout
 *   maw_print_err(ptr, len)    — print string to stderr
 *   maw_log(level, ptr, len)   — structured log (0=debug..3=error)
 *   maw_identity()             — returns ptr to JSON identity
 *   maw_federation()           — returns ptr to JSON federation status
 *   maw_send(tPtr, tLen, mPtr, mLen) — send message, returns 1=ok 0=fail
 *   maw_fetch(urlPtr, urlLen)  — GET fetch, returns async-result id
 *   maw_async_result(id)       — poll for async result, returns ptr or 0
 *   maw_alloc(size)            — fallback allocator when WASM lacks one
 *
 * Memory protocol:
 *   Strings: UTF-8 (ptr, len) pairs
 *   Return values: 4-byte LE length prefix + UTF-8 payload
 *   WASM should export: memory + maw_alloc(size) → ptr
 */

import { maw } from "../sdk";

// ---------------------------------------------------------------------------
// Text codec singletons
// ---------------------------------------------------------------------------

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

/** Read a UTF-8 string from WASM linear memory at (ptr, len). */
export function readString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  const buf = new Uint8Array(memory.buffer, ptr, len);
  return textDecoder.decode(buf);
}

/**
 * Write a UTF-8 string into WASM linear memory using the module's exported
 * allocator. Returns the pointer where the string was written.
 * The first 4 bytes at the returned pointer hold the length (u32 LE),
 * followed by the raw UTF-8 bytes.
 */
export function writeString(
  memory: WebAssembly.Memory,
  alloc: (size: number) => number,
  value: string,
): number {
  const bytes = textEncoder.encode(value);
  const ptr = alloc(4 + bytes.length);
  const view = new DataView(memory.buffer);
  view.setUint32(ptr, bytes.length, true);
  new Uint8Array(memory.buffer).set(bytes, ptr + 4);
  return ptr;
}

// ---------------------------------------------------------------------------
// Async result stash — for maw_fetch and future async host functions
// ---------------------------------------------------------------------------

const asyncResults = new Map<number, string>();
let asyncSeq = 0;

// ---------------------------------------------------------------------------
// importObject builder
// ---------------------------------------------------------------------------

export type WasmBridge = ReturnType<typeof buildImportObject>;

/**
 * Build the `env` importObject that gets passed to every WASM plugin.
 *
 * Uses late-binding getters so the bridge can be constructed before the
 * WebAssembly.Instance exists (chicken-and-egg with memory/alloc exports).
 */
export function buildImportObject(
  getMemory: () => WebAssembly.Memory,
  getAlloc: () => (size: number) => number,
) {
  let cachedIdentity: string | null = null;
  let cachedFederation: string | null = null;

  return {
    env: {
      // --- Output -----------------------------------------------------------

      maw_print(ptr: number, len: number): void {
        process.stdout.write(readString(getMemory(), ptr, len));
      },

      maw_print_err(ptr: number, len: number): void {
        process.stderr.write(readString(getMemory(), ptr, len));
      },

      maw_log(level: number, ptr: number, len: number): void {
        const msg = readString(getMemory(), ptr, len);
        const tag = "[wasm]";
        switch (level) {
          case 0: console.debug(tag, msg); break;
          case 1: console.log(tag, msg); break;
          case 2: console.warn(tag, msg); break;
          case 3: console.error(tag, msg); break;
          default: console.log(tag, msg);
        }
      },

      // --- SDK queries (sync façade — pre-cached before handle()) -----------

      maw_identity(): number {
        if (!cachedIdentity) {
          cachedIdentity = '{"error":"identity not pre-cached"}';
        }
        return writeString(getMemory(), getAlloc(), cachedIdentity);
      },

      maw_federation(): number {
        if (!cachedFederation) {
          cachedFederation = '{"error":"federation not pre-cached"}';
        }
        return writeString(getMemory(), getAlloc(), cachedFederation);
      },

      // --- Messaging --------------------------------------------------------

      maw_send(tPtr: number, tLen: number, mPtr: number, mLen: number): number {
        const target = readString(getMemory(), tPtr, tLen);
        const text = readString(getMemory(), mPtr, mLen);
        maw.send(target, text).catch((e: Error) =>
          console.error(`[wasm] maw_send to ${target} failed:`, e.message),
        );
        return 1;
      },

      // --- HTTP fetch -------------------------------------------------------

      maw_fetch(urlPtr: number, urlLen: number): number {
        const url = readString(getMemory(), urlPtr, urlLen);
        const id = ++asyncSeq;
        fetch(url, { signal: AbortSignal.timeout(10_000) })
          .then(r => r.text())
          .then(body => asyncResults.set(id, body))
          .catch((e: Error) => asyncResults.set(id, JSON.stringify({ error: e.message })));
        return id;
      },

      maw_async_result(id: number): number {
        const result = asyncResults.get(id);
        if (result === undefined) return 0;
        asyncResults.delete(id);
        return writeString(getMemory(), getAlloc(), result);
      },

      // --- Memory management (fallback) -------------------------------------

      maw_alloc(size: number): number {
        const mem = getMemory();
        const currentPages = mem.buffer.byteLength / 65_536;
        const needed = Math.ceil(size / 65_536);
        if (needed > 0) mem.grow(needed);
        return currentPages * 65_536;
      },
    },

    /** Pre-warm caches before calling handle(). */
    _setCachedIdentity(json: string) { cachedIdentity = json; },
    _setCachedFederation(json: string) { cachedFederation = json; },
  };
}

/**
 * Pre-cache identity + federation data into a bridge instance.
 * Call this before invoking the WASM handle() function so that
 * maw_identity() and maw_federation() return real data.
 */
export async function preCacheBridge(bridge: WasmBridge): Promise<void> {
  try {
    const [id, fed] = await Promise.all([
      maw.identity().catch(() => ({ error: "unreachable" })),
      maw.federation().catch(() => ({ error: "unreachable" })),
    ]);
    bridge._setCachedIdentity(JSON.stringify(id));
    bridge._setCachedFederation(JSON.stringify(fed));
  } catch { /* best-effort */ }
}
