import { join } from "path";
import { readdirSync } from "fs";
import { tmux } from "../tmux";
import { FLEET_DIR } from "../paths";

export interface FleetWindow {
  name: string;
  repo: string;
}

export interface FleetSession {
  name: string;
  windows: FleetWindow[];
  skip_command?: boolean;
  /** Parent oracle name (e.g. "pulse"). Child syncs ψ/ to parent on done. */
  parent?: string;
  /** Child oracle names. Parent can pull ψ/ from all children. */
  children?: string[];
}

export interface FleetEntry {
  file: string;
  num: number;
  groupName: string;
  session: FleetSession;
}

export function loadFleet(): FleetSession[] {
  const files = readdirSync(FLEET_DIR)
    .filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))
    .sort();
  return files.map(f => require(join(FLEET_DIR, f)) as FleetSession);
}

export function loadFleetEntries(): FleetEntry[] {
  const files = readdirSync(FLEET_DIR)
    .filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))
    .sort();
  return files.map(f => {
    const raw = require(join(FLEET_DIR, f));
    const match = f.match(/^(\d+)-(.+)\.json$/);
    return {
      file: f,
      num: match ? parseInt(match[1], 10) : 0,
      groupName: match ? match[2] : f.replace(".json", ""),
      session: raw as FleetSession,
    };
  });
}

export async function getSessionNames(): Promise<string[]> {
  try {
    const out = await tmux.run("list-sessions", "-F", "#{session_name}");
    return out.trim().split("\n").filter(Boolean);
  } catch { return []; }
}
