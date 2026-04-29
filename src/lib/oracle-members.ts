/**
 * oracle-members.ts — vendored team registry helpers (Phase 2 vendor, #918 follow-up).
 *
 * Mirrors `src/commands/plugins/team/oracle-members.ts` so that
 * `src/commands/shared/comm-send.ts` (and any other src/core / src/api /
 * src/lib consumer) can resolve `team:<name>` fan-out without reaching across
 * the plugin boundary into the team plugin.
 *
 * After the follow-up "prune" PR removes the team plugin's source, this
 * vendored copy is the canonical location for the registry-read logic.
 *
 * Stores team membership at `<CONFIG_DIR>/teams/<team-name>/oracle-members.json`.
 * Forgiving load semantics — missing file or corrupt JSON returns `null`,
 * never throws. The ACL and routing layers treat "no registry" as "no members".
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../core/paths";

export interface OracleMember {
  /** Oracle name (e.g. "mawjs-plugin-oracle", "security-oracle") */
  oracle: string;
  /** Role within the team (e.g. "researcher", "builder", "reviewer") */
  role: string;
  /** ISO timestamp when the oracle was added */
  addedAt: string;
}

export interface OracleTeamRegistry {
  name: string;
  members: OracleMember[];
  createdAt: string;
  /**
   * When true (default), `maw hey team:<name>` fan-out skips the sending
   * oracle so a broadcast does not re-inject into the sender's own pane.
   */
  excludeSelf?: boolean;
}

function teamRegistryDir(teamName: string): string {
  return join(CONFIG_DIR, "teams", teamName);
}

function teamRegistryPath(teamName: string): string {
  return join(teamRegistryDir(teamName), "oracle-members.json");
}

export function loadOracleRegistry(teamName: string): OracleTeamRegistry | null {
  const path = teamRegistryPath(teamName);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Pure helper: filter member oracle names against the sender, honoring the
 * registry's `excludeSelf` flag (default true).
 */
export function filterMembers(
  members: OracleMember[],
  excludeSelf: boolean | undefined,
  currentOracle?: string,
): string[] {
  const all = members.map(m => m.oracle);
  if (excludeSelf !== false && currentOracle) {
    return all.filter(o => o !== currentOracle);
  }
  return all;
}

/**
 * Get oracle member names for a team (for routing fan-out).
 *
 * When `currentOracle` is provided and the registry's `excludeSelf` flag is
 * not explicitly false, the sending oracle is filtered out so a team
 * broadcast does not re-inject into its own pane.
 */
export function getOracleMembers(teamName: string, currentOracle?: string): string[] {
  const registry = loadOracleRegistry(teamName);
  if (!registry) return [];
  return filterMembers(registry.members, registry.excludeSelf, currentOracle);
}
