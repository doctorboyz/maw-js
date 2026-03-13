import { listSessions, ssh } from "./ssh";
import type { Session } from "./ssh";
import { loadConfig, buildCommand, getEnvVars } from "./config";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/** Fetch a GitHub issue and build a prompt for claude -p */
export async function fetchIssuePrompt(issueNum: number, repo?: string): Promise<string> {
  // Detect repo from git remote if not specified
  let repoSlug = repo;
  if (!repoSlug) {
    try {
      const remote = await ssh("git remote get-url origin 2>/dev/null");
      const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (m) repoSlug = m[1];
    } catch {}
  }
  if (!repoSlug) throw new Error("Could not detect repo — pass --repo org/name");

  const json = await ssh(`gh issue view ${issueNum} --repo '${repoSlug}' --json title,body,labels`);
  const issue = JSON.parse(json);
  const labels = (issue.labels || []).map((l: any) => l.name).join(", ");
  const parts = [
    `Work on issue #${issueNum}: ${issue.title}`,
    labels ? `Labels: ${labels}` : "",
    "",
    issue.body || "(no description)",
  ];
  return parts.filter(Boolean).join("\n");
}

export async function resolveOracle(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  // 1. Try standard pattern: <oracle>-oracle
  const ghqOut = await ssh(`ghq list --full-path | grep -i '/${oracle}-oracle$' | head -1`);
  if (ghqOut?.trim()) {
    const repoPath = ghqOut.trim();
    const repoName = repoPath.split("/").pop()!;
    const parentDir = repoPath.replace(/\/[^/]+$/, "");
    return { repoPath, repoName, parentDir };
  }

  // 2. Fallback: check fleet configs for repo mapping
  const fleetDir = join(import.meta.dir, "../fleet");
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      const win = (config.windows || []).find((w: any) => w.name === `${oracle}-oracle`);
      if (win?.repo) {
        const fullPath = await ssh(`ghq list --full-path | grep -i '/${win.repo.replace(/^[^/]+\//, "")}$' | head -1`);
        if (fullPath?.trim()) {
          const repoPath = fullPath.trim();
          const repoName = repoPath.split("/").pop()!;
          const parentDir = repoPath.replace(/\/[^/]+$/, "");
          return { repoPath, repoName, parentDir };
        }
      }
    }
  } catch { /* fleet dir may not exist */ }

  console.error(`oracle repo not found: ${oracle} (tried ${oracle}-oracle pattern and fleet configs)`);
  process.exit(1);
}

export async function findWorktrees(parentDir: string, repoName: string): Promise<{ path: string; name: string }[]> {
  const lsOut = await ssh(`ls -d ${parentDir}/${repoName}.wt-* 2>/dev/null || true`);
  return lsOut.split("\n").filter(Boolean).map(p => {
    const base = p.split("/").pop()!;
    const suffix = base.replace(`${repoName}.wt-`, "");
    return { path: p, name: suffix };
  });
}

// Oracle → tmux session mapping (from config, with hardcoded fallback)
export function getSessionMap(): Record<string, string> {
  return loadConfig().sessions;
}

/** Scan fleet/*.json for a config containing a window matching the oracle name */
export function resolveFleetSession(oracle: string): string | null {
  const fleetDir = join(import.meta.dir, "../fleet");
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      const hasOracleWindow = (config.windows || []).some(
        (w: any) => w.name === `${oracle}-oracle` || w.name === oracle
      );
      if (hasOracleWindow) return config.name;
    }
  } catch { /* fleet dir may not exist */ }
  return null;
}

export async function detectSession(oracle: string): Promise<string | null> {
  const sessions = await listSessions();

  // 1. Check manual session map
  const mapped = getSessionMap()[oracle];
  if (mapped) {
    const exists = sessions.find(s => s.name === mapped);
    if (exists) return mapped;
  }

  // 2. Pattern match running sessions (e.g., "08-neo" for oracle "neo")
  const patternMatch = sessions.find(s => /^\d+-/.test(s.name) && s.name.endsWith(`-${oracle}`))?.name
    || sessions.find(s => s.name === oracle)?.name;
  if (patternMatch) return patternMatch;

  // 3. Scan fleet configs for oracle → session name mapping
  const fleetSession = resolveFleetSession(oracle);
  if (fleetSession) {
    const exists = sessions.find(s => s.name === fleetSession);
    if (exists) return fleetSession;
  }

  return null;
}

/** Set config env vars on a tmux session (hidden from screen output) */
async function setSessionEnv(session: string): Promise<void> {
  for (const [key, val] of Object.entries(getEnvVars())) {
    await ssh(`tmux set-environment -t '${session}' '${key}' '${val}'`);
  }
}

export async function cmdWake(oracle: string, opts: { task?: string; newWt?: string; prompt?: string }): Promise<string> {
  const { repoPath, repoName, parentDir } = await resolveOracle(oracle);

  // Detect or create tmux session (spawn all worktrees if new)
  let session = await detectSession(oracle);
  if (!session) {
    session = getSessionMap()[oracle] || resolveFleetSession(oracle) || oracle;
    // Create session with main window
    await ssh(`tmux new-session -d -s '${session}' -n '${oracle}' -c '${repoPath}'`);
    await setSessionEnv(session);
    await new Promise(r => setTimeout(r, 300));
    await ssh(`tmux send-keys -t '${session}:${oracle}' '${buildCommand(oracle + "-oracle")}' Enter`);
    console.log(`\x1b[32m+\x1b[0m created session '${session}' (main: ${oracle})`);

    // Spawn all existing worktree windows
    const allWt = await findWorktrees(parentDir, repoName);
    for (const wt of allWt) {
      const wtWindowName = `${oracle}-${wt.name}`;
      await ssh(`tmux new-window -t '${session}' -n '${wtWindowName}' -c '${wt.path}'`);
      await new Promise(r => setTimeout(r, 300));
      await ssh(`tmux send-keys -t '${session}:${wtWindowName}' '${buildCommand(wtWindowName)}' Enter`);
      console.log(`\x1b[32m+\x1b[0m window: ${wtWindowName}`);
    }
  } else {
    // Ensure env vars are set on existing session (may predate this fix)
    await setSessionEnv(session);
  }

  let targetPath = repoPath;
  let windowName = oracle;
  let freshWorktree = false;

  if (opts.newWt || opts.task) {
    const name = opts.newWt || opts.task!;
    const worktrees = await findWorktrees(parentDir, repoName);

    // Try to find existing worktree matching this name
    const match = worktrees.find(w => w.name.endsWith(`-${name}`) || w.name === name);

    if (match) {
      // Reuse existing worktree
      console.log(`\x1b[33m⚡\x1b[0m reusing worktree: ${match.path}`);
      targetPath = match.path;
      windowName = `${oracle}-${name}`;
    } else {
      // Create new worktree
      const nums = worktrees.map(w => parseInt(w.name) || 0);
      const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const wtName = `${nextNum}-${name}`;
      const wtPath = `${parentDir}/${repoName}.wt-${wtName}`;
      const branch = `agents/${wtName}`;

      await ssh(`git -C '${repoPath}' worktree add '${wtPath}' -b '${branch}'`);
      console.log(`\x1b[32m+\x1b[0m worktree: ${wtPath} (${branch})`);

      targetPath = wtPath;
      windowName = `${oracle}-${name}`;
      freshWorktree = true;
    }
  }

  // Check if window already exists
  try {
    const winList = await ssh(`tmux list-windows -t '${session}' -F '#{window_name}' 2>/dev/null`);
    if (winList.split("\n").some(w => w === windowName)) {
      if (opts.prompt) {
        // Window exists but we have a prompt → send claude -p
        console.log(`\x1b[33m⚡\x1b[0m '${windowName}' exists, sending prompt`);
        await ssh(`tmux select-window -t '${session}:${windowName}'`);
        const escaped = opts.prompt.replace(/'/g, "'\\''");
        const cmd = buildCommand(windowName);
        await ssh(`tmux send-keys -t '${session}:${windowName}' "${cmd.replace(/"/g, '\\"')} -p '${escaped}'" Enter`);
        return `${session}:${windowName}`;
      }
      console.log(`\x1b[33m⚡\x1b[0m '${windowName}' already running in ${session}`);
      await ssh(`tmux select-window -t '${session}:${windowName}'`);
      return `${session}:${windowName}`;
    }
  } catch { /* session might be fresh */ }

  // Create window + start command (or with prompt)
  await ssh(`tmux new-window -t '${session}' -n '${windowName}' -c '${targetPath}'`);
  await new Promise(r => setTimeout(r, 300));
  let cmd = buildCommand(windowName);
  // Fresh worktree has no conversation — drop --continue to avoid error
  if (freshWorktree) {
    cmd = cmd.replace(/\s*--continue\b/, "");
  }
  if (opts.prompt) {
    const escaped = opts.prompt.replace(/'/g, "'\\''");
    await ssh(`tmux send-keys -t '${session}:${windowName}' "${cmd.replace(/"/g, '\\"')} -p '${escaped}'" Enter`);
  } else {
    await ssh(`tmux send-keys -t '${session}:${windowName}' '${cmd}' Enter`);
  }

  console.log(`\x1b[32m✅\x1b[0m woke '${windowName}' in ${session} → ${targetPath}`);
  return `${session}:${windowName}`;
}
