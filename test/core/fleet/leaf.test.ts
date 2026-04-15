import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TriggerConfig } from "../../../src/config";
import { mergeRegistry, writeCache, type RegistryCache } from "../../../src/core/fleet/oracle-registry";
import { wouldFireAt } from "../../../src/core/runtime/triggers";

/**
 * PR γ of #209 — registry leaves[] preservation + cron TriggerEvent wiring.
 *
 * Covers:
 *  1. `mergeRegistry` (pure) and `writeCache` (I/O) preserve `leaves[]` and
 *     other unknown top-level keys when the scanner rewrites `oracles[]`.
 *     This is the fix for the gap flagged in PR β: `scanAndCache` would
 *     otherwise clobber tiny-bud leaf entries on every fleet scan.
 *  2. The `TriggerEvent` union admits "cron", `TriggerConfig.schedule` is
 *     typed, and `wouldFireAt(expr, now)` parses crontab syntax into a
 *     next-fire Date for dry-run inspection.
 *
 * Note: tests use an explicit `targetFile` override on `writeCache` instead
 * of the module-level CACHE_FILE — paths.ts captures CONFIG_DIR at import
 * time, so env-based isolation is fragile under multi-file test runs.
 */

describe("mergeRegistry — PR γ pure merge helper", () => {
  const freshCache: RegistryCache = {
    schema: 1,
    local_scanned_at: "2026-04-15T12:00:00.000Z",
    ghq_root: "/test/ghq",
    oracles: [],
  };

  it("preserves leaves[] from existing registry", () => {
    const existing = {
      schema: 1,
      oracles: [{ org: "old", repo: "stale-oracle", name: "stale" }],
      leaves: [
        { name: "scout", parent: "mawjs", kind: "tiny" },
      ],
    };
    const merged = mergeRegistry(existing, freshCache);
    expect(merged.leaves).toEqual(existing.leaves);
    expect(merged.oracles).toEqual([]); // scanner-owned, overwritten
    expect(merged.local_scanned_at).toBe("2026-04-15T12:00:00.000Z");
  });

  it("preserves arbitrary unknown top-level keys (forward-compat)", () => {
    const merged = mergeRegistry(
      { schema: 1, oracles: [], future_key: { v: 42 }, another: ["x"] },
      freshCache,
    );
    expect(merged.future_key).toEqual({ v: 42 });
    expect(merged.another).toEqual(["x"]);
  });

  it("handles null / non-object existing (no prior file)", () => {
    expect(mergeRegistry(null, freshCache)).toEqual({ ...freshCache });
    expect(mergeRegistry(undefined, freshCache)).toEqual({ ...freshCache });
    expect(mergeRegistry("garbage", freshCache)).toEqual({ ...freshCache });
    expect(mergeRegistry([1, 2, 3], freshCache)).toEqual({ ...freshCache });
  });

  it("fresh cache fields win on key collision (scanner authority)", () => {
    const existing = { schema: 1, oracles: ["stale"], ghq_root: "/old" };
    const merged = mergeRegistry(existing, freshCache);
    expect(merged.oracles).toEqual([]);
    expect(merged.ghq_root).toBe("/test/ghq");
  });
});

describe("writeCache with targetFile override — PR γ leaves preservation", () => {
  let dir: string;
  let cacheFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leaf-pr-gamma-"));
    cacheFile = join(dir, "oracles.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves leaves[] when overwriting oracles[]", () => {
    writeFileSync(cacheFile, JSON.stringify({
      schema: 1,
      oracles: [{ repo: "stale" }],
      leaves: [{
        org: "Soul-Brews-Studio",
        parent_repo: "mawjs-oracle",
        name: "scout",
        kind: "tiny",
        parent: "mawjs",
        path: "/tmp/scout",
        budded_at: "2026-04-15T00:00:00.000Z",
        presence: ["local"],
      }],
    }, null, 2) + "\n");

    writeCache({
      schema: 1,
      local_scanned_at: "2026-04-15T12:00:00.000Z",
      ghq_root: "/test/ghq",
      oracles: [], // fresh empty scan
    }, cacheFile);

    const onDisk = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(Array.isArray(onDisk.leaves)).toBe(true);
    expect(onDisk.leaves).toHaveLength(1);
    expect(onDisk.leaves[0].name).toBe("scout");
    expect(onDisk.leaves[0].parent).toBe("mawjs");
    expect(onDisk.oracles).toEqual([]);
    expect(onDisk.local_scanned_at).toBe("2026-04-15T12:00:00.000Z");
  });

  it("writes fresh cache when no prior file exists", () => {
    expect(existsSync(cacheFile)).toBe(false);
    writeCache({
      schema: 1,
      local_scanned_at: "2026-04-15T12:00:00.000Z",
      ghq_root: "/test/ghq",
      oracles: [],
    }, cacheFile);
    const onDisk = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(onDisk.schema).toBe(1);
    expect(onDisk.leaves).toBeUndefined();
  });

  it("recovers from a malformed existing file (writes fresh, no throw)", () => {
    writeFileSync(cacheFile, "{not valid json at all");
    writeCache({
      schema: 1,
      local_scanned_at: "2026-04-15T12:00:00.000Z",
      ghq_root: "/test/ghq",
      oracles: [],
    }, cacheFile);
    const onDisk = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(onDisk.schema).toBe(1);
  });
});

describe("TriggerEvent 'cron' + wouldFireAt — PR γ wiring", () => {
  it("TriggerConfig admits 'on: \"cron\"' (compile-time union check)", () => {
    const t: TriggerConfig = {
      on: "cron",
      schedule: "0 9 * * *",
      action: "maw bud-run scout --parent mawjs",
      name: "tiny-mawjs-scout",
    };
    expect(t.on).toBe("cron");
    expect(t.schedule).toBe("0 9 * * *");
  });

  it("'0 9 * * *' returns the next 9:00, strictly after now", () => {
    const now = new Date();
    const next = wouldFireAt("0 9 * * *", now);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
    expect(next!.getMinutes()).toBe(0);
    expect(next!.getHours()).toBe(9);
  });

  it("'*/5 * * * *' returns the next minute divisible by 5", () => {
    const now = new Date("2026-04-15T10:07:30");
    const next = wouldFireAt("*/5 * * * *", now);
    expect(next).not.toBeNull();
    expect(next!.getMinutes() % 5).toBe(0);
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
    expect(next!.getMinutes()).toBe(10);
    expect(next!.getHours()).toBe(10);
  });

  it("never returns `now` itself (strict future)", () => {
    const now = new Date();
    now.setSeconds(0, 0);
    const expr = `${now.getMinutes()} ${now.getHours()} * * *`;
    const next = wouldFireAt(expr, now);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("rejects malformed cron expressions", () => {
    expect(() => wouldFireAt("0 9 *", new Date())).toThrow();            // <5 fields
    expect(() => wouldFireAt("99 9 * * *", new Date())).toThrow();        // minute out of range
    expect(() => wouldFireAt("0 9 * * * extra", new Date())).toThrow();   // >5 fields
    expect(() => wouldFireAt("0 9 0 * *", new Date())).toThrow();         // day-of-month 0
    expect(() => wouldFireAt("*/0 9 * * *", new Date())).toThrow();       // zero step
  });
});
