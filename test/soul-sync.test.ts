import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

// Test the core sync logic directly (no ssh/tmux mocking needed)
// We test findParent, findChildren, and the syncDir logic

const TEST_DIR = join(import.meta.dir, ".test-soul-sync");
const CHILD_PSI = join(TEST_DIR, "child-oracle", "ψ");
const PARENT_PSI = join(TEST_DIR, "parent-oracle", "ψ");

function setup() {
  rmSync(TEST_DIR, { recursive: true, force: true });

  // Create child oracle with learnings
  mkdirSync(join(CHILD_PSI, "memory/learnings"), { recursive: true });
  mkdirSync(join(CHILD_PSI, "memory/retrospectives/2026-04"), { recursive: true });
  mkdirSync(join(CHILD_PSI, "memory/traces/2026-04-06"), { recursive: true });

  writeFileSync(join(CHILD_PSI, "memory/learnings/bitkub-api.md"), "# Bitkub API patterns\nlearned things");
  writeFileSync(join(CHILD_PSI, "memory/learnings/tax-calc.md"), "# Tax calculation\nquarterly process");
  writeFileSync(join(CHILD_PSI, "memory/retrospectives/2026-04/06-session.md"), "# Session retro\ngood work");
  writeFileSync(join(CHILD_PSI, "memory/traces/2026-04-06/2134_bitkub.md"), "# Trace: bitkub\nfound things");

  // Create parent oracle with some existing files
  mkdirSync(join(PARENT_PSI, "memory/learnings"), { recursive: true });
  mkdirSync(join(PARENT_PSI, "memory/retrospectives"), { recursive: true });
  mkdirSync(join(PARENT_PSI, "memory/traces"), { recursive: true });

  // Parent already has tax-calc (should NOT be overwritten)
  writeFileSync(join(PARENT_PSI, "memory/learnings/tax-calc.md"), "# PARENT VERSION - DO NOT OVERWRITE");
}

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("soul-sync", () => {
  beforeEach(setup);
  afterEach(cleanup);

  describe("syncDir (core file copy logic)", () => {
    // Import the syncDir equivalent by testing through the module
    // Since syncDir is not exported, we test through the file system directly
    // using the same logic pattern

    test("copies new files from child to parent", () => {
      const { syncDirForTest } = require("./soul-sync-helpers");
      const src = join(CHILD_PSI, "memory/learnings");
      const dst = join(PARENT_PSI, "memory/learnings");

      const count = syncDirForTest(src, dst);

      // bitkub-api.md should be copied (new)
      expect(existsSync(join(dst, "bitkub-api.md"))).toBe(true);
      expect(readFileSync(join(dst, "bitkub-api.md"), "utf-8")).toContain("Bitkub API patterns");

      // tax-calc.md should NOT be overwritten (already exists in parent)
      expect(readFileSync(join(dst, "tax-calc.md"), "utf-8")).toBe("# PARENT VERSION - DO NOT OVERWRITE");

      // Only 1 file copied (bitkub-api.md), tax-calc.md was skipped
      expect(count).toBe(1);
    });

    test("creates nested directories as needed", () => {
      const { syncDirForTest } = require("./soul-sync-helpers");
      const src = join(CHILD_PSI, "memory/retrospectives");
      const dst = join(PARENT_PSI, "memory/retrospectives");

      const count = syncDirForTest(src, dst);

      // Should create 2026-04/ subdir and copy the file
      expect(existsSync(join(dst, "2026-04/06-session.md"))).toBe(true);
      expect(count).toBe(1);
    });

    test("handles missing source dir gracefully", () => {
      const { syncDirForTest } = require("./soul-sync-helpers");
      const count = syncDirForTest("/nonexistent/path", PARENT_PSI);
      expect(count).toBe(0);
    });

    test("syncs traces with nested date dirs", () => {
      const { syncDirForTest } = require("./soul-sync-helpers");
      const src = join(CHILD_PSI, "memory/traces");
      const dst = join(PARENT_PSI, "memory/traces");

      const count = syncDirForTest(src, dst);

      expect(existsSync(join(dst, "2026-04-06/2134_bitkub.md"))).toBe(true);
      expect(count).toBe(1);
    });
  });

  describe("findParent / findChildren (fleet config parsing)", () => {
    test("findParent returns null for oracle without parent", () => {
      const { findParentForTest } = require("./soul-sync-helpers");
      const fleet = [
        { name: "01-pulse", windows: [{ name: "pulse-oracle", repo: "laris-co/pulse-oracle" }] },
        { name: "06-floodboy", windows: [{ name: "floodboy-oracle", repo: "laris-co/floodboy-oracle" }] },
      ];
      expect(findParentForTest("floodboy", fleet)).toBeNull();
    });

    test("findParent returns parent from child's parent field", () => {
      const { findParentForTest } = require("./soul-sync-helpers");
      const fleet = [
        { name: "01-pulse", windows: [{ name: "pulse-oracle", repo: "laris-co/pulse-oracle" }], children: ["floodboy", "fireman"] },
        { name: "06-floodboy", windows: [{ name: "floodboy-oracle", repo: "laris-co/floodboy-oracle" }], parent: "pulse" },
      ];
      expect(findParentForTest("floodboy", fleet)).toBe("pulse");
    });

    test("findParent returns parent via children[] reverse lookup", () => {
      const { findParentForTest } = require("./soul-sync-helpers");
      const fleet = [
        { name: "01-pulse", windows: [{ name: "pulse-oracle", repo: "laris-co/pulse-oracle" }], children: ["floodboy", "fireman"] },
        { name: "06-floodboy", windows: [{ name: "floodboy-oracle", repo: "laris-co/floodboy-oracle" }] },
      ];
      // floodboy doesn't have parent field, but pulse lists it as child
      expect(findParentForTest("floodboy", fleet)).toBe("pulse");
    });

    test("findChildren returns all children from both directions", () => {
      const { findChildrenForTest } = require("./soul-sync-helpers");
      const fleet = [
        { name: "01-pulse", windows: [], children: ["floodboy", "fireman"] },
        { name: "06-floodboy", windows: [], parent: "pulse" },
        { name: "07-fireman", windows: [], parent: "pulse" },
        { name: "09-dustboychain", windows: [], parent: "pulse" },
      ];
      const children = findChildrenForTest("pulse", fleet);
      expect(children).toContain("floodboy");
      expect(children).toContain("fireman");
      expect(children).toContain("dustboychain");
      expect(children.length).toBe(3);
    });

    test("findChildren deduplicates", () => {
      const { findChildrenForTest } = require("./soul-sync-helpers");
      const fleet = [
        { name: "01-pulse", windows: [], children: ["floodboy"] },
        { name: "06-floodboy", windows: [], parent: "pulse" },
      ];
      const children = findChildrenForTest("pulse", fleet);
      // floodboy appears in both children[] and parent field — should not duplicate
      expect(children.length).toBe(1);
    });
  });
});
