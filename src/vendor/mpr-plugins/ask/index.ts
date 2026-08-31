import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdAsk, parseAskArgs } from "./impl";

export const command = {
  name: "ask",
  description: "Send a task, wait for idle, capture result.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => { if (ctx.writer) ctx.writer(...a); else logs.push(a.map(String).join(" ")); };
  console.error = (...a: any[]) => { if (ctx.writer) ctx.writer(...a); else logs.push(a.map(String).join(" ")); };

  try {
    let opts;
    if (ctx.source === "cli") {
      opts = parseAskArgs(ctx.args as string[]);
    } else {
      const a = ctx.args as Record<string, unknown>;
      opts = {
        target: (a.target as string) ?? "",
        text: (a.text as string) ?? "",
        timeoutSec: (a.timeoutSec as number) ?? 600,
        lines: (a.lines as number) ?? 60,
        intervalMs: (a.intervalMs as number) ?? 5000,
      };
    }
    await cmdAsk(opts);
    return { ok: process.exitCode !== 2, exitCode: process.exitCode || undefined };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err), logs };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}