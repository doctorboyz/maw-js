import { listSessions, ssh } from "../ssh";
import { tmux } from "../tmux";
import { buildCommandInDir } from "../config";

/**
 * maw take <source-session>:<window> [target-session]
 *
 * Vesicle transport — move a tmux window from one oracle session to another.
 * If target-session is omitted, uses the current tmux session.
 *
 * The window's worktree/cwd stays the same. Only the tmux home changes.
 */
export async function cmdTake(source: string, targetSession?: string) {
  // Parse source — "neo:skills-cli" or "neo:3"
  const [srcSession, srcWindow] = source.includes(":") ? source.split(":", 2) : [source, ""];

  if (!srcWindow) {
    console.error("usage: maw take <session>:<window> [target-session]");
    console.error("  e.g. maw take neo:neo-skills pulse");
    process.exit(1);
  }

  // Resolve target session (default = current tmux session)
  let target = targetSession;
  if (!target) {
    try {
      target = (await ssh("tmux display-message -p '#{session_name}'")).trim();
    } catch {
      console.error("  \x1b[31m✗\x1b[0m could not detect current tmux session");
      process.exit(1);
    }
  }

  if (target === srcSession) {
    console.log("  \x1b[33m⚠\x1b[0m source and target are the same session");
    return;
  }

  // Verify source window exists
  const sessions = await listSessions();
  const srcSess = sessions.find(s => s.name.toLowerCase() === srcSession.toLowerCase());
  if (!srcSess) {
    console.error(`  \x1b[31m✗\x1b[0m session '${srcSession}' not found`);
    process.exit(1);
  }

  const srcWin = srcSess.windows.find(w =>
    w.name.toLowerCase() === srcWindow.toLowerCase() || String(w.index) === srcWindow
  );
  if (!srcWin) {
    console.error(`  \x1b[31m✗\x1b[0m window '${srcWindow}' not found in session '${srcSession}'`);
    process.exit(1);
  }

  // Get the window's cwd before moving
  let paneCwd = "";
  try {
    paneCwd = (await ssh(`tmux display-message -t '${srcSess.name}:${srcWin.name}' -p '#{pane_current_path}'`)).trim();
  } catch { /* ok */ }

  // Move the window: tmux move-window -s source:window -t target:
  try {
    await ssh(`tmux move-window -s '${srcSess.name}:${srcWin.name}' -t '${target}:'`);
    console.log(`  \x1b[32m✓\x1b[0m ${srcSess.name}:${srcWin.name} → ${target}`);
    if (paneCwd) {
      console.log(`  \x1b[90m  cwd: ${paneCwd}\x1b[0m`);
    }
  } catch (e: any) {
    console.error(`  \x1b[31m✗\x1b[0m move failed: ${e.message || e}`);
    process.exit(1);
  }
}
