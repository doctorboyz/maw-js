/**
 * maw trust — storage layer (back-compat shim, #924 sub-PR 1).
 *
 * The actual storage primitives now live in `src/lib/trust-store.ts` so that
 * core consumers (notably `src/commands/shared/scope-acl.ts`) can depend on
 * them without reaching INTO the plugin directory. That decoupling is what
 * unblocks community extraction of the trust plugin (deferred from #918's
 * Phase 3 lean-core sweep — see #924 for the full extraction plan).
 *
 * This file is preserved as a thin re-export so:
 *
 *   - existing plugin code (`impl.ts`) keeps importing `./store` as before
 *   - existing tests under `test/isolated/trust-list.test.ts` and
 *     `test/isolated/comm-send-acl.test.ts` keep working unchanged
 *   - third-party plugin authors who copied the trust plugin pattern still
 *     find a `store.ts` next to `impl.ts`
 *
 * Once #924 fully extracts the trust plugin to a community package, this
 * shim disappears with the rest of the plugin directory. Until then:
 * NEW core code should import from `src/lib/trust-store` directly. Plugin-
 * internal code may use either path — both resolve to the same module.
 *
 * See also:
 *   - src/lib/trust-store.ts — canonical storage primitives
 *   - src/commands/shared/scope-acl.ts — uses `src/lib/trust-store` directly
 *   - src/lib/profile-loader.ts (#889) — same pure-data-layer pattern
 */
export {
  loadTrust,
  saveTrust,
  samePair,
  trustPath,
  type TrustEntryOnDisk,
  type TrustListOnDisk,
} from "../../../lib/trust-store";
