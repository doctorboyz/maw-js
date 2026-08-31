import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdTell, parseTellArgs } from "./impl";

export const command = {
  name: "tell",
  description: "Send text + Enter, verify it landed.",
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
      opts = parseTellArgs(ctx.args as string[]);
    } else {
      const a = ctx.args as Record<string, unknown>;
      opts = { target: (a.target as string) ?? "", text: (a.text as string) ?? "" };
    }
    await cmdTell(opts);
    return { ok: process.exitCode !== 1, exitCode: 1 };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err), logs };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}