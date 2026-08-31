/**
 * ask — send a task to an agent pane and WAIT for it to finish.
 *
 * Solves the real pain from 2026-08-31: dispatching via `maw send-text`
 * then having to poll `maw peek` + `sleep 75` in a loop by hand. `ask`
 * does send → poll-until-idle → capture in one command.
 *
 * "Idle" detection for Claude Code panes:
 *   - bottom line contains the prompt border (────) followed by an empty
 *     input box, AND
 *   - no spinner glyphs (✳ ✻ ⏺-running) on recent lines, AND
 *   - that state holds for 2 consecutive polls (stability window).
 *
 * Fails safe: on timeout, prints the tail anyway + exit code 2 so callers
 * know the agent is still working (NOT a hard error — the work continues).
 *
 *   maw ask <target> "<text>" [--timeout <sec>] [--lines <n>] [--interval <ms>]
 */
import { listSessions, resolveTarget, capture, Tmux, curlFetch } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { resolveOraclePane } from "maw-js/commands/shared/comm-send";

export interface AskOpts {
  target: string;
  text: string;
  timeoutSec: number;
  lines: number;
  intervalMs: number;
}

/**
 * Screen anatomy (verified via live capture 2026-08-31):
 *   ...history: "❯ old prompt text…"   ← typed text after ❯ = HISTORY, skip
 *   [n-3] "✻ Sautéed for 3s"           ← done-marker (past tense) = NOT busy
 *   [n-2] ""
 *   [n-1] "──── border"
 *   [n]   "❯ "                          ← THE live input: empty = idle
 *   [n+1] "──── border"
 *   [n+2] "  ⏵⏵ bypass permissions on…"
 *
 * Busy screen instead shows a live spinner line ABOVE the empty input:
 *   "✳ Spelunking… (5s · ↓ 76 tokens · thinking)"
 * Busy patterns: ✳ glyph, "(5s" parens-seconds, "Esc to interrupt".
 * Done-markers (✻ Baked/Cogitated/Sautéed … "for 3s", no parens) must NOT
 * count as busy — they linger in history forever.
 * All checks strip ANSI escapes first (screens are full of \u001b[…m).
 */
const BUSY = /✳|Esc to interrupt|\(\d+s|Cooking|Spelunking|Cogitating|Churning|Working/;

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** Heuristic: bottom-most EMPTY "❯" input line + no live spinner above it. */
function isIdle(screen: string): boolean {
  const lines = screen.split("\n").map(stripAnsi);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    const l = lines[i];
    if (!l.includes("❯")) continue;
    const after = l.split("❯")[1] ?? "";
    if (after.trim().length !== 0) continue; // typed text = history prompt, keep climbing
    // Found the live empty input. Check the 3 lines above for a live spinner.
    const above = lines.slice(Math.max(0, i - 3), i).join(" ");
    return !BUSY.test(above);
  }
  return false;
}

export async function cmdAsk(opts: AskOpts): Promise<void> {
  const { target: query, text } = opts;
  if (!query || !text) throw new Error('usage: maw ask <target> "<text>"');

  const config = loadConfig();
  const sessions = await listSessions();
  const result = resolveTarget(query, config, sessions);
  if (!result) throw new Error(`could not resolve target: ${query}`);
  if (result.type === "error") throw new Error(result.detail);

  if (result.type === "peer") {
    // Cross-node: send via federation, then poll capture via same route.
    const send = await curlFetch(`${result.peerUrl}/api/pane-keys`, {
      method: "POST",
      body: JSON.stringify({ target: result.target, text, enter: true }),
      from: "auto",
    });
    if (!send.ok || !send.data?.ok) throw new Error(`peer send failed (${result.node})`);
    console.log(`sent ⚡ ${result.node} → ${result.target}, waiting…`);
  } else {
    const target = await resolveOraclePane(result.target);
    const t = new Tmux();
    await t.sendText(target, text);
    console.log(`sent → ${target}, waiting…`);
  }

  const targetStr = result.type === "peer" ? result.target : await resolveOraclePane(result.target);
  const deadline = Date.now() + opts.timeoutSec * 1000;
  let stableIdle = 0;
  let lastScreen = "";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.intervalMs));
    try {
      const screen = await capture(targetStr, 80); // last 80 lines
      if (typeof screen === "string") lastScreen = screen;
      if (isIdle(lastScreen)) {
        stableIdle++;
        if (stableIdle >= 2) break; // idle across 2 polls = really done
      } else {
        stableIdle = 0;
      }
    } catch {
      // pane disappeared mid-work — surface what we have
      break;
    }
  }

  const timedOut = Date.now() >= deadline;
  const tail = lastScreen.split("\n").slice(-opts.lines).join("\n");
  console.log(`\n──────────────── captured (${opts.lines} lines) ────────────────`);
  console.log(tail);
  console.log(`────────────────────────────────────────────────────────────`);
  if (timedOut) {
    console.log(`⏳ still working after ${opts.timeoutSec}s — work continues, re-run maw peek later`);
    process.exitCode = 2;
  } else {
    console.log(`✅ agent idle — task complete`);
  }
}

export function parseAskArgs(args: string[]): AskOpts {
  const opts: AskOpts = { target: "", text: "", timeoutSec: 600, lines: 60, intervalMs: 5000 };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--timeout" || a === "-t") { opts.timeoutSec = parseInt(args[++i], 10) || 600; continue; }
    if (a === "--lines" || a === "-n") { opts.lines = parseInt(args[++i], 10) || 60; continue; }
    if (a === "--interval" || a === "-i") { opts.intervalMs = parseInt(args[++i], 10) || 5000; continue; }
    rest.push(a);
  }
  const targetIdx = rest.findIndex((a) => !a.startsWith("-"));
  if (targetIdx < 0) throw new Error('usage: maw ask <target> "<text>"');
  opts.target = rest[targetIdx];
  opts.text = rest.slice(targetIdx + 1).join(" ");
  if (!opts.text) throw new Error('usage: maw ask <target> "<text>" — text is required');
  return opts;
}