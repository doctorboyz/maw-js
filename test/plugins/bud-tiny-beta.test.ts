import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cmdBudTiny } from "../../src/commands/plugins/bud/impl";

/**
 * PR β of #209 — cron integration + registry leaf entry.
 *
 * Tests drive cmdBudTiny directly with tmpdir overrides:
 *   - parentRoot: fake parent oracle root (same as PR α)
 *   - configDir:  fake ~/.config/maw for oracles.json + maw.config.json
 *
 * Covered: (1) PR α regression — no --cron, leaf still registered;
 *          (2) happy path with --cron — leaf + trigger entry;
 *          (3) --cron without --tiny rejected via handler.
 */

describe("maw bud --tiny --cron — PR β", () => {
  let parentRoot: string;
  let configDir: string;
  const origExit = process.exit;

  beforeEach(() => {
    parentRoot = mkdtempSync(join(tmpdir(), "bud-tiny-beta-parent-"));
    configDir = mkdtempSync(join(tmpdir(), "bud-tiny-beta-config-"));
    mkdirSync(join(parentRoot, "ψ"), { recursive: true });
    (process as any).exit = (c?: number) => { throw new Error(`exit ${c ?? 0}`); };
  });

  afterEach(() => {
    process.exit = origExit;
    rmSync(parentRoot, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("PR α regression: no --cron — leaf registered, no trigger written", async () => {
    await cmdBudTiny("scout", { parent: "mawjs", parentRoot, configDir });

    // Bud dir still created (α skeleton)
    expect(existsSync(join(parentRoot, "ψ", "buds", "scout", "identity.md"))).toBe(true);

    // Leaf entry present
    const registryPath = join(configDir, "oracles.json");
    expect(existsSync(registryPath)).toBe(true);
    const cache = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(cache.schema).toBe(1);
    expect(Array.isArray(cache.leaves)).toBe(true);
    expect(cache.leaves).toHaveLength(1);
    const leaf = cache.leaves[0];
    expect(leaf.name).toBe("scout");
    expect(leaf.parent).toBe("mawjs");
    expect(leaf.kind).toBe("tiny");
    expect(leaf.parent_repo).toBe("mawjs-oracle");
    expect(leaf.path).toBe(join(parentRoot, "ψ", "buds", "scout"));
    expect(leaf.presence).toEqual(["local"]);
    expect(typeof leaf.budded_at).toBe("string");

    // No cron trigger written (config.json absent OR no triggers)
    const configPath = join(configDir, "maw.config.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.triggers || []).toHaveLength(0);
    }
  });

  it("happy path: --tiny --cron creates bud + leaf + trigger entry", async () => {
    // Pre-seed registry with parent so parentFound=true
    writeFileSync(
      join(configDir, "oracles.json"),
      JSON.stringify({
        schema: 1,
        local_scanned_at: new Date().toISOString(),
        ghq_root: "/fake",
        oracles: [{ org: "Soul-Brews-Studio", repo: "mawjs-oracle", name: "mawjs" }],
      }, null, 2),
    );

    await cmdBudTiny("gm", { parent: "mawjs", parentRoot, configDir, cron: "0 9 * * *" });

    // Leaf added (parent is present in oracles → no warn)
    const cache = JSON.parse(readFileSync(join(configDir, "oracles.json"), "utf-8"));
    expect(cache.leaves).toHaveLength(1);
    expect(cache.leaves[0].name).toBe("gm");
    // Existing oracles array preserved
    expect(cache.oracles).toHaveLength(1);
    expect(cache.oracles[0].name).toBe("mawjs");

    // Cron trigger written
    const cfg = JSON.parse(readFileSync(join(configDir, "maw.config.json"), "utf-8"));
    expect(Array.isArray(cfg.triggers)).toBe(true);
    expect(cfg.triggers).toHaveLength(1);
    const trigger = cfg.triggers[0];
    expect(trigger.on).toBe("cron");
    expect(trigger.schedule).toBe("0 9 * * *");
    expect(trigger.name).toBe("tiny-mawjs-gm");
    expect(trigger.action).toContain("gm");
    expect(trigger.action).toContain("--parent mawjs");
  });

  it("--cron without --tiny: handler rejects", async () => {
    const handler = (await import("../../src/commands/plugins/bud/index")).default;
    const result = await handler({
      source: "cli",
      args: ["scout", "--cron", "0 9 * * *"],
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--cron requires --tiny");
  });
});
