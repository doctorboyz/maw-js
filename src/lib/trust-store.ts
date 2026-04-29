/**
 * trust-store.ts — pure data layer for the pairwise trust list (#924 sub-PR 1).
 *
 * Background
 * ──────────
 * #918 (Phase 3 of the lean-core epic, #640) extracted 19 plugins out of the
 * core CLI into community-style modules. Six plugins were deferred because
 * `src/` files still imported from inside their plugin directory; trust is one
 * of them — `src/commands/shared/scope-acl.ts` consumes `loadTrust` from
 * `commands/plugins/trust/store`, which means the trust plugin can't be
 * physically moved without breaking the core ACL evaluator.
 *
 * This module is the unblock: it lifts the storage layer up into `src/lib/`
 * (a directory that survives plugin extraction), exposing the same pure
 * read/write/path/equality primitives the trust plugin already uses. The
 * plugin's existing `store.ts` becomes a thin re-export shim so that all
 * existing imports — both inside and outside the plugin — keep working.
 *
 * Mirrors the pattern set by `src/lib/profile-loader.ts` (#889): a pure data
 * layer that any code in `src/` can depend on without coupling to a specific
 * plugin's directory structure. Once #924 sub-PR 2+ lands, this module is the
 * only thing core needs from the trust feature, and the plugin directory can
 * be physically moved into a community package.
 *
 * Behavior is byte-for-byte identical to the previous `plugins/trust/store.ts`:
 *
 *   - Atomic write via tmp + rename(2)
 *   - Forgiving load (missing / corrupt / wrong-shape → `[]`)
 *   - Live path resolution (re-reads MAW_HOME / MAW_CONFIG_DIR per call)
 *   - Symmetric `samePair` for direction-agnostic matching
 *
 * No new tests are required for the existing contracts — the plugin's existing
 * trust-list test suite covers them via the re-export shim. A new test file
 * (`test/isolated/trust-store-lib.test.ts`) confirms that this module's
 * exports work when imported DIRECTLY (i.e. without traversing the plugin
 * directory at all), which is the property #924 needs for community
 * extraction.
 *
 * See also:
 *   - src/lib/profile-loader.ts (#889) — pattern for pure data layer in src/lib/
 *   - src/commands/plugins/trust/store.ts — back-compat shim that re-exports this
 *   - src/commands/shared/scope-acl.ts — primary core consumer (#842 Sub-A/B)
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * On-disk trust entry. `sender` / `target` are oracle names matching
 * `Scope.members[*]`. `addedAt` is the ISO timestamp when the entry was
 * first written — useful for `maw trust list` to show recency, and for
 * future TTL semantics if/when trust entries gain expiry.
 *
 * Mirrors {@link import("../commands/shared/scope-acl").TrustEntry} on the
 * pair-key fields, with `addedAt` added on disk. `evaluateAcl()` only
 * reads `sender` / `target`, so the extra field doesn't break the ACL
 * type contract (TypeScript structural typing — extra fields are fine).
 */
export interface TrustEntryOnDisk {
  sender: string;
  target: string;
  addedAt: string;
}

/** A flat list of on-disk trust entries. May be empty. */
export type TrustListOnDisk = TrustEntryOnDisk[];

/**
 * Resolve the active config dir at call time (not import time) so tests
 * can point the directory at a temp path per-test by setting
 * `MAW_CONFIG_DIR` / `MAW_HOME` in beforeEach. Mirrors the precedence
 * logic in `src/core/paths.ts`, `scope/impl.ts::activeConfigDir`, and
 * `profile-loader.ts::activeConfigDir`.
 *
 *   1. `MAW_HOME` → `<MAW_HOME>/config` (instance mode, see #566)
 *   2. `MAW_CONFIG_DIR` override (legacy)
 *   3. Default singleton `~/.config/maw/`
 */
function activeConfigDir(): string {
  if (process.env.MAW_HOME) return join(process.env.MAW_HOME, "config");
  if (process.env.MAW_CONFIG_DIR) return process.env.MAW_CONFIG_DIR;
  return join(homedir(), ".config", "maw");
}

export function trustPath(): string {
  return join(activeConfigDir(), "trust.json");
}

/**
 * Read the trust list from disk. Returns `[]` if the file is missing,
 * unreadable, or malformed — forgiving semantics so an operator who's
 * never written a trust entry still gets a working empty list.
 */
export function loadTrust(): TrustListOnDisk {
  const path = trustPath();
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: skip entries that don't have the required string fields.
    // Operators may hand-edit trust.json (parallel to scope JSON's
    // documented hand-edit workflow), so a typo'd line shouldn't sink
    // the whole list.
    return parsed.filter(
      (e: any): e is TrustEntryOnDisk =>
        e &&
        typeof e.sender === "string" &&
        typeof e.target === "string" &&
        typeof e.addedAt === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Write the trust list atomically (tmp + rename). Creates the config
 * directory if missing. Mirrors `peers/store.ts::writeAtomic` and
 * `profile-loader.ts::atomicWriteJSON`.
 */
export function saveTrust(list: TrustListOnDisk): void {
  const path = trustPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Symmetric pair equality. `{a, b}` matches `{b, a}` — trust is
 * direction-agnostic, same as `evaluateAcl()`'s match semantics.
 */
export function samePair(
  a: { sender: string; target: string },
  b: { sender: string; target: string },
): boolean {
  return (
    (a.sender === b.sender && a.target === b.target) ||
    (a.sender === b.target && a.target === b.sender)
  );
}
