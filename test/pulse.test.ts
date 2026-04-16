import { describe, it, expect, mock } from "bun:test";
import { join } from "path";
import type { InvokeContext } from "../src/plugin/types";

let capturedTitle: string | undefined;
let capturedOpts: Record<string, unknown> | undefined;

mock.module(join(import.meta.dir, "../src/commands/shared/pulse"), () => ({
  cmdPulseAdd: async (title: string, opts: Record<string, unknown>) => {
    capturedTitle = title;
    capturedOpts = opts;
  },
  cmdPulseLs: async () => {},
}));

const { default: pulse } = await import("../src/commands/plugins/pulse/index");

describe("pulse add flag parsing", () => {
  const ctx = (args: string[]): InvokeContext => ({ source: "cli", args });

  it("extracts --oracle, --priority, --wt", async () => {
    capturedTitle = undefined;
    capturedOpts = undefined;
    const r = await pulse(ctx(["add", "test title", "--oracle", "neo", "--priority", "high", "--wt", "mywt"]));
    expect(r.ok).toBe(true);
    expect(capturedTitle).toBe("test title");
    expect(capturedOpts?.oracle).toBe("neo");
    expect(capturedOpts?.priority).toBe("high");
    expect(capturedOpts?.wt).toBe("mywt");
  });

  it("--worktree aliases --wt", async () => {
    capturedTitle = undefined;
    capturedOpts = undefined;
    await pulse(ctx(["add", "alias test", "--worktree", "myrepo"]));
    expect(capturedOpts?.wt).toBe("myrepo");
  });

  it("title as first positional, flags anywhere", async () => {
    capturedTitle = undefined;
    capturedOpts = undefined;
    await pulse(ctx(["add", "--oracle", "neo", "my task title", "--priority", "low"]));
    expect(capturedTitle).toBe("my task title");
    expect(capturedOpts?.oracle).toBe("neo");
    expect(capturedOpts?.priority).toBe("low");
  });

  it("returns error when title is missing", async () => {
    const r = await pulse(ctx(["add", "--oracle", "neo"]));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage:");
  });
});
