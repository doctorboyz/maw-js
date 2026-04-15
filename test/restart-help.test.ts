/**
 * Regression tests for #349 — maw restart --help must NOT trigger destructive ops.
 *
 * Bug: `maw restart --help` killed fleet sessions and ran maw update before the fix.
 * Fix: index.ts checks --help/-h before ever calling cmdRestart.
 *
 * Strategy: mock cmdRestart to throw. If --help reaches it, the test fails loudly.
 */
import { describe, it, expect, mock } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../src");

// Mock cmdRestart to throw — proves any call is a regression.
mock.module(join(root, "commands/plugins/restart/impl"), () => ({
  cmdRestart: async () => {
    throw new Error("cmdRestart invoked — --help did not short-circuit destructive ops");
  },
}));

// Import handler AFTER mock is registered.
const { default: handler } = await import("../src/commands/plugins/restart/index");

describe("#349 — restart --help short-circuits before destructive ops", () => {
  it("OLD dispatcher: --help returns help text, cmdRestart never fires", async () => {
    const result = await handler({ source: "cli", args: ["--help"] });
    expect(result?.ok).toBe(true);
    expect(result?.output).toContain("usage: maw restart");
    expect(result?.output).toContain("--no-update");
  });

  it("NEW dispatcher: --help array form also short-circuits", async () => {
    const result = await handler(["--help"]);
    expect(result?.ok).toBe(true);
    expect(result?.output).toContain("usage: maw restart");
  });

  it("-h shorthand also short-circuits", async () => {
    const result = await handler({ source: "cli", args: ["-h"] });
    expect(result?.ok).toBe(true);
    expect(result?.output).toContain("--no-update");
  });

  it("without --help, cmdRestart IS reached (sanity: mock is active)", async () => {
    // Bare restart hits cmdRestart → mock throws → handler catches → ok: false.
    // This proves the mock guards above are real, not vacuous.
    const result = await handler({ source: "cli", args: [] });
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("cmdRestart invoked");
  });
});
