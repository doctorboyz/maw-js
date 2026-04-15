/**
 * Trigger Engine — Config-driven workflow triggers.
 *
 * Fires shell commands in response to events (issue-close, pr-merge, agent-idle, etc.).
 * Actions support template variables: {agent}, {repo}, {issue}, {event}.
 */

// No execSync — use async Bun.spawn to avoid blocking event loop
import { loadConfig, saveConfig, type TriggerConfig, type TriggerEvent } from "../../config";
import { logAudit } from "../fleet/audit";

export interface TriggerContext {
  agent?: string;
  repo?: string;
  issue?: string;
  [key: string]: string | undefined;
}

export interface TriggerFireResult {
  trigger: TriggerConfig;
  action: string;
  ok: boolean;
  output?: string;
  error?: string;
  ts: number;
}

/** Last-fired timestamp per trigger (index in config array → result) */
const lastFired = new Map<number, TriggerFireResult>();

/** Idle tracking: agent → last activity timestamp (ms) */
const idleTimers = new Map<string, number>();

/** Track busy→idle transition: only fire agent-idle when agent WAS busy (#149) */
const agentPrevState = new Map<string, "busy" | "idle">();

/**
 * Expand template variables in an action string.
 * Supports {agent}, {repo}, {issue}, {event}, and any key in context.
 */
function expandAction(action: string, event: TriggerEvent, ctx: TriggerContext): string {
  let result = action;
  result = result.replace(/\{event\}/g, event);
  for (const [key, value] of Object.entries(ctx)) {
    if (value !== undefined) {
      result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
    }
  }
  return result;
}

/**
 * Get all configured triggers.
 */
export function getTriggers(): TriggerConfig[] {
  return loadConfig().triggers || [];
}

/**
 * Get trigger history (last-fired results).
 */
export function getTriggerHistory(): { index: number; result: TriggerFireResult }[] {
  return [...lastFired.entries()]
    .map(([index, result]) => ({ index, result }))
    .sort((a, b) => b.result.ts - a.result.ts);
}

/**
 * Fire all triggers matching an event type.
 * Filters by repo if the trigger has a repo constraint.
 * Returns array of results for each trigger fired.
 */
export async function fire(event: TriggerEvent, ctx: TriggerContext = {}): Promise<TriggerFireResult[]> {
  const triggers = getTriggers();
  const results: TriggerFireResult[] = [];

  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i];
    if (t.on !== event) continue;

    // Repo filter: skip if trigger specifies repo and it doesn't match
    if (t.repo && ctx.repo && t.repo !== ctx.repo) continue;

    // Idle timeout check: skip if agent hasn't been idle long enough
    if (event === "agent-idle" && t.timeout && ctx.agent) {
      const lastActivity = idleTimers.get(ctx.agent);
      if (lastActivity) {
        const idleSec = (Date.now() - lastActivity) / 1000;
        if (idleSec < t.timeout) continue;
      }
    }

    const action = expandAction(t.action, event, ctx);
    const result: TriggerFireResult = { trigger: t, action, ok: false, ts: Date.now() };

    try {
      const proc = Bun.spawn(["bash", "-c", action], { stdout: "pipe", stderr: "pipe", env: { ...process.env }, windowsHide: true });
      const output = (await new Response(proc.stdout).text()).trim();
      const code = await proc.exited;
      if (code !== 0) throw new Error(`exit ${code}`);
      result.ok = true;
      result.output = output;
    } catch (err: any) {
      result.error = err.message?.slice(0, 200) || "unknown error";
    }

    lastFired.set(i, result);
    results.push(result);

    // Audit log
    logAudit("trigger:fire", [event, t.action, result.ok ? "ok" : "error"], result.ok ? "ok" : result.error);

    // One-time triggers: remove after successful fire (#149)
    if (t.once && result.ok) {
      const config = loadConfig();
      const updated = (config.triggers || []).filter((_: TriggerConfig, idx: number) => idx !== i);
      saveConfig({ triggers: updated });
      console.log(`\x1b[33m[trigger]\x1b[0m one-time trigger fired and removed: ${t.name || t.action.slice(0, 40)}`);
    }
  }

  return results;
}

// --- Cron trigger support (#209 PR γ) ---
//
// "cron" is a TriggerEvent that fires on a crontab schedule. This module
// ships the WIRING only: the TriggerEvent union admits "cron", `fire("cron")`
// dispatches configured cron triggers, and `wouldFireAt()` parses a crontab
// expression for dry-run inspection. It does NOT run a daemon — external
// scheduling (system cron, systemd timer, a future maw-cron process) must
// invoke `fire("cron")` at trigger times.

/**
 * Parse a single crontab field ("minute" / "hour" / etc.) into a Set of
 * matching values. Supports `*`, number, list (`1,3,5`), range (`1-5`),
 * step (e.g. star-slash-2 or `1-5/2`). Throws on out-of-range or malformed input.
 */
function parseCronField(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    let step = 1;
    let body = part;
    const slashIdx = part.indexOf("/");
    if (slashIdx >= 0) {
      step = parseInt(part.slice(slashIdx + 1), 10);
      body = part.slice(0, slashIdx);
      if (!Number.isFinite(step) || step < 1) {
        throw new Error(`invalid step in cron field "${expr}"`);
      }
    }
    let start: number, end: number;
    if (body === "*") {
      start = min; end = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-").map((n) => parseInt(n, 10));
      start = a; end = b;
    } else {
      const n = parseInt(body, 10);
      start = n; end = n;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < min || end > max || start > end) {
      throw new Error(`invalid range "${body}" in cron field "${expr}" (expected ${min}-${max})`);
    }
    for (let i = start; i <= end; i += step) out.add(i);
  }
  return out;
}

/**
 * Compute the next moment a 5-field crontab expression would fire after `now`.
 *
 * Returns a Date strictly greater than `now` (the same minute never matches),
 * or `null` if no match within ~1 year (malformed / impossible schedule).
 * This is a DRY-RUN helper — it does not schedule or execute anything.
 *
 * Supports the standard 5-field form: `minute hour day-of-month month day-of-week`
 * with `*`, numbers, lists, ranges, and steps. Day-of-week uses 0=Sunday…6=Saturday.
 * Does NOT support macros (@daily, @hourly) or 6-field form with seconds.
 */
export function wouldFireAt(cronExpr: string, now: Date = new Date()): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${parts.length}: "${cronExpr}"`);
  }
  const [mF, hF, domF, monF, dowF] = parts;
  const minutes = parseCronField(mF, 0, 59);
  const hours = parseCronField(hF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const months = parseCronField(monF, 1, 12);
  const dows = parseCronField(dowF, 0, 6);

  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `now`

  const maxIter = 366 * 24 * 60; // worst case: scan a full year minute-by-minute
  for (let i = 0; i < maxIter; i++) {
    const mon = d.getMonth() + 1;
    if (!months.has(mon)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const dom = d.getDate();
    const dow = d.getDay();
    if (!doms.has(dom) || !dows.has(dow)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (minutes.has(d.getMinutes())) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/**
 * Update idle tracking for an agent.
 * Call this on every agent activity to reset the idle timer.
 */
export function markAgentActive(agent: string): void {
  idleTimers.set(agent, Date.now());
  agentPrevState.set(agent, "busy"); // Track transition for busy→idle detection (#149)
}

/**
 * Check all agents for idle timeout and fire triggers.
 * Returns agents that triggered.
 */
export async function checkIdleTriggers(): Promise<string[]> {
  const triggers = getTriggers().filter(t => t.on === "agent-idle");
  if (!triggers.length) return [];

  const fired: string[] = [];
  for (const [agent, lastActive] of idleTimers) {
    // Only fire if agent transitioned from busy→idle (#149)
    const prevState = agentPrevState.get(agent);
    if (prevState !== "busy") continue;

    const idleSec = (Date.now() - lastActive) / 1000;
    for (const t of triggers) {
      if (t.timeout && idleSec >= t.timeout) {
        const results = await fire("agent-idle", { agent });
        if (results.some(r => r.ok)) {
          fired.push(agent);
          agentPrevState.set(agent, "idle");
          idleTimers.delete(agent);
        }
      }
    }
  }
  return fired;
}
