import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { InvokeContext } from "../../../plugin/types";

let lastWakeCall: { oracle: string; opts: any } | null = null;
let lastWakeAllCall: { opts: any } | null = null;

const base = import.meta.dir + "/../..";

mock.module(base + "/wake", () => ({
  cmdWake: async (oracle: string, opts: any) => {
    lastWakeCall = { oracle, opts };
    console.log(`woke ${oracle}`);
  },
}));

mock.module(base + "/fleet", () => ({
  cmdWakeAll: async (opts: any) => {
    lastWakeAllCall = { opts };
    console.log("wake all");
  },
  cmdSleep: async () => {},
}));

mock.module(base + "/wake-target", () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => {},
}));

mock.module(base + "/wake-resolve", () => ({
  fetchGitHubPrompt: async (type: string, num: number) => `${type} #${num} prompt`,
}));

describe("wake plugin", () => {
  let handler: (ctx: InvokeContext) => Promise<any>;

  beforeEach(async () => {
    lastWakeCall = null;
    lastWakeAllCall = null;
    const mod = await import("./index");
    handler = mod.default;
  });

  it("CLI basic: wake <name> → calls cmdWake with oracle name", async () => {
    const result = await handler({ source: "cli", args: ["neo"] });
    expect(result.ok).toBe(true);
    expect(lastWakeCall?.oracle).toBe("neo");
    expect(result.output).toContain("woke neo");
  });

  it("CLI with --task: sets noAttach=true and prompt from flag", async () => {
    const result = await handler({ source: "cli", args: ["neo", "--task", "review PR"] });
    expect(result.ok).toBe(true);
    expect(lastWakeCall?.opts.noAttach).toBe(true);
    expect(lastWakeCall?.opts.prompt).toBe("review PR");
  });

  it("CLI wake all --kill → calls cmdWakeAll with kill=true", async () => {
    const result = await handler({ source: "cli", args: ["all", "--kill"] });
    expect(result.ok).toBe(true);
    expect(lastWakeAllCall?.opts.kill).toBe(true);
  });

  it("API: { oracle: 'neo' } → calls cmdWake", async () => {
    const result = await handler({ source: "api", args: { oracle: "neo" } });
    expect(result.ok).toBe(true);
    expect(lastWakeCall?.oracle).toBe("neo");
  });

  it("CLI: missing oracle name → returns error with usage", async () => {
    const result = await handler({ source: "cli", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage");
  });

  it("API: missing oracle → returns error", async () => {
    const result = await handler({ source: "api", args: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing oracle");
  });
});
