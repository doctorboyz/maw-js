import { loadConfig } from "./config-load";

/** Simple glob match: supports * at start/end (e.g., "*-oracle", "codex-*") */
function matchGlob(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

/** Build the full command string for an agent (no env vars — use setSessionEnv) */
export function buildCommand(agentName: string): string {
  const config = loadConfig();
  let cmd = config.commands.default || "claude";

  // Strip --dangerously-skip-permissions when running as root (#181)
  if (process.getuid?.() === 0) {
    cmd = cmd.replace(/\s*--dangerously-skip-permissions\b/, "");
  }

  // Match specific patterns first (skip "default")
  for (const [pattern, command] of Object.entries(config.commands)) {
    if (pattern === "default") continue;
    if (matchGlob(pattern, agentName)) { cmd = command; break; }
  }

  // Inject --session-id if configured for this agent
  const sessionIds: Record<string, string> = (config as any).sessionIds || {};
  const sessionId = sessionIds[agentName]
    || Object.entries(sessionIds).find(([p]) => p !== "default" && matchGlob(p, agentName))?.[1];
  if (sessionId) {
    // Use --resume with fixed session ID (--session-id locks, --resume doesn't)
    // Replace --continue with --resume <uuid> if present, otherwise append
    if (cmd.includes("--continue")) {
      cmd = cmd.replace(/\s*--continue\b/, ` --resume "${sessionId}"`);
    } else {
      cmd += ` --resume "${sessionId}"`;
    }
  }

  // Prefix: load direnv + clear stale CLAUDECODE.
  // direnv allow + export ensures .envrc env vars load before Claude starts,
  // since tmux send-keys can race with the shell's direnv hook.
  // If direnv is not installed, `direnv allow` fails visibly (diagnostic),
  // && short-circuits, and the rest of the block runs normally.
  // unset CLAUDECODE prevents "cannot be launched inside another" from crashed sessions.
  const prefix = "direnv allow . && eval \"$(direnv export zsh)\"; unset CLAUDECODE;";

  // If command uses --continue or --resume, add shell fallback without it.
  // --continue errors when no prior conversation exists (e.g. fresh worktree,
  // wiped session). --resume errors when session ID doesn't exist yet.
  // The fallback retries the same command minus --continue/--resume,
  // but keeps --session-id if present so the first run creates the session with that ID.
  if (cmd.includes("--continue") || cmd.includes("--resume")) {
    let fallback = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+"[^"]*"/, "");
    if (sessionId) fallback += ` --session-id "${sessionId}"`;
    return `${prefix} ${cmd} || ${prefix} ${fallback}`;
  }

  return `${prefix} ${cmd}`;
}

/** Wrap buildCommand with cd to ensure correct working directory after reboot.
 *  Parenthesize buildCommand so cd applies to both primary + fallback in `cmd || fallback`.
 *  Otherwise shell precedence (`&&` tighter than `||`) makes the fallback run without cd. */
export function buildCommandInDir(agentName: string, cwd: string): string {
  return `cd '${cwd}' && { ${buildCommand(agentName)}; }`;
}

/** Get env vars from config (for tmux set-environment) */
export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
