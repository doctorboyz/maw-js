import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cmdBudTiny } from "../../src/commands/plugins/bud/impl";

/**
 * PR α of #209 — `maw bud <name> --tiny --parent <oracle>` creates a nested
 * tiny oracle inside the parent's vault. Tests drive cmdBudTiny directly with
 * a tmpdir standing in for the parent oracle root, avoiding ghqRoot/org I/O.
 */

describe("maw bud --tiny — PR α skeleton", () => {
  let parentRoot: string;
  let configDir: string;
  const origExit = process.exit;

  beforeEach(() => {
    parentRoot = mkdtempSync(join(tmpdir(), "bud-tiny-parent-"));
    configDir = mkdtempSync(join(tmpdir(), "bud-tiny-config-"));
    // Sanity: fake parent looks like a real oracle root (has ψ/).
    mkdirSync(join(parentRoot, "ψ"), { recursive: true });
    (process as any).exit = (c?: number) => { throw new Error(`exit ${c ?? 0}`); };
  });

  afterEach(() => {
    process.exit = origExit;
    rmSync(parentRoot, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("happy path: creates identity.md, CLAUDE.md, memory/logs/.gitkeep with substitution", async () => {
    await cmdBudTiny("scout", { parent: "mawjs", parentRoot, configDir });

    const budDir = join(parentRoot, "ψ", "buds", "scout");
    expect(existsSync(budDir)).toBe(true);

    const identity = readFileSync(join(budDir, "identity.md"), "utf-8");
    expect(identity).toContain("**Name**: scout");
    expect(identity).toContain("**Parent**: mawjs");
    expect(identity).not.toContain("{{name}}");
    expect(identity).not.toContain("{{parent}}");
    expect(identity).not.toContain("{{budded_at}}");

    const claude = readFileSync(join(budDir, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("scout");
    expect(claude).toContain("mawjs");
    expect(claude).not.toContain("{{");

    expect(existsSync(join(budDir, "memory", "logs", ".gitkeep"))).toBe(true);
  });

  it("missing --parent: cmdBudTiny with empty parent exits 1", async () => {
    await expect(
      cmdBudTiny("scout", { parent: "", parentRoot, configDir }),
    ).rejects.toThrow("exit 1");
  });

  it("missing parent dir: exits 1 with actionable error", async () => {
    await expect(
      cmdBudTiny("scout", { parent: "nope", parentRoot: join(parentRoot, "does-not-exist"), configDir }),
    ).rejects.toThrow("exit 1");
  });

  it("collision: refuses to overwrite existing bud dir", async () => {
    await cmdBudTiny("scout", { parent: "mawjs", parentRoot, configDir });
    await expect(
      cmdBudTiny("scout", { parent: "mawjs", parentRoot, configDir }),
    ).rejects.toThrow("exit 1");
  });
});
