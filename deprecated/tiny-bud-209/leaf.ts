/**
 * Tiny-bud leaf helpers — PR β of #209.
 *
 * Registers a tiny bud as a LEAF entry in the oracle registry
 * (~/.config/maw/oracles.json, schema 1 from #208) and optionally
 * appends a cron TriggerConfig entry to maw.config.json.
 *
 * Leaves are stored under a top-level `leaves` array to avoid collision
 * with the `oracles` array that scanLocal() rewrites on every scan. This
 * also means subsequent `maw oracle scan` runs will lose leaf entries
 * unless scanAndCache is taught to preserve them — noted gap for PR γ.
 *
 * The "cron" TriggerEvent is not yet in the dispatcher (TriggerEvent
 * union is issue-close/pr-merge/agent-* only; see src/core/runtime/
 * triggers.ts). This helper writes the config; PR γ wires the dispatcher.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface LeafEntry {
  org: string;
  parent_repo: string;
  name: string;
  kind: "tiny";
  parent: string;
  path: string;
  budded_at: string;
  presence: ("local")[];
}

interface RegistryFile {
  schema: 1;
  local_scanned_at?: string;
  ghq_root?: string;
  oracles?: unknown[];
  leaves?: LeafEntry[];
}

export interface RegisterLeafOpts {
  name: string;
  parent: string;
  org: string;
  parentRepo: string;
  path: string;
  buddedAt: string;
  registryPath: string;
}

export interface RegisterLeafResult {
  parentFound: boolean;
  leafAdded: boolean;
}

export function registerTinyLeaf(opts: RegisterLeafOpts): RegisterLeafResult {
  const { registryPath } = opts;
  mkdirSync(dirname(registryPath), { recursive: true });

  let cache: RegistryFile;
  if (existsSync(registryPath)) {
    try {
      cache = JSON.parse(readFileSync(registryPath, "utf-8"));
    } catch { cache = { schema: 1 }; }
  } else {
    cache = { schema: 1 };
  }

  const oracles = Array.isArray(cache.oracles) ? cache.oracles : [];
  const parentFound = oracles.some(
    (o: any) => o && typeof o === "object" && o.name === opts.parent,
  );

  const leaves: LeafEntry[] = Array.isArray(cache.leaves) ? cache.leaves : [];
  const idx = leaves.findIndex(
    (l) => l.name === opts.name && l.parent === opts.parent,
  );
  const entry: LeafEntry = {
    org: opts.org,
    parent_repo: opts.parentRepo,
    name: opts.name,
    kind: "tiny",
    parent: opts.parent,
    path: opts.path,
    budded_at: opts.buddedAt,
    presence: ["local"],
  };
  if (idx >= 0) leaves[idx] = entry;
  else leaves.push(entry);

  const next: RegistryFile = { ...cache, schema: 1, leaves };
  writeFileSync(registryPath, JSON.stringify(next, null, 2) + "\n", "utf-8");

  return { parentFound, leafAdded: true };
}

// --- Cron trigger extension ---

interface CronTrigger {
  on: "cron";
  schedule: string;
  action: string;
  name?: string;
}

export interface AddCronOpts {
  name: string;
  schedule: string;
  parent: string;
  configPath: string;
}

export function addCronTrigger(opts: AddCronOpts): void {
  const { configPath } = opts;
  mkdirSync(dirname(configPath), { recursive: true });

  let cfg: Record<string, unknown>;
  if (existsSync(configPath)) {
    try { cfg = JSON.parse(readFileSync(configPath, "utf-8")); }
    catch { cfg = {}; }
  } else {
    cfg = {};
  }

  const triggers: CronTrigger[] = Array.isArray(cfg.triggers)
    ? (cfg.triggers as CronTrigger[])
    : [];

  const triggerName = `tiny-${opts.parent}-${opts.name}`;
  const entry: CronTrigger = {
    on: "cron",
    schedule: opts.schedule,
    action: `maw bud-run ${opts.name} --parent ${opts.parent}`,
    name: triggerName,
  };

  const idx = triggers.findIndex((t) => t && (t as any).name === triggerName);
  if (idx >= 0) triggers[idx] = entry;
  else triggers.push(entry);

  cfg.triggers = triggers;
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}
