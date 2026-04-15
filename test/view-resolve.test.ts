/**
 * Regression tests for #357 — `maw a mawjs` must not be ambiguous
 * when a stale mawjs-view-view session also exists.
 *
 * Bug: `maw a mawjs` with sessions [mawjs-view, mawjs-view-view] returned
 *      "ambiguous" because both match the `mawjs-*` word-segment rule.
 * Fix: cmdView filters out `-view-view` sessions before resolving, so only
 *      mawjs-view remains as a candidate → clean fuzzy match.
 *
 * Tests verify the filter + resolve contract, not Tmux/execSync internals.
 */
import { describe, it, expect } from "bun:test";
import { resolveSessionTarget } from "../src/core/matcher/resolve-target";

type Session = { name: string; windows?: { index: number }[] };
const sess = (name: string): Session => ({ name, windows: [{ index: 0 }] });

/** Mirror the filter applied in cmdView after the #357 fix. */
function filterViewOfView(sessions: Session[]): Session[] {
  return sessions.filter(s => !/-view-view$/.test(s.name));
}

describe("#357 — mawjs-view-view excluded from view target resolution", () => {
  it("filter removes -view-view sessions, leaving mawjs-view", () => {
    const raw = [sess("mawjs-view"), sess("mawjs-view-view")];
    expect(filterViewOfView(raw).map(s => s.name)).toEqual(["mawjs-view"]);
  });

  it("'mawjs' resolves fuzzy→mawjs-view after filter (not ambiguous)", () => {
    const raw = [sess("mawjs-view"), sess("mawjs-view-view")];
    const r = resolveSessionTarget("mawjs", filterViewOfView(raw));
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("mawjs-view");
  });

  it("filter also removes multi-node view-of-view variants", () => {
    const raw = [
      sess("102-white-wormhole-view"),
      sess("102-white-wormhole-view-view"),
      sess("103-neo-mawjs-view"),
      sess("103-neo-mawjs-view-view"),
    ];
    const filtered = filterViewOfView(raw).map(s => s.name);
    expect(filtered).toEqual(["102-white-wormhole-view", "103-neo-mawjs-view"]);
  });

  it("genuine ambiguity still surfaces after filter", () => {
    // mawjs-view AND mawui-view both start with 'view' suffix — still ambiguous
    const raw = [sess("mawjs-view"), sess("mawui-view"), sess("skills-cli-view-view")];
    const r = resolveSessionTarget("view", filterViewOfView(raw));
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      const names = r.candidates.map(c => c.name).sort();
      expect(names).toEqual(["mawjs-view", "mawui-view"]);
    }
  });

  it("exact session name still wins even when -view-view exists", () => {
    const raw = [sess("mawjs"), sess("mawjs-view"), sess("mawjs-view-view")];
    const r = resolveSessionTarget("mawjs", filterViewOfView(raw));
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.match.name).toBe("mawjs");
  });

  it("filter is idempotent on clean session list (no -view-view)", () => {
    const raw = [sess("mawjs-view"), sess("mawui-view"), sess("101-red-alpha")];
    expect(filterViewOfView(raw)).toHaveLength(3);
  });
});
