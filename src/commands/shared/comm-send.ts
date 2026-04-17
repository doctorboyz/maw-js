/**
 * comm-send.ts — cmdSend + resolveOraclePane + resolveMyName.
 */

import {
  listSessions, capture, sendKeys, getPaneCommand, findPeerForTarget, resolveTarget,
  curlFetch, runHook, hostExec,
} from "../../sdk";
import { loadConfig, cfgLimit } from "../../config";
import { logMessage, emitFeed } from "./comm-log-feed";

/**
 * Resolve a `session:window` target to a specific pane running an agent
 * (claude / codex / node). Fixes the multi-pane routing bug: when an oracle
 * window has multiple panes (e.g., team-agents split beside it), tmux's
 * `send-keys -t session:window` defaults to the LAST-ACTIVE pane — which
 * becomes whichever teammate just spawned, not the oracle itself.
 *
 * Strategy: list all panes in the window, pick the lowest-index pane
 * running a claude/codex/node process. Pane 0 is conventionally the
 * oracle's main pane (created by `tmux.newWindow` during `maw wake`);
 * team-agents spawn LATER as splits and take higher indexes.
 *
 * If the target already specifies a pane (`.N` suffix) the caller knows
 * what they want — pass through untouched. If no agent pane is found,
 * return the target unchanged so the existing "no active Claude session"
 * error path surfaces correctly.
 */
/** @internal */
export async function resolveOraclePane(target: string): Promise<string> {
  // Already pane-specific — honor caller's choice.
  if (/\.[0-9]+$/.test(target)) return target;

  try {
    const raw = await hostExec(
      `tmux list-panes -t '${target}' -F '#{pane_index} #{pane_current_command}'`,
    );
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) return target; // single-pane window: active pane is the only pane

    const agentIndexes: number[] = [];
    for (const line of lines) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx < 0) continue;
      const idx = parseInt(line.slice(0, spaceIdx), 10);
      const cmd = line.slice(spaceIdx + 1);
      if (Number.isFinite(idx) && /claude|codex|node/i.test(cmd)) {
        agentIndexes.push(idx);
      }
    }
    if (agentIndexes.length === 0) return target;
    return `${target}.${Math.min(...agentIndexes)}`;
  } catch {
    return target;
  }
}

/** Resolve the current oracle name from CLAUDE_AGENT_NAME or tmux session */
/** @internal */
export function resolveMyName(config: ReturnType<typeof loadConfig>): string {
  if (process.env.CLAUDE_AGENT_NAME) return process.env.CLAUDE_AGENT_NAME;
  // Try tmux session name: "08-mawjs" → "mawjs"
  try {
    const tmuxSession = require("child_process").execSync("tmux display-message -p '#{session_name}'", { encoding: "utf-8" }).trim();
    if (tmuxSession) return tmuxSession.replace(/^\d+-/, "");
  } catch {}
  return config.node || "cli";
}

/**
 * Check if a pane is idle — i.e., no user input is in progress on the prompt line.
 * Uses capture-pane to inspect the last visible line. If a shell prompt marker
 * ($, %, >, ❯, #) is followed by non-whitespace text, the user is mid-input.
 * Errors and non-shell panes (running agent) conservatively return idle=true.
 * (#405 — idle guard before send-keys)
 */
export async function checkPaneIdle(target: string, host?: string): Promise<{ idle: boolean; lastInput: string }> {
  try {
    const content = await capture(target, 5, host);
    const lines = content.split("\n").filter(l => l.trim());
    const lastLine = lines.at(-1) ?? "";
    // Strip ANSI escape codes
    const clean = lastLine.replace(/\x1b\[[0-9;]*[mGKHFJA-Z]/g, "").replace(/\r/g, "");
    // Idle: last line ends with prompt marker + optional whitespace (nothing typed)
    if (/[#$%>❯»]\s*$/.test(clean)) return { idle: true, lastInput: "" };
    // Not idle: prompt marker followed by non-whitespace user content
    const notIdleMatch = clean.match(/[#$%>❯»]\s+(\S.*)$/);
    if (notIdleMatch) return { idle: false, lastInput: notIdleMatch[1] };
    // No prompt visible (command running or agent output) → treat as idle
    return { idle: true, lastInput: "" };
  } catch {
    return { idle: true, lastInput: "" };
  }
}

export async function cmdSend(query: string, message: string, force = false) {
  const config = loadConfig();

  // #362b — inform users when they omit the node prefix. Canonical form is
  // `<node>:<oracle>` (add `:<window>` to target a specific tmux window when
  // the session has more than one — see #410). Bare name works locally but
  // scripts should use the prefixed form for fleet portability. Silent when
  // MAW_QUIET=1.
  if (!query.includes(":") && !query.includes("/") && !process.env.MAW_QUIET && config.node) {
    console.error(`\x1b[90mℹ tip: use canonical form 'maw hey ${config.node}:${query}' for cross-node scripts — append ':<window>' to target a specific window (bare name = exact match locally; errors on ambiguity)\x1b[0m`);
  }

  // --- Plugin routing: maw hey plugin:<name> <msg> ---
  if (query.startsWith("plugin:")) {
    const name = query.slice("plugin:".length);
    const { discoverPackages, invokePlugin } = await import("../../plugin/registry");
    const plugin = discoverPackages().find(p => p.manifest.name === name);
    if (!plugin) { console.error(`plugin not found: ${name}`); process.exit(1); }
    const result = await invokePlugin(plugin, { source: "peer", args: { message, from: config.node ?? "local" } });
    if (result.ok) { console.log(result.output ?? "(no output)"); return; }
    console.error(`plugin error: ${result.error}`);
    process.exit(1);
  }

  const sessions = await listSessions();

  // --- Unified resolution via resolveTarget (#201) ---
  const result = resolveTarget(query, config, sessions);

  // Local target (or self-node) → send via tmux.
  // Resolve to a specific pane first: when the oracle window has multiple
  // panes (team-agents spawned beside it), `send-keys -t session:window`
  // would otherwise land in whichever pane is currently active, not the
  // oracle's claude pane. See resolveOraclePane.
  if (result?.type === "local" || result?.type === "self-node") {
    const target = await resolveOraclePane(result.target);
    if (!force) {
      const cmd = await getPaneCommand(target);
      const isAgent = /claude|codex|node/i.test(cmd);
      if (!isAgent) {
        console.error(`\x1b[31merror\x1b[0m: no active Claude session in ${target} (running: ${cmd})`);
        console.error(`\x1b[33mhint\x1b[0m:  run \x1b[36mmaw wake ${query}\x1b[0m first, or use \x1b[36m--force\x1b[0m to send anyway`);
        process.exit(1);
      }
      // #405: idle guard — abort if user has in-progress input on the prompt line
      let idleCheck = await checkPaneIdle(target);
      if (!idleCheck.idle) {
        await Bun.sleep(500);
        idleCheck = await checkPaneIdle(target);
        if (!idleCheck.idle) {
          console.error(`\x1b[31merror\x1b[0m: pane ${target} is not idle — user appears to be typing: "${idleCheck.lastInput.slice(0, 60)}"`);
          console.error(`\x1b[33mhint\x1b[0m:  use \x1b[36m--force\x1b[0m to send anyway`);
          process.exit(1);
        }
      }
    }
    await sendKeys(target, message);
    await runHook("after_send", { to: query, message });
    if (!config.node) throw new Error("config.node is required — set 'node' in maw.config.json");
    const senderName = resolveMyName(config);
    logMessage(senderName, query, message, "local");
    emitFeed("MessageSend", senderName, config.node, `${query}: ${message.slice(0, 200)}`, config.port || 3456);
    await Bun.sleep(150);
    let lastLine = "";
    try { const content = await capture(target, 3); lastLine = content.split("\n").filter(l => l.trim()).pop() || ""; } catch {}
    console.log(`\x1b[32mdelivered\x1b[0m → ${target}: ${message}`);
    if (lastLine) console.log(`\x1b[90m  ⤷ ${lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
    return;
  }

  // Remote peer → federation HTTP
  if (result?.type === "peer") {
    const res = await curlFetch(`${result.peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target: result.target, text: message }),
    });
    if (res.ok && res.data?.ok) {
      const agentName = resolveMyName(config);
      logMessage(agentName, query, message, `peer:${result.node}`);
      emitFeed("MessageSend", agentName, config.node!, `${result.node}:${query}: ${message.slice(0, 200)}`, config.port || 3456);
      console.log(`\x1b[32mdelivered\x1b[0m ⚡ ${result.node} → ${res.data.target || result.target}: ${message}`);
      if (res.data.lastLine) console.log(`\x1b[90m  ⤷ ${res.data.lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
      await runHook("after_send", { to: query, message });
      return;
    }
    console.error(`\x1b[31mfailed\x1b[0m ⚡ ${result.node} → ${result.target}: ${res.data?.error || "send failed"}`);
    process.exit(1);
  }

  // Fallback: async peer discovery (network scan — slow path)
  const peerUrl = await findPeerForTarget(query, sessions);
  if (peerUrl) {
    const res = await curlFetch(`${peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target: query, text: message }),
    });
    if (res.ok && res.data?.ok) {
      console.log(`\x1b[32mdelivered\x1b[0m ⚡ ${peerUrl} → ${res.data.target || query}: ${message}`);
      if (res.data.lastLine) console.log(`\x1b[90m  ⤷ ${res.data.lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
      await runHook("after_send", { to: query, message });
      return;
    }
  }

  // Not found — surface error details from resolveTarget (#216)
  if (result?.type === "error") {
    console.error(`\x1b[31merror\x1b[0m: ${result.detail}`);
    if (result.hint) console.error(`\x1b[33mhint\x1b[0m:  ${result.hint}`);
  } else {
    console.error(`\x1b[31merror\x1b[0m: window not found: ${query}`);
    if (config.agents && Object.keys(config.agents).length > 0) {
      console.error(`\x1b[33mhint\x1b[0m:  known agents: ${Object.keys(config.agents).join(", ")}`);
    }
  }
  process.exit(1);
}
