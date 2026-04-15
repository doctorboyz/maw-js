/**
 * Regression tests for #359 — maw ls must visually distinguish view sessions
 * from source sessions.
 *
 * Fix: comm.ts exports `renderSessionName(name)` — view sessions render dim
 *      with `[view]` tag; source sessions render bright cyan. Session name
 *      position on the line is unchanged so shell parsers keep working.
 */
import { describe, it, expect } from "bun:test";
import { renderSessionName } from "../src/commands/shared/comm";

describe("#359 — ls distinguishes view from source sessions", () => {
  it("source session `mawjs-neo` renders in bright cyan, no tag", () => {
    const out = renderSessionName("mawjs-neo");
    expect(out).toBe("\x1b[36mmawjs-neo\x1b[0m");
    expect(out).not.toContain("[view]");
    expect(out).not.toContain("\x1b[90m");
  });

  it("view session `mawjs-view` renders dim with `[view]` tag", () => {
    const out = renderSessionName("mawjs-view");
    expect(out).toContain("\x1b[90mmawjs-view\x1b[0m");
    expect(out).toContain("[view]");
    expect(out).not.toMatch(/\x1b\[36m/); // no bright cyan on view rows
  });

  it("`maw-view` meta-session is treated as a view", () => {
    const out = renderSessionName("maw-view");
    expect(out).toContain("\x1b[90mmaw-view\x1b[0m");
    expect(out).toContain("[view]");
  });

  it("sessions with `view` elsewhere in the name are NOT marked as views", () => {
    // no regression: substring/prefix `view` must not dim the row.
    for (const name of ["wasm-host", "wasm-safety", "view-foo", "previewer"]) {
      expect(renderSessionName(name)).toBe(`\x1b[36m${name}\x1b[0m`);
    }
  });
});
