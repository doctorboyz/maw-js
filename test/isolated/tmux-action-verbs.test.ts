import { describe, test, expect } from "bun:test";
import { cmdTmuxLayout, cmdTmuxSplit, cmdTmuxAttach } from "../../src/commands/plugins/tmux/impl";

// Pure-validation tests for split, kill, layout, attach. These verbs call
// hostExec under the hood — we test the input-validation paths that throw
// BEFORE any tmux interaction. Live behavior was smoke-tested in iter 9.

describe("cmdTmuxLayout — input validation", () => {
  test("invalid preset → throws", async () => {
    await expect(cmdTmuxLayout("any-target", "weird-layout")).rejects.toThrow(/invalid layout/);
  });

  test("error message lists all valid presets", async () => {
    try {
      await cmdTmuxLayout("any-target", "bogus");
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("even-horizontal");
      expect(e.message).toContain("tiled");
      expect(e.message).toContain("main-horizontal");
    }
  });
});

describe("cmdTmuxSplit — pct bounds", () => {
  test("pct 0 → throws", async () => {
    await expect(cmdTmuxSplit("any:0.0", { pct: 0 })).rejects.toThrow(/pct must be 1-99/);
  });

  test("pct 100 → throws", async () => {
    await expect(cmdTmuxSplit("any:0.0", { pct: 100 })).rejects.toThrow(/pct must be 1-99/);
  });

  test("pct -5 → throws", async () => {
    await expect(cmdTmuxSplit("any:0.0", { pct: -5 })).rejects.toThrow(/pct must be 1-99/);
  });

  test("pct NaN → throws", async () => {
    await expect(cmdTmuxSplit("any:0.0", { pct: NaN })).rejects.toThrow(/pct must be 1-99/);
  });
});

describe("cmdTmuxAttach — pure resolution + print", () => {
  test("resolves and prints attach command (no side effects)", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      cmdTmuxAttach("%999"); // pane id form, no resolution dependency
    } finally {
      console.log = origLog;
    }
    const joined = logs.join("\n");
    expect(joined).toContain("tmux attach -t");
    expect(joined).toContain("Ctrl-b d"); // detach instructions
  });

  test("session-name target → extracts session for attach", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      cmdTmuxAttach("some-session:0.1");
    } finally {
      console.log = origLog;
    }
    expect(logs.join("\n")).toContain("tmux attach -t some-session");
  });
});
