import { describe, test, expect } from "bun:test";
import {
  resolveByName,
  resolveSessionTarget,
  resolveWorktreeTarget,
} from "../src/core/matcher/resolve-target";

// Minimal session-shaped fixture — only `name` is required by the resolver.
type Session = { name: string; windows?: { index: number }[] };
const sess = (name: string): Session => ({ name, windows: [{ index: 0 }] });

describe("resolveByName — exact match", () => {
  test("exact (case-insensitive) match wins over fuzzy candidates", () => {
    // target "view" exists exactly AND several sessions fuzzy-match — exact must win
    const items = [sess("mawjs-view"), sess("view"), sess("mawui-view")];
    const r = resolveByName("view", items);
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.match.name).toBe("view");
  });

  test("exact match is case-insensitive", () => {
    const items = [sess("Mawjs")];
    const r = resolveByName("MAWJS", items);
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.match.name).toBe("Mawjs");
  });
});

describe("resolveByName — fuzzy match (single hit)", () => {
  test("suffix match → fuzzy (fleet-numbered session: 110-yeast)", () => {
    const items = [sess("110-yeast"), sess("120-brew")];
    const r = resolveByName("yeast", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("110-yeast");
  });

  test("prefix match → fuzzy (mawjs matches mawjs-view)", () => {
    const items = [sess("mawjs-view"), sess("other")];
    const r = resolveByName("mawjs", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("mawjs-view");
  });

  test("case-insensitive fuzzy — MAWJS matches mawjs-view", () => {
    const items = [sess("mawjs-view")];
    const r = resolveByName("MAWJS", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("mawjs-view");
  });
});

describe("resolveByName — ambiguous (2+ fuzzy hits)", () => {
  test("multiple suffix matches → ambiguous with all candidates", () => {
    const items = [
      sess("mawjs-view"),
      sess("mawui-view"),
      sess("skills-cli-view"),
      sess("unrelated"),
    ];
    const r = resolveByName("view", items);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      const names = r.candidates.map(c => c.name).sort();
      expect(names).toEqual(["mawjs-view", "mawui-view", "skills-cli-view"]);
    }
  });

  test("mixed prefix and suffix matches → ambiguous lists both", () => {
    // "maw" matches both "maw-js" (prefix) and "110-maw" (suffix)
    const items = [sess("maw-js"), sess("110-maw"), sess("other")];
    const r = resolveByName("maw", items);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates).toHaveLength(2);
      const names = r.candidates.map(c => c.name).sort();
      expect(names).toEqual(["110-maw", "maw-js"]);
    }
  });

  test("ambiguous returns ALL candidates — does not truncate", () => {
    const items = Array.from({ length: 7 }, (_, i) => sess(`node${i}-view`));
    const r = resolveByName("view", items);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(7);
  });
});

describe("resolveByName — no match", () => {
  test("zero matches → none", () => {
    const items = [sess("alpha"), sess("beta-core")];
    const r = resolveByName("nonesuch", items);
    expect(r.kind).toBe("none");
  });

  test("empty target → none (does not match everything)", () => {
    const items = [sess("a"), sess("b-c")];
    const r = resolveByName("", items);
    expect(r.kind).toBe("none");
  });

  test("whitespace-only target → none", () => {
    const items = [sess("a"), sess("b-c")];
    const r = resolveByName("   ", items);
    expect(r.kind).toBe("none");
  });

  test("empty item list → none", () => {
    const r = resolveByName("view", []);
    expect(r.kind).toBe("none");
  });

  test("bare substring (not prefix/suffix boundary) does NOT match", () => {
    // "iew" is a substring of "view" but not suffix -iew or prefix iew-
    const items = [sess("mawjs-view")];
    const r = resolveByName("iew", items);
    expect(r.kind).toBe("none");
  });
});

describe("resolveByName — target trimming", () => {
  test("whitespace-trimmed target still resolves exact", () => {
    const items = [sess("view"), sess("mawjs-view")];
    const r = resolveByName("  view  ", items);
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.match.name).toBe("view");
  });

  test("whitespace-trimmed target still resolves fuzzy", () => {
    const items = [sess("110-yeast")];
    const r = resolveByName("\tyeast\n", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("110-yeast");
  });
});

describe("resolveByName — generic over other shapes", () => {
  test("worktree-shaped items ({name, path}) work via the generic", () => {
    type Worktree = { name: string; path: string };
    const trees: Worktree[] = [
      { name: "mawjs-view", path: "/tmp/mawjs-view" },
      { name: "mawjs-fix", path: "/tmp/mawjs-fix" },
    ];
    const r = resolveByName<Worktree>("fix", trees);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") {
      // Proves the generic preserves the full item type, not just { name }
      expect(r.match.path).toBe("/tmp/mawjs-fix");
    }
  });

  test("resolveSessionTarget and resolveWorktreeTarget are the same helper", () => {
    const items = [sess("110-yeast")];
    const a = resolveSessionTarget("yeast", items);
    const b = resolveWorktreeTarget("yeast", items);
    expect(a).toEqual(b);
  });
});
