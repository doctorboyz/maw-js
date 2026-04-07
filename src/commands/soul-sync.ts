import { existsSync, readdirSync, copyFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { ssh } from "../ssh";
import { loadConfig } from "../config";
import { loadFleet, type FleetSession } from "./fleet-load";

const SYNC_DIRS = ["memory/learnings", "memory/retrospectives", "memory/traces"];

/**
 * Sync new files from src dir to dst dir (skip existing).
 * Returns count of files copied.
 */
export function syncDir(srcDir: string, dstDir: string): number {
  if (!existsSync(srcDir)) return 0;
  let count = 0;

  function walk(src: string, dst: string) {
    let entries: string[];
    try { entries = readdirSync(src, { withFileTypes: true } as any) as any; }
    catch { return; }

    for (const entry of entries as any[]) {
      const srcPath = join(src, entry.name);
      const dstPath = join(dst, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (!existsSync(dstPath)) {
        try {
          mkdirSync(dst, { recursive: true });
          copyFileSync(srcPath, dstPath);
          count++;
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(srcDir, dstDir);
  return count;
}

/**
 * Resolve ghq path for an oracle name.
 * Tries: ghq list --full-path | grep -i '/<name>-oracle$'
 */
async function resolveOraclePath(name: string): Promise<string | null> {
  try {
    const out = await ssh(`ghq list --full-path | grep -i '/${name}-oracle$' | head -1`);
    if (out?.trim()) return out.trim();
  } catch { /* not found */ }

  // Fallback: check fleet config for repo path
  const ghqRoot = loadConfig().ghqRoot;
  const fleet = loadFleet();
  for (const sess of fleet) {
    const oracleName = sess.name.replace(/^\d+-/, "");
    if (oracleName === name && sess.windows.length > 0) {
      const repoPath = join(ghqRoot, sess.windows[0].repo);
      if (existsSync(repoPath)) return repoPath;
    }
  }

  return null;
}

/**
 * Find peer oracle names for a given oracle from fleet config.
 * Flat lookup — each oracle declares its own sync_peers.
 */
export function findPeers(oracleName: string): string[] {
  const fleet = loadFleet();
  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (name === oracleName && sess.sync_peers) return sess.sync_peers;
  }
  return [];
}

export interface SoulSyncResult {
  from: string;
  to: string;
  synced: Record<string, number>;
  total: number;
}

/**
 * Sync ψ/memory/ from one oracle repo to another (new files only).
 */
function syncOracleVaults(fromPath: string, toPath: string, fromName: string, toName: string): SoulSyncResult {
  const fromVault = join(fromPath, "ψ");
  const toVault = join(toPath, "ψ");

  const synced: Record<string, number> = {};
  for (const subdir of SYNC_DIRS) {
    const src = join(fromVault, subdir);
    const dst = join(toVault, subdir);
    const count = syncDir(src, dst);
    if (count > 0) synced[subdir] = count;
  }

  const total = Object.values(synced).reduce((a, b) => a + b, 0);

  // Write sync receipt log
  if (total > 0) {
    const logDir = join(toVault, ".soul-sync");
    try {
      mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString();
      const logLine = `${ts} | ${fromName} → ${toName} | ${total} files | ${Object.entries(synced).map(([k, v]) => `${v} ${k.split("/").pop()}`).join(", ")}\n`;
      appendFileSync(join(logDir, "sync.log"), logLine);
    } catch { /* non-critical */ }
  }

  return { from: fromName, to: toName, synced, total };
}

/**
 * maw soul-sync [peer] [--from <peer>]
 *
 * Flat mycelium model — any oracle syncs to any peer.
 *
 *   maw ss              push to all configured sync_peers
 *   maw ss <peer>       push to specific peer
 *   maw ss --from <p>   pull from specific peer
 */
export async function cmdSoulSync(target?: string, opts?: { from?: boolean; cwd?: string }): Promise<SoulSyncResult[]> {
  const results: SoulSyncResult[] = [];

  // Resolve current oracle
  let cwd = opts?.cwd || "";
  if (!cwd) {
    try {
      cwd = (await ssh("tmux display-message -p '#{pane_current_path}'")).trim();
    } catch {
      cwd = process.cwd();
    }
  }

  const cwdParts = cwd.split("/");
  const repoName = cwdParts.pop() || "";
  const oracleName = repoName.replace(/-oracle$/, "").replace(/\.wt-.*$/, "");

  // Resolve current oracle path (may be worktree, use git common dir)
  let oraclePath = cwd;
  try {
    const commonDir = (await ssh(`git -C '${cwd}' rev-parse --git-common-dir`)).trim();
    if (commonDir && commonDir !== ".git") {
      const mainGit = commonDir.startsWith("/") ? commonDir : join(cwd, commonDir);
      oraclePath = join(mainGit, "..");
    }
  } catch { /* use cwd */ }

  // Determine peers to sync with
  const peers = target ? [target] : findPeers(oracleName);
  if (peers.length === 0) {
    console.log(`  \x1b[33m⚠\x1b[0m soul-sync: no sync_peers configured for '${oracleName}'`);
    console.log(`  \x1b[90mAdd "sync_peers": ["name"] to fleet config, or run: maw ss <peer>\x1b[0m`);
    return results;
  }

  const direction = opts?.from ? "pull" : "push";
  const label = direction === "pull"
    ? `pulling ${peers[0]} → ${oracleName}`
    : `pushing ${oracleName} → ${peers.join(", ")}`;
  console.log(`\n  \x1b[36m⚡ Soul Sync\x1b[0m — ${label}\n`);

  for (const peer of peers) {
    const peerPath = await resolveOraclePath(peer);
    if (!peerPath) {
      console.log(`  \x1b[33m⚠\x1b[0m ${peer}: repo not found, skipping`);
      continue;
    }

    const [from, to, fromName, toName] = direction === "pull"
      ? [peerPath, oraclePath, peer, oracleName]
      : [oraclePath, peerPath, oracleName, peer];

    const result = syncOracleVaults(from, to, fromName, toName);
    results.push(result);

    if (result.total === 0) {
      console.log(`  \x1b[90m○\x1b[0m ${fromName} → ${toName}: nothing new`);
    } else {
      const parts = Object.entries(result.synced).map(([dir, n]) => `${n} ${dir.split("/").pop()}`);
      console.log(`  \x1b[32m✓\x1b[0m ${fromName} → ${toName}: ${parts.join(", ")}`);
    }
  }

  const totalAll = results.reduce((a, r) => a + r.total, 0);
  if (totalAll > 0) {
    console.log(`\n  \x1b[32m${totalAll} file(s) synced.\x1b[0m\n`);
  } else {
    console.log();
  }

  return results;
}
