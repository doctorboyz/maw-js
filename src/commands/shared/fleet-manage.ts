import { join } from "path";
import { existsSync, renameSync, unlinkSync, readdirSync } from "fs";
import { tmux, FLEET_DIR } from "../../sdk";
import { loadFleetEntries, getSessionNames, type FleetEntry } from "./fleet-load";

function displaySessionName(entry: FleetEntry): string {
  const session = entry.session as unknown as { name?: unknown } | null | undefined;
  return typeof session?.name === "string" && session.name.length > 0
    ? session.name
    : entry.groupName || entry.file.replace(/\.json$/, "") || "(unnamed)";
}

function displayWindowCount(entry: FleetEntry): number {
  const session = entry.session as unknown as { windows?: unknown } | null | undefined;
  return Array.isArray(session?.windows) ? session.windows.length : 0;
}

function isMalformedEntry(entry: FleetEntry): boolean {
  const session = entry.session as unknown as { name?: unknown; windows?: unknown } | null | undefined;
  return typeof session?.name !== "string" || session.name.length === 0 || !Array.isArray(session?.windows);
}

export function renderFleetLs(entries: FleetEntry[], disabled: number, runningSessions: string[]): string[] {
  // Detect conflicts (duplicate numbers)
  const numCount = new Map<number, string[]>();
  for (const e of entries) {
    const list = numCount.get(e.num) || [];
    list.push(e.groupName);
    numCount.set(e.num, list);
  }

  const conflicts = [...numCount.entries()].filter(([, names]) => names.length > 1);
  const lines: string[] = [];

  lines.push(`\n  \x1b[36mFleet Configs\x1b[0m (${entries.length} active, ${disabled} disabled)\n`);
  lines.push(`  ${"#".padEnd(4)} ${"Session".padEnd(20)} ${"Win".padEnd(5)} Status`);
  lines.push(`  ${"─".repeat(4)} ${"─".repeat(20)} ${"─".repeat(5)} ${"─".repeat(20)}`);

  for (const e of entries) {
    const numStr = String(e.num).padStart(2, "0");
    const sessionName = displaySessionName(e);
    const name = sessionName.padEnd(20);
    const wins = String(displayWindowCount(e)).padEnd(5);
    const isRunning = runningSessions.includes(sessionName);
    const isConflict = (numCount.get(e.num)?.length ?? 0) > 1;

    let status = isRunning ? "\x1b[32mrunning\x1b[0m" : "\x1b[90mstopped\x1b[0m";
    if (isConflict) status += "  \x1b[31mCONFLICT\x1b[0m";
    if (isMalformedEntry(e)) status += "  \x1b[33mINVALID\x1b[0m";

    lines.push(`  ${numStr}  ${name} ${wins} ${status}`);
  }

  if (conflicts.length > 0) {
    lines.push(`\n  \x1b[31m⚠ ${conflicts.length} conflict(s) found.\x1b[0m Run \x1b[36mmaw fleet renumber\x1b[0m to fix.`);
  }
  lines.push("");
  return lines;
}

export async function cmdFleetLs() {
  const entries = loadFleetEntries();
  const disabled = readdirSync(FLEET_DIR).filter(f => f.endsWith(".disabled")).length;

  const runningSessions = await getSessionNames();
  for (const line of renderFleetLs(entries, disabled, runningSessions)) console.log(line);
}

export async function cmdFleetRenumber() {
  const entries = loadFleetEntries();

  // Check for conflicts first
  const numCount = new Map<number, number>();
  for (const e of entries) numCount.set(e.num, (numCount.get(e.num) || 0) + 1);
  const hasConflicts = [...numCount.values()].some(c => c > 1);

  if (!hasConflicts) {
    console.log("\n  \x1b[32mNo conflicts found.\x1b[0m Fleet numbering is clean.\n");
    return;
  }

  const runningSessions = await getSessionNames();

  console.log("\n  \x1b[36mRenumbering fleet...\x1b[0m\n");

  // Sort by current number, then by name for stability
  const sorted = [...entries].sort((a, b) => a.num - b.num || a.groupName.localeCompare(b.groupName));

  // Skip 99-overview from renumbering
  const regular = sorted.filter(e => e.num !== 99);

  let num = 1;
  for (const e of regular) {
    const newNum = String(num).padStart(2, "0");
    const newFile = `${newNum}-${e.groupName}.json`;
    const newName = e.groupName;
    const oldName = e.session.name;

    if (newFile !== e.file) {
      // Update config.name in JSON — write to temp file then atomically rename
      // name stays as the bare oracle name (no numeric prefix) — tmux sessions
      // are called by name, not by ID.
      e.session.name = newName;
      const tmpPath = join(FLEET_DIR, `.tmp-${newFile}`);
      await Bun.write(tmpPath, JSON.stringify(e.session, null, 2) + "\n");
      renameSync(tmpPath, join(FLEET_DIR, newFile));

      // Remove old file (only if name changed)
      const oldPath = join(FLEET_DIR, e.file);
      if (existsSync(oldPath) && newFile !== e.file) {
        unlinkSync(oldPath);
      }

      // Rename running tmux session (#84) — try exact name first, then pattern match
      const runningMatch = runningSessions.find(s => s === oldName)
        || runningSessions.find(s => s.replace(/^\d+-/, "") === e.groupName);
      if (runningMatch && runningMatch !== newName) {
        try {
          await tmux.run("rename-session", "-t", runningMatch, newName);
          console.log(`  ${e.file.padEnd(28)} → ${newFile}  (tmux: ${runningMatch} → ${newName})`);
        } catch {
          console.log(`  ${e.file.padEnd(28)} → ${newFile}  (tmux rename failed: ${runningMatch})`);
        }
      } else {
        console.log(`  ${e.file.padEnd(28)} → ${newFile}`);
      }
    } else {
      console.log(`  ${e.file.padEnd(28)}   (unchanged)`);
    }
    num++;
  }

  console.log(`\n  \x1b[32mDone.\x1b[0m ${regular.length} configs renumbered.\n`);
}
