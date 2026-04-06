import { existsSync, readdirSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";
import { ssh } from "../ssh";
import { loadConfig } from "../config";
import { loadFleet, type FleetSession } from "./fleet-load";

const SYNC_DIRS = ["memory/learnings", "memory/retrospectives", "memory/traces"];

/**
 * Sync new files from src dir to dst dir (skip existing).
 * Returns count of files copied.
 */
function syncDir(srcDir: string, dstDir: string): number {
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
 * Find parent oracle name for a given oracle from fleet config.
 */
export function findParent(oracleName: string): string | null {
  const fleet = loadFleet();
  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (name === oracleName && sess.parent) return sess.parent;
  }
  // Also check if any session lists this oracle as a child
  for (const sess of fleet) {
    if (sess.children?.includes(oracleName)) {
      return sess.name.replace(/^\d+-/, "");
    }
  }
  return null;
}

/**
 * Find children oracle names for a given parent from fleet config.
 */
export function findChildren(parentName: string): string[] {
  const fleet = loadFleet();
  const children: string[] = [];

  // Direct: parent has children[] field
  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (name === parentName && sess.children) {
      children.push(...sess.children);
    }
  }

  // Reverse: child has parent field pointing to this parent
  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (sess.parent === parentName && !children.includes(name)) {
      children.push(name);
    }
  }

  return children;
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
  return { from: fromName, to: toName, synced, total };
}

/**
 * maw soul-sync [target]
 *
 * Without target: sync current oracle's ψ/ to its configured parent.
 * With target: pull ψ/ from all children of the named parent oracle.
 *
 * Direction:
 *   child → parent  (default, auto-detected from fleet config)
 *   parent ← children  (when target is a parent name)
 */
export async function cmdSoulSync(target?: string): Promise<SoulSyncResult[]> {
  const results: SoulSyncResult[] = [];

  if (target) {
    // Pull mode: target is a parent, pull from all children
    const children = findChildren(target);
    if (children.length === 0) {
      console.log(`  \x1b[33m⚠\x1b[0m soul-sync: no children configured for '${target}'`);
      return results;
    }

    const parentPath = await resolveOraclePath(target);
    if (!parentPath) {
      console.error(`  \x1b[31m✗\x1b[0m soul-sync: cannot find repo for parent '${target}'`);
      return results;
    }

    console.log(`\n  \x1b[36m⚡ Soul Sync\x1b[0m — pulling ${children.length} children → ${target}\n`);

    for (const child of children) {
      const childPath = await resolveOraclePath(child);
      if (!childPath) {
        console.log(`  \x1b[33m⚠\x1b[0m ${child}: repo not found, skipping`);
        continue;
      }

      const result = syncOracleVaults(childPath, parentPath, child, target);
      results.push(result);

      if (result.total === 0) {
        console.log(`  \x1b[90m○\x1b[0m ${child} → nothing new`);
      } else {
        const parts = Object.entries(result.synced).map(([dir, n]) => `${n} ${dir.split("/").pop()}`);
        console.log(`  \x1b[32m✓\x1b[0m ${child} → ${parts.join(", ")}`);
      }
    }
  } else {
    // Push mode: detect current oracle, sync to parent
    let cwd = "";
    try {
      cwd = (await ssh("tmux display-message -p '#{pane_current_path}'")).trim();
    } catch {
      cwd = process.cwd();
    }

    // Detect oracle name from cwd
    const parts = cwd.split("/");
    const repoName = parts.pop() || "";
    const oracleName = repoName.replace(/-oracle$/, "").replace(/\.wt-.*$/, "");

    const parent = findParent(oracleName);
    if (!parent) {
      console.log(`  \x1b[33m⚠\x1b[0m soul-sync: no parent configured for '${oracleName}'`);
      console.log(`  \x1b[90mAdd "parent": "<name>" to fleet config, or run: maw soul-sync <parent>\x1b[0m`);
      return results;
    }

    const parentPath = await resolveOraclePath(parent);
    if (!parentPath) {
      console.error(`  \x1b[31m✗\x1b[0m soul-sync: cannot find repo for parent '${parent}'`);
      return results;
    }

    // Resolve current oracle path (may be worktree, use git common dir)
    let oraclePath = cwd;
    try {
      const commonDir = (await ssh(`git -C '${cwd}' rev-parse --git-common-dir`)).trim();
      if (commonDir && commonDir !== ".git") {
        const mainGit = commonDir.startsWith("/") ? commonDir : join(cwd, commonDir);
        oraclePath = join(mainGit, "..");
      }
    } catch { /* use cwd */ }

    console.log(`\n  \x1b[36m⚡ Soul Sync\x1b[0m — ${oracleName} → ${parent}\n`);

    const result = syncOracleVaults(oraclePath, parentPath, oracleName, parent);
    results.push(result);

    if (result.total === 0) {
      console.log(`  \x1b[90m○\x1b[0m nothing new to sync`);
    } else {
      const parts = Object.entries(result.synced).map(([dir, n]) => `${n} ${dir.split("/").pop()}`);
      console.log(`  \x1b[32m✓\x1b[0m synced ${parts.join(", ")} → ${parent}/ψ/`);
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
