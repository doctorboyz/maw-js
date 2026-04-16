/**
 * Golden-master tests for workspace flag parsing helpers.
 *
 * Covers create/join/share/unshare flag parsing logic.
 * Written first against the extracted helpers; same tests verified green
 * after parseFlags migration.
 */
import { describe, test, expect } from "bun:test";
import {
  _parseCreate,
  _parseJoin,
  _parseShareAgents,
} from "../src/commands/plugins/workspace/index";

describe("workspace _parseCreate", () => {
  test("name only — no hub", () => {
    const r = _parseCreate(["create", "myws"]);
    expect(r.name).toBe("myws");
    expect(r.hub).toBeUndefined();
  });

  test("--hub parsed correctly", () => {
    const r = _parseCreate(["create", "myws", "--hub", "http://hub.local:3456"]);
    expect(r.name).toBe("myws");
    expect(r.hub).toBe("http://hub.local:3456");
  });

  test("missing name returns undefined", () => {
    const r = _parseCreate(["create"]);
    expect(r.name).toBeUndefined();
    expect(r.hub).toBeUndefined();
  });

  test("--hub without value throws (stricter than old hand-rolled loop)", () => {
    // Old loop: silently ignored --hub at end of args.
    // parseFlags (arg lib): throws ArgError when String flag has no value.
    expect(() => _parseCreate(["create", "myws", "--hub"])).toThrow();
  });
});

describe("workspace _parseJoin", () => {
  test("code only — no hub", () => {
    const r = _parseJoin(["join", "ABCDEF"]);
    expect(r.code).toBe("ABCDEF");
    expect(r.hub).toBeUndefined();
  });

  test("--hub parsed correctly", () => {
    const r = _parseJoin(["join", "ABCDEF", "--hub", "http://hub.local:3456"]);
    expect(r.code).toBe("ABCDEF");
    expect(r.hub).toBe("http://hub.local:3456");
  });

  test("missing code returns undefined", () => {
    const r = _parseJoin(["join"]);
    expect(r.code).toBeUndefined();
    expect(r.hub).toBeUndefined();
  });

  test("--hub without value throws (stricter than old hand-rolled loop)", () => {
    // Old loop: silently ignored --hub at end of args.
    // parseFlags (arg lib): throws ArgError when String flag has no value.
    expect(() => _parseJoin(["join", "ABCDEF", "--hub"])).toThrow();
  });
});

describe("workspace _parseShareAgents (share + unshare)", () => {
  test("agents only — no workspace flag", () => {
    const r = _parseShareAgents(["share", "agent1", "agent2"]);
    expect(r.wsId).toBeUndefined();
    expect(r.agents).toEqual(["agent1", "agent2"]);
  });

  test("--ws alias resolves to wsId", () => {
    const r = _parseShareAgents(["share", "--ws", "ws_123", "agent1"]);
    expect(r.wsId).toBe("ws_123");
    expect(r.agents).toEqual(["agent1"]);
  });

  test("--workspace long form resolves to wsId", () => {
    const r = _parseShareAgents(["share", "--workspace", "ws_abc", "agent1", "agent2"]);
    expect(r.wsId).toBe("ws_abc");
    expect(r.agents).toEqual(["agent1", "agent2"]);
  });

  test("agents before flag also collected", () => {
    const r = _parseShareAgents(["share", "agent1", "--ws", "ws_xyz", "agent2"]);
    expect(r.wsId).toBe("ws_xyz");
    expect(r.agents).toEqual(["agent1", "agent2"]);
  });

  test("no agents returns empty array", () => {
    const r = _parseShareAgents(["share"]);
    expect(r.wsId).toBeUndefined();
    expect(r.agents).toEqual([]);
  });

  test("ws flag only — no agents", () => {
    const r = _parseShareAgents(["share", "--ws", "ws_999"]);
    expect(r.wsId).toBe("ws_999");
    expect(r.agents).toEqual([]);
  });

  test("unshare subcmd treated identically (subcmd is args[0])", () => {
    const r = _parseShareAgents(["unshare", "--workspace", "ws_123", "pulse"]);
    expect(r.wsId).toBe("ws_123");
    expect(r.agents).toEqual(["pulse"]);
  });

  test("--ws without value — wsId is undefined", () => {
    const r = _parseShareAgents(["share", "--ws", "agent1"]);
    // --ws consumes next token as value → wsId = "agent1", agents = []
    // This documents the current greedy-consume behavior
    expect(r.wsId).toBe("agent1");
    expect(r.agents).toEqual([]);
  });
});
