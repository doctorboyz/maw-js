/**
 * Regression tests for #358 — oracle names ending in `-view` must be rejected
 * at user-input boundaries (bud, wake, awaken) so that `foo-view-view` chains
 * and session-resolution ambiguity can never exist in the first place.
 *
 * Fix: src/core/fleet/validate.ts exports `assertValidOracleName(name)` —
 *      throws with a helpful message that suggests dropping the `-view`
 *      suffix. The view/impl.ts `-view-view` filter stays as cruft-handler
 *      for any pre-existing sessions, but new creation paths must enforce.
 */
import { describe, it, expect } from "bun:test";
import { assertValidOracleName } from "../src/core/fleet/validate";

describe("#358 — assertValidOracleName rejects `-view` suffix", () => {
  it("rejects `foo-view` with a message suggesting `foo`", () => {
    expect(() => assertValidOracleName("foo-view")).toThrow(/-view/);
    try {
      assertValidOracleName("foo-view");
      throw new Error("expected assertValidOracleName to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("-view");
      expect(msg).toContain("'foo'"); // suggestion text
    }
  });

  it("rejects `mawjs-view`", () => {
    expect(() => assertValidOracleName("mawjs-view")).toThrow();
  });

  it("accepts bare `foo`", () => {
    expect(() => assertValidOracleName("foo")).not.toThrow();
  });

  it("accepts `mawjs-neo`", () => {
    expect(() => assertValidOracleName("mawjs-neo")).not.toThrow();
  });

  it("accepts `view-foo` — `view` as prefix is fine, only suffix is reserved", () => {
    expect(() => assertValidOracleName("view-foo")).not.toThrow();
  });

  it("rejects `multi-word-oracle-view` — the suffix rule applies regardless of name length", () => {
    expect(() => assertValidOracleName("multi-word-oracle-view")).toThrow(/-view/);
  });
});
