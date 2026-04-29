/**
 * trust-store-lib — direct-import smoke tests for #924 sub-PR 1.
 *
 * #918 (Phase 3 lean-core) extracted 19 plugins out of `src/commands/plugins/`.
 * Six were deferred because core code still imported from inside their plugin
 * directory. Trust was one — `src/commands/shared/scope-acl.ts` reached into
 * `commands/plugins/trust/store` for `loadTrust`.
 *
 * Sub-PR 1 lifts the trust storage primitives up into `src/lib/trust-store.ts`
 * so the plugin directory can be extracted without breaking core. The plugin's
 * old `store.ts` stays as a re-export shim (covered by the existing
 * `trust-list.test.ts` suite via `plugins/trust/store`).
 *
 * What THIS file tests is the property the extraction needs: that
 * `src/lib/trust-store` works correctly when imported DIRECTLY, with no
 * traversal through the plugin directory at all. If the trust plugin were
 * physically moved to a community package tomorrow, these imports would still
 * resolve, and these tests would still pass.
 *
 * Mirrors the per-test temp-dir pattern from `trust-list.test.ts` so the
 * trust file resolves to a fresh `<MAW_CONFIG_DIR>/trust.json` per test.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "maw-trust-store-lib-"));
  originalConfigDir = process.env.MAW_CONFIG_DIR;
  originalHome = process.env.MAW_HOME;
  process.env.MAW_CONFIG_DIR = testDir;
  delete process.env.MAW_HOME;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("src/lib/trust-store — direct imports work without the plugin", () => {
  test("trustPath() resolves under MAW_CONFIG_DIR (call-time, not import-time)", async () => {
    const { trustPath } = await import("../../src/lib/trust-store");
    // Path is resolved on each call, so it picks up the per-test env tweak
    // that beforeEach() applies AFTER module load. This is the property that
    // makes the per-test temp-dir pattern safe in `trust-list.test.ts`, and
    // it must hold for the lifted module too.
    expect(trustPath()).toBe(join(testDir, "trust.json"));
  });

  test("loadTrust() returns [] when trust.json is missing (forgiving)", async () => {
    const { loadTrust } = await import("../../src/lib/trust-store");
    expect(loadTrust()).toEqual([]);
  });

  test("saveTrust() then loadTrust() round-trips entries via the lib path", async () => {
    const { loadTrust, saveTrust } = await import("../../src/lib/trust-store");
    const a = { sender: "alpha", target: "beta", addedAt: "2026-04-29T00:00:00.000Z" };
    const b = { sender: "gamma", target: "delta", addedAt: "2026-04-29T00:00:01.000Z" };
    saveTrust([a, b]);
    const loaded = loadTrust();
    expect(loaded).toHaveLength(2);
    expect(loaded.map(e => e.sender).sort()).toEqual(["alpha", "gamma"]);
  });

  test("saveTrust() writes atomically — no .tmp file remains after success", async () => {
    const { saveTrust, trustPath } = await import("../../src/lib/trust-store");
    saveTrust([{ sender: "a", target: "b", addedAt: "2026-04-29T00:00:00.000Z" }]);
    // Final file readable, .tmp gone — proves rename(2) executed.
    expect(() => readFileSync(trustPath(), "utf-8")).not.toThrow();
    expect(() => readFileSync(`${trustPath()}.tmp`, "utf-8")).toThrow();
  });

  test("loadTrust() forgiving on corrupt JSON — returns []", async () => {
    const { loadTrust, trustPath } = await import("../../src/lib/trust-store");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(trustPath(), "not valid json {{{");
    expect(loadTrust()).toEqual([]);
  });

  test("samePair() is symmetric — {a,b} equals {b,a}", async () => {
    const { samePair } = await import("../../src/lib/trust-store");
    expect(samePair({ sender: "a", target: "b" }, { sender: "b", target: "a" })).toBe(true);
    expect(samePair({ sender: "a", target: "b" }, { sender: "a", target: "b" })).toBe(true);
    expect(samePair({ sender: "a", target: "b" }, { sender: "a", target: "c" })).toBe(false);
    expect(samePair({ sender: "a", target: "b" }, { sender: "x", target: "y" })).toBe(false);
  });

  test("plugin shim re-exports point at the same module identity", async () => {
    // Both import paths must resolve to the SAME functions — otherwise we'd
    // have two independent module instances reading/writing the same file,
    // and the back-compat shim would drift over time.
    const lib = await import("../../src/lib/trust-store");
    const shim = await import("../../src/commands/plugins/trust/store");
    expect(shim.loadTrust).toBe(lib.loadTrust);
    expect(shim.saveTrust).toBe(lib.saveTrust);
    expect(shim.trustPath).toBe(lib.trustPath);
    expect(shim.samePair).toBe(lib.samePair);
  });
});
