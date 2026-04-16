import { describe, it, expect } from "bun:test";
import { parseFlags } from "../src/cli/parse-args";

describe("parseFlags array spec", () => {
  it("collects repeated --meta values into string[]", () => {
    const r = parseFlags(["--meta", "a=1", "--meta", "b=2", "pos"], { "--meta": [String] }, 0);
    expect(r["--meta"]).toEqual(["a=1", "b=2"]);
    expect(r._).toEqual(["pos"]);
  });
  it("returns undefined when --meta absent", () => {
    const r = parseFlags(["pos"], { "--meta": [String] }, 0);
    expect(r["--meta"]).toBeUndefined();
  });
});
