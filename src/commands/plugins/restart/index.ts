import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdRestart } from "./impl";

export const command = {
  name: "restart",
  description: "Restart the maw server with optional update.",
};

const HELP_TEXT = [
  "usage: maw restart [--no-update] [--ref <git-ref>]",
  "",
  "  Restart the whole maw fleet:",
  "    1. kill stale *-view sessions",
  "    2. update maw-js (unless --no-update)",
  "    3. stop fleet (maw stop)",
  "    4. wake fleet (maw wake all)",
  "",
  "  Flags:",
  "    --no-update   skip the git pull + rebuild step",
  "    --ref <ref>   update to a specific ref (branch/tag/sha) instead of default",
  "    --help, -h    show this message and exit (no side effects)",
].join("\n");

/**
 * Extract args from either calling convention:
 *   OLD (plugin/registry.ts): handler({ source: "cli", args: [...] })
 *   NEW (cli/command-registry.ts): handler(positional: string[], flags: object)
 * Both dispatchers are live; we must support both until unified.
 */
function extractArgs(ctx: any): string[] {
  if (Array.isArray(ctx)) return ctx;                        // NEW dispatcher
  if (ctx?.source === "cli" && Array.isArray(ctx.args)) return ctx.args; // OLD
  return [];
}

export default async function handler(ctx: any, _flags?: any): Promise<InvokeResult | void> {
  const args = extractArgs(ctx);

  // #349 — --help MUST short-circuit BEFORE any side effects. This plugin
  // performs destructive fleet operations; silent flag-fallthrough on --help
  // would kill sessions + restart fleet when the user just wanted docs.
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    return { ok: true, output: HELP_TEXT };
  }

  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    const noUpdate = args.includes("--no-update");
    const refIdx = args.indexOf("--ref");
    const ref = refIdx >= 0 ? args[refIdx + 1] : undefined;
    await cmdRestart({ noUpdate, ref });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
