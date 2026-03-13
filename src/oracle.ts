import { listSessions, ssh } from "./ssh";
import { findWorktrees, detectSession } from "./wake";

/** Like resolveOracle but returns null instead of process.exit */
async function resolveOracleSafe(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string } | { parentDir: ""; repoName: ""; repoPath: "" }> {
  try {
    // Try oracle-oracle pattern first
    let ghqOut = await ssh(`ghq list --full-path | grep -i '/${oracle}-oracle$' | head -1`).catch(() => "");
    if (!ghqOut.trim()) {
      // Try direct name (e.g., homekeeper → homelab)
      ghqOut = await ssh(`ghq list --full-path | grep -i '/${oracle}$' | head -1`).catch(() => "");
    }
    if (!ghqOut.trim()) return { parentDir: "", repoName: "", repoPath: "" };
    const repoPath = ghqOut.trim();
    const repoName = repoPath.split("/").pop()!;
    const parentDir = repoPath.replace(/\/[^/]+$/, "");
    return { repoPath, repoName, parentDir };
  } catch {
    return { parentDir: "", repoName: "", repoPath: "" };
  }
}

// All known oracles (from pulse.config.json oracleRepos keys)
const ORACLES = [
  "pulse", "hermes", "neo", "nexus", "volt", "odin",
  "homekeeper", "dustboy", "floodboy", "fireman", "calliope", "mother",
];

interface OracleStatus {
  name: string;
  session: string | null;
  windows: string[];
  worktrees: number;
  status: "awake" | "sleeping";
}

export async function cmdOracleList() {
  const sessions = await listSessions();
  const statuses: OracleStatus[] = [];

  for (const oracle of ORACLES) {
    const session = await detectSession(oracle);

    let windows: string[] = [];
    if (session) {
      const s = sessions.find(s => s.name === session);
      if (s) {
        windows = s.windows.map(w => w.name);
      }
    }

    // Count worktrees (resolveOracle may exit on failure, so catch that)
    let worktrees = 0;
    try {
      const { parentDir, repoName } = await resolveOracleSafe(oracle);
      if (parentDir) {
        const wts = await findWorktrees(parentDir, repoName);
        worktrees = wts.length;
      }
    } catch {
      // Oracle repo not found on this machine
    }

    statuses.push({
      name: oracle,
      session,
      windows,
      worktrees,
      status: session ? "awake" : "sleeping",
    });
  }

  // Sort: awake first, then alphabetical
  statuses.sort((a, b) => {
    if (a.status !== b.status) return a.status === "awake" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const awakeCount = statuses.filter(s => s.status === "awake").length;

  console.log(`\n  \x1b[36mOracle Fleet\x1b[0m  (${awakeCount}/${statuses.length} awake)\n`);
  console.log(`  ${"Oracle".padEnd(14)} ${"Status".padEnd(10)} ${"Session".padEnd(16)} ${"Windows".padEnd(6)} ${"WT".padEnd(4)} Details`);
  console.log(`  ${"─".repeat(80)}`);

  for (const s of statuses) {
    const icon = s.status === "awake" ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
    const statusText = s.status === "awake" ? "\x1b[32mawake\x1b[0m " : "\x1b[90msleep\x1b[0m ";
    const sessionText = s.session || "-";
    const winCount = s.windows.length > 0 ? String(s.windows.length) : "-";
    const wtCount = s.worktrees > 0 ? String(s.worktrees) : "-";
    const details = s.windows.length > 0
      ? s.windows.slice(0, 4).join(", ") + (s.windows.length > 4 ? ` +${s.windows.length - 4}` : "")
      : "";

    console.log(`  ${icon} ${s.name.padEnd(13)} ${statusText.padEnd(19)} ${sessionText.padEnd(16)} ${winCount.padEnd(6)} ${wtCount.padEnd(4)} ${details}`);
  }

  console.log();
}
