import { describe, test, expect } from "bun:test";
import { PluginSystem, loadPlugins } from "../src/plugins";
import type { FeedEvent } from "../src/lib/feed";

const mockEvent: FeedEvent = {
  timestamp: "2026-04-10 16:00",
  oracle: "neo",
  host: "white.local",
  event: "SessionStart",
  project: "/home/test",
  sessionId: "abc123",
  message: "Session started",
  ts: Date.now(),
};

describe("PluginSystem", () => {
  test("plugin receives events via hooks.on", async () => {
    const sys = new PluginSystem();
    const received: FeedEvent[] = [];

    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e));
    });

    await sys.emit(mockEvent);
    expect(received).toHaveLength(1);
    expect(received[0].oracle).toBe("neo");
  });

  test("wildcard * receives all events", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.on("*", (e) => received.push(e.event));
    });

    await sys.emit(mockEvent);
    await sys.emit({ ...mockEvent, event: "Notification" });
    expect(received).toEqual(["SessionStart", "Notification"]);
  });

  test("named hook only fires for matching event", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.on("SessionEnd", (e) => received.push(e.event));
    });

    await sys.emit(mockEvent); // SessionStart — should NOT fire
    expect(received).toHaveLength(0);
  });

  test("multiple plugins on same hook", async () => {
    const sys = new PluginSystem();
    const order: number[] = [];

    sys.load((hooks) => {
      hooks.on("SessionStart", () => order.push(1));
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", () => order.push(2));
    });

    await sys.emit(mockEvent);
    expect(order).toEqual([1, 2]);
  });

  test("error in one plugin does not crash others", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.on("SessionStart", () => { throw new Error("boom"); });
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.oracle));
    });

    await sys.emit(mockEvent);
    expect(received).toEqual(["neo"]);
  });

  test("teardown function called on destroy", () => {
    const sys = new PluginSystem();
    let tornDown = false;

    sys.load(() => {
      return () => { tornDown = true; };
    });

    expect(tornDown).toBe(false);
    sys.destroy();
    expect(tornDown).toBe(true);
  });

  test("filter modifies event before handlers see it", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.filter("*", (e) => ({ ...e, message: "REDACTED" }));
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.message));
    });

    await sys.emit(mockEvent);
    expect(received).toEqual(["REDACTED"]);
  });

  test("multiple filters chain in order", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.filter("*", (e) => ({ ...e, message: e.message + " [hashed]" }));
    });
    sys.load((hooks) => {
      hooks.filter("*", (e) => ({ ...e, message: e.message + " [signed]" }));
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.message));
    });

    await sys.emit(mockEvent);
    expect(received).toEqual(["Session started [hashed] [signed]"]);
  });

  test("filter error does not crash handlers", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.filter("*", () => { throw new Error("filter boom"); });
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.oracle));
    });

    await sys.emit(mockEvent);
    expect(received).toEqual(["neo"]);
  });

  test("loadPlugins skips non-plugin wasm files", async () => {
    const sys = new PluginSystem();
    // ~/.oracle/plugins/ has demo.wasm (add/mul) — should skip gracefully
    await loadPlugins(sys, require("path").join(require("os").homedir(), ".oracle", "plugins"));
    // Should not throw, demo.wasm has no handle or _start
  });

  test("loadPlugins handles missing directory", async () => {
    const sys = new PluginSystem();
    await loadPlugins(sys, "/nonexistent/path");
    // Should not throw
  });

  // ─── Hooks v2: Gate + Late ───

  test("gate returning false cancels the pipeline", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => false); // CANCEL
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.oracle));
    });

    const result = await sys.emit(mockEvent);
    expect(result).toBe(false);
    expect(received).toHaveLength(0); // handler never ran
  });

  test("gate returning true allows pipeline to continue", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => true); // ALLOW
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.oracle));
    });

    const result = await sys.emit(mockEvent);
    expect(result).toBe(true);
    expect(received).toEqual(["neo"]);
  });

  test("wildcard gate cancels all events", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.gate("*", () => false); // CANCEL ALL
    });
    sys.load((hooks) => {
      hooks.on("*", (e) => received.push(e.event));
    });

    await sys.emit(mockEvent);
    await sys.emit({ ...mockEvent, event: "Notification" });
    expect(received).toHaveLength(0);
  });

  test("gate error does not cancel pipeline", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => { throw new Error("gate boom"); });
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.oracle));
    });

    const result = await sys.emit(mockEvent);
    expect(result).toBe(true);
    expect(received).toEqual(["neo"]);
  });

  test("late runs even when handler throws", async () => {
    const sys = new PluginSystem();
    const lateRan: boolean[] = [];

    sys.load((hooks) => {
      hooks.on("SessionStart", () => { throw new Error("handler boom"); });
    });
    sys.load((hooks) => {
      hooks.late("SessionStart", () => { lateRan.push(true); });
    });

    await sys.emit(mockEvent);
    expect(lateRan).toHaveLength(1); // late ran despite handler error
  });

  test("late wildcard runs for all events", async () => {
    const sys = new PluginSystem();
    const lateEvents: string[] = [];

    sys.load((hooks) => {
      hooks.late("*", (e) => lateEvents.push(e.event));
    });

    await sys.emit(mockEvent);
    await sys.emit({ ...mockEvent, event: "Notification" });
    expect(lateEvents).toEqual(["SessionStart", "Notification"]);
  });

  test("full 4-phase pipeline executes in order", async () => {
    const sys = new PluginSystem();
    const order: string[] = [];

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => { order.push("gate"); return true; });
      hooks.filter("SessionStart", (e) => { order.push("filter"); return e; });
      hooks.on("SessionStart", () => { order.push("handle"); });
      hooks.late("SessionStart", () => { order.push("late"); });
    });

    await sys.emit(mockEvent);
    expect(order).toEqual(["gate", "filter", "handle", "late"]);
  });

  test("emit returns boolean (gated vs processed)", async () => {
    const sys = new PluginSystem();

    const r1 = await sys.emit(mockEvent);
    expect(r1).toBe(true); // no gates = processed

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => false);
    });

    const r2 = await sys.emit(mockEvent);
    expect(r2).toBe(false); // gated
  });

  test("stats includes gate and late counts", () => {
    const sys = new PluginSystem();

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => true);
      hooks.filter("*", (e) => e);
      hooks.on("*", () => {});
      hooks.late("*", () => {});
    });

    const s = sys.stats();
    expect(s.gates).toEqual({ SessionStart: 1 });
    expect(s.filters).toEqual({ "*": 1 });
    expect(s.handlers).toEqual({ "*": 1 });
    expect(s.lates).toEqual({ "*": 1 });
  });
});
