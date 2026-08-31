/**
 * tell — send text + Enter, then VERIFY it landed by re-capturing the pane.
 *
 * Real incident 2026-08-31: `maw send-text infra "/clear"` sent → screen never
 * moved. Either the pane was wrong, or the input was swallowed. Cost: two
 * retries + 3 minutes of confusion. `tell` re-captures the pane right after
 * sending and fails loudly when the text is NOT visible in the input box or
 * recent output — so the caller knows immediately instead of finding out
 * 90 seconds later.
 *
 * Verification (heuristic, generous):
 *   after sendKeys, capture pane and look for either
 *   (a) the text (or its first 40 chars, if long) anywhere in the last 15
 *       lines — covers: text sitting in input box, echoed in output, or the
 *       claude TUI showing the just-submitted prompt; or
 *   (b) the pane's bottom prompt border moved/empty input (fresh render).
 * (a) alone is the pass condition. Fail → exit 1 with the pane tail so the
 * human/agent can see what's actually on screen.
 *
 *   maw tell <target> "<text>"
 */
import { listSessions, resolveTarget, capture, Tmux } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { resolveOraclePane } from "maw-js/commands/shared/comm-send";

export interface TellOpts {
  target: string;
  text: string;
}

export async function cmdTell(opts: TellOpts): Promise<void> {
  const { target: query, text } = opts;
  if (!query || !text) throw new Error('usage: maw tell <target> "<text>"');

  const config = loadConfig();
  const sessions = await listSessions();
  const result = resolveTarget(query, config, sessions);
  if (!result) throw new Error(`could not resolve target: ${query}`);
  if (result.type === "error") {
    const hint = result.hint ? ` — ${result.hint}` : "";
    throw new Error(`${result.detail}${hint}`);
  }
  if (result.type === "peer") {
    // No cheap verify across nodes — fall back to plain send semantics.
    throw new Error("tell: cross-node targets not supported yet — use maw send-text for peers");
  }

  const target = await resolveOraclePane(result.target);
  const t = new Tmux();
  await t.sendText(target, text);

  // give the TUI a beat to render the submitted input
  await new Promise((r) => setTimeout(r, 1200));

  let screen = "";
  try {
    screen = await capture(target, 15);
  } catch { /* capture failed — can't verify */ }
  if (typeof screen !== "string") screen = "";

  const needle = text.replace(/\s+/g, " ").trim().slice(0, 40);
  const hay = screen.replace(/\s+/g, " ");
  if (needle && hay.includes(needle)) {
    console.log(`✓ verified → ${target}: landed (${truncate(text)})`);
    return;
  }
  console.error(`✗ NOT verified → ${target} — pane tail:`);
  console.error(screen.split("\n").slice(-10).join("\n"));
  process.exitCode = 1;
}

function truncate(s: string, n = 60): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

export function parseTellArgs(args: string[]): TellOpts {
  const targetIdx = args.findIndex((a) => !a.startsWith("-"));
  if (targetIdx < 0) throw new Error('usage: maw tell <target> "<text>"');
  const target = args[targetIdx];
  const text = args.slice(targetIdx + 1).join(" ");
  if (!text) throw new Error('usage: maw tell <target> "<text>" — text is required');
  return { target, text };
}