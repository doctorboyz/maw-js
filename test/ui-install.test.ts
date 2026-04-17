/**
 * Tests for `maw ui install` / `maw ui status`.
 *
 * Strategy: `buildGhReleaseArgs` is a pure function, so the gh command
 * construction is testable without mocking spawnSync or touching the
 * filesystem. `parseUiArgs` covers subcommand detection + flag routing.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildGhReleaseArgs, resolveInstalledVersion } from "../src/commands/plugins/ui/ui-install";
import { parseUiArgs } from "../src/commands/plugins/ui/impl";

// ---- buildGhReleaseArgs — gh release download command construction --------

describe("buildGhReleaseArgs", () => {
  test("omits tag arg when ref is undefined (gh picks latest release by default)", () => {
    const args = buildGhReleaseArgs("Soul-Brews-Studio/maw-ui", undefined, "/tmp/maw-ui-xxx");
    expect(args[0]).toBe("release");
    expect(args[1]).toBe("download");
    // Next arg should be -R, not a tag — because 'latest' would be treated
    // as a literal tag name by gh and fail with "release not found".
    expect(args[2]).toBe("-R");
  });

  test("uses provided version tag", () => {
    const args = buildGhReleaseArgs("Soul-Brews-Studio/maw-ui", "v1.15.0", "/tmp/maw-ui-xxx");
    expect(args[2]).toBe("v1.15.0");
  });

  test("includes -R <repo>", () => {
    const args = buildGhReleaseArgs("Soul-Brews-Studio/maw-ui", "latest", "/tmp/x");
    const rIdx = args.indexOf("-R");
    expect(rIdx).not.toBe(-1);
    expect(args[rIdx + 1]).toBe("Soul-Brews-Studio/maw-ui");
  });

  test("includes --pattern maw-ui-dist.tar.gz", () => {
    const args = buildGhReleaseArgs("Soul-Brews-Studio/maw-ui", "latest", "/tmp/x");
    const pIdx = args.indexOf("--pattern");
    expect(pIdx).not.toBe(-1);
    expect(args[pIdx + 1]).toBe("maw-ui-dist.tar.gz");
  });

  test("includes --dir pointing at provided tmpDir", () => {
    const tmpDir = "/tmp/maw-ui-abc123";
    const args = buildGhReleaseArgs("Soul-Brews-Studio/maw-ui", "latest", tmpDir);
    const dIdx = args.indexOf("--dir");
    expect(dIdx).not.toBe(-1);
    expect(args[dIdx + 1]).toBe(tmpDir);
  });

  test("works with an arbitrary repo slug", () => {
    const args = buildGhReleaseArgs("my-org/my-ui", "v2.0.0", "/tmp/x");
    expect(args[args.indexOf("-R") + 1]).toBe("my-org/my-ui");
    expect(args[2]).toBe("v2.0.0");
  });
});

// ---- resolveInstalledVersion — version resolution for `maw ui status` ---

describe("resolveInstalledVersion", () => {
  function mkDist(): string {
    return mkdtempSync(join(tmpdir(), "maw-ui-ver-"));
  }

  test("returns null when neither marker nor index.html exists", () => {
    const d = mkDist();
    try {
      expect(resolveInstalledVersion(d)).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("reads version from .maw-ui-version marker (preferred source)", () => {
    const d = mkDist();
    try {
      writeFileSync(join(d, ".maw-ui-version"), "v1.15.0\n");
      expect(resolveInstalledVersion(d)).toBe("v1.15.0");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("marker wins over index.html data attribute", () => {
    const d = mkDist();
    try {
      writeFileSync(join(d, ".maw-ui-version"), "v2.0.0\n");
      writeFileSync(join(d, "index.html"), `<html data-maw-ui-version="0.9.0"></html>`);
      expect(resolveInstalledVersion(d)).toBe("v2.0.0");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("falls back to data-maw-ui-version in index.html when no marker", () => {
    const d = mkDist();
    try {
      writeFileSync(join(d, "index.html"), `<html data-maw-ui-version="1.15.0"></html>`);
      expect(resolveInstalledVersion(d)).toBe("1.15.0");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("empty marker file falls through to index.html / null", () => {
    const d = mkDist();
    try {
      writeFileSync(join(d, ".maw-ui-version"), "   \n");
      expect(resolveInstalledVersion(d)).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

// ---- parseUiArgs — install/status subcommand detection -------------------

describe("parseUiArgs — subcommands", () => {
  test("detects install subcommand", () => {
    const opts = parseUiArgs(["install"]);
    expect(opts.subcommand).toBe("install");
    expect(opts.version).toBeUndefined();
  });

  test("detects status subcommand", () => {
    const opts = parseUiArgs(["status"]);
    expect(opts.subcommand).toBe("status");
  });

  test("parses --version with install subcommand", () => {
    const opts = parseUiArgs(["install", "--version", "v1.15.0"]);
    expect(opts.subcommand).toBe("install");
    expect(opts.version).toBe("v1.15.0");
  });

  test("non-subcommand first arg treated as peer", () => {
    const opts = parseUiArgs(["white"]);
    expect(opts.subcommand).toBeUndefined();
    expect(opts.peer).toBe("white");
  });

  test("--install flag still works (backward compat)", () => {
    const opts = parseUiArgs(["--install"]);
    expect(opts.install).toBe(true);
    expect(opts.subcommand).toBeUndefined();
  });

  test("bare maw ui has no subcommand", () => {
    const opts = parseUiArgs([]);
    expect(opts.subcommand).toBeUndefined();
    expect(opts.install).toBeUndefined();
    expect(opts.peer).toBeUndefined();
  });

  test("status does not bleed into install path", () => {
    const opts = parseUiArgs(["status"]);
    expect(opts.subcommand).toBe("status");
    expect(opts.install).toBeUndefined();
  });
});
