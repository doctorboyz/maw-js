import { existsSync, readdirSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * Pure sync logic — no ssh/tmux. Same algorithm as soul-sync.ts syncDir.
 */
export function syncDirForTest(srcDir: string, dstDir: string): number {
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
        } catch { /* skip */ }
      }
    }
  }

  walk(srcDir, dstDir);
  return count;
}

interface FleetEntry {
  name: string;
  windows: { name: string; repo: string }[];
  parent?: string;
  children?: string[];
  skip_command?: boolean;
}

/**
 * Pure logic — findParent without loadFleet() dependency.
 */
export function findParentForTest(oracleName: string, fleet: FleetEntry[]): string | null {
  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (name === oracleName && sess.parent) return sess.parent;
  }
  for (const sess of fleet) {
    if (sess.children?.includes(oracleName)) {
      return sess.name.replace(/^\d+-/, "");
    }
  }
  return null;
}

/**
 * Pure logic — findChildren without loadFleet() dependency.
 */
export function findChildrenForTest(parentName: string, fleet: FleetEntry[]): string[] {
  const children: string[] = [];

  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (name === parentName && sess.children) {
      children.push(...sess.children);
    }
  }

  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (sess.parent === parentName && !children.includes(name)) {
      children.push(name);
    }
  }

  return children;
}
