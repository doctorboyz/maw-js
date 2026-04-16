import { scanAndCache, scanFull, scanRemote, readCache } from "../../../sdk";
import { cmdOracleList, type OracleListOpts } from "./impl-list";

export async function cmdOracleScan(opts: { force?: boolean; json?: boolean; local?: boolean; remote?: boolean; all?: boolean; verbose?: boolean } = {}) {
  const start = Date.now();

  // Default to local (fast). Use --all or --remote for GitHub API scan.
  const mode = opts.all ? "both" : opts.remote ? "remote" : "local";

  if (mode === "remote") {
    // Remote only — GitHub API. Loud on failure.
    console.log(`\n  \x1b[36m📡\x1b[0m Scanning GitHub orgs for *-oracle repos...\n`);
    const entries = await scanRemote(undefined, opts.verbose);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    console.log(`  \x1b[32m✓\x1b[0m Found ${entries.length} oracles remotely (${elapsed}s)\n`);
    for (const e of entries) {
      const psi = e.has_psi ? "\x1b[32mψ/\x1b[0m" : "\x1b[90m  \x1b[0m";
      console.log(`    ${psi} ${e.org}/${e.name}`);
    }
    console.log();
    return;
  }

  if (mode === "local") {
    // Local scan — write-only: count + delta vs previous cache. No list dump.
    // Callers wanting the full list should `maw oracle ls` (or --json here).
    const prev = readCache();
    const prevKeys = new Set((prev?.oracles || []).map(o => `${o.org}/${o.repo}`));

    const cache = scanAndCache("local");
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (opts.json) { console.log(JSON.stringify(cache, null, 2)); return; }

    const currKeys = new Set(cache.oracles.map(o => `${o.org}/${o.repo}`));
    const added = [...currKeys].filter(k => !prevKeys.has(k)).length;
    const removed = [...prevKeys].filter(k => !currKeys.has(k)).length;

    let delta: string;
    if (!prev) {
      delta = `${cache.oracles.length} new`;
    } else if (added === 0 && removed === 0) {
      delta = "no change";
    } else {
      delta = `+${added} -${removed} since last`;
    }

    console.log(`\n  \x1b[32m✓\x1b[0m ${cache.oracles.length} oracles locally (${delta}) in ${elapsed}s\n`);
    return;
  }

  // Both — full picture
  console.log(`\n  \x1b[36m📡\x1b[0m Full scan: local + GitHub remote...\n`);
  const cache = await scanFull(undefined, opts.verbose);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (opts.json) { console.log(JSON.stringify(cache, null, 2)); return; }

  const localCount = cache.oracles.filter(o => o.local_path).length;
  const remoteOnly = cache.oracles.filter(o => !o.local_path).length;
  console.log(`  \x1b[32m✓\x1b[0m ${cache.oracles.length} oracles (${localCount} local, ${remoteOnly} remote-only) (${elapsed}s)\n`);
  console.log(`  Cache written to \x1b[90m~/.config/maw/oracles.json\x1b[0m\n`);
}

/**
 * @deprecated Use `cmdOracleList` — `maw oracle fleet` is now an alias for `maw oracle ls`.
 * Preserved so external importers don't break. Emits a stderr deprecation
 * notice and delegates to the new grouped list view.
 */
export async function cmdOracleFleet(opts: OracleListOpts = {}) {
  console.error(
    `\x1b[33m⚠  maw oracle fleet is deprecated — use \x1b[36mmaw oracle ls\x1b[0m\x1b[33m instead\x1b[0m`,
  );
  await cmdOracleList(opts);
}
