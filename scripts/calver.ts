#!/usr/bin/env bun
// CalVer bump for maw-js
//
// Scheme: v{yy}.{m}.{d}[-(alpha|beta).{hh}{letter?}]
//
// Per #858: alpha numbers encode the wall-clock hour (0–23). Multiple releases
// in the same hour add a collision letter suffix starting at `b`:
//   first  release in 18:00 → 26.4.29-alpha.18
//   second release in 18:00 → 26.4.29-alpha.18b
//   third  release in 18:00 → 26.4.29-alpha.18c
//   ...
//   26th   release in 18:00 → 26.4.29-alpha.18z   (cap — error if exceeded)
//
// Self-describing: the alpha number tells you when it shipped. Trade-off vs
// the post-#766 monotonic counter: hour-bucketing caps releases per hour at
// 26 (one plain + b–z), and busy hours show as `.18b/.18c/...` rather than a
// dense run of integers.
//
// Backward compatibility: existing tags from the monotonic-counter era (e.g.
// `v26.4.29-alpha.21`) are NOT misread by the new collision detector — only
// tags whose suffix matches the *current hour* (with an optional letter) are
// counted as collisions. Pre-existing higher-numbered tags from earlier in
// the day stay valid in git history.
//
// Beta channel (#754) follows the same hour-bucket + letter rule with its
// own independent space.
//
// Timezone comes from the shell — set TZ=Asia/Bangkok in CI if needed.
//
// Usage:
//   bun scripts/calver.ts                  → 26.4.18-alpha.{hh}[letter?]
//   bun scripts/calver.ts --beta           → 26.4.18-beta.{hh}[letter?]
//   bun scripts/calver.ts --stable         → 26.4.18
//   bun scripts/calver.ts --hour 14        → 26.4.18-alpha.14[letter?]
//   bun scripts/calver.ts --check          → dry-run (no writes)

import { $ } from "bun";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type Channel = "alpha" | "beta";
type Args = { stable: boolean; channel?: Channel; hour?: number; check: boolean; now?: Date };

function parseArgs(argv: string[]): Args {
  const args: Args = { stable: false, channel: "alpha", check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stable") args.stable = true;
    else if (a === "--beta") args.channel = "beta";
    else if (a === "--check" || a === "--dry-run") args.check = true;
    else if (a === "--hour") {
      const v = argv[++i];
      const n = parseInt(v, 10);
      if (!Number.isInteger(n) || n < 0 || n > 23) {
        console.error(`--hour expects integer 0-23, got: ${v}`);
        process.exit(2);
      }
      args.hour = n;
    } else if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      console.error(HELP);
      process.exit(2);
    }
  }
  if (args.stable && args.channel === "beta") {
    console.error("--stable and --beta are mutually exclusive");
    process.exit(2);
  }
  return args;
}

const HELP = `Usage: bun scripts/calver.ts [options]

Compute next CalVer version and bump package.json.

Scheme: v{yy}.{m}.{d}[-(alpha|beta).{hh}{letter?}] — hh is the wall-clock
hour 0-23; collisions within the same hour add a letter suffix b, c, …, z
(per #858). Cap is 26 releases/hour.

Options:
  --stable         Cut stable (no alpha/beta suffix)
  --beta           Cut beta instead of alpha (separate space)
  --hour N         Override hour (0-23) — useful for backfill or testing
  --check          Dry-run: print target, don't modify files
  -h, --help       Show help

Examples:
  bun scripts/calver.ts                  next alpha at current hour → 26.4.18-alpha.10[b…]
  bun scripts/calver.ts --beta           next beta  at current hour → 26.4.18-beta.10[b…]
  bun scripts/calver.ts --stable         stable cut                 → 26.4.18
  bun scripts/calver.ts --hour 14        alpha at 14:xx             → 26.4.18-alpha.14[b…]
  bun scripts/calver.ts --check          print only, no write`;

export function dateBase(now: Date): string {
  const yy = now.getFullYear() % 100;
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return `${yy}.${m}.${d}`;
}

/**
 * #819: extract the CalVer base (YY.M.D) from a version string. Accepts
 * `v26.4.29`, `26.4.29`, `v26.4.29-alpha.5`, `26.4.29-alpha.5b`, etc.
 * Returns null if the string does not look like a CalVer base.
 */
export function extractBaseFromVersion(version: string): string | null {
  if (!version) return null;
  const stripped = version.startsWith("v") ? version.slice(1) : version;
  const m = stripped.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  const [, yy, mo, da] = m;
  return `${yy}.${mo}.${da}`;
}

/**
 * #819: lexicographic-safe compare of two CalVer bases by integer segment.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareBases(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10));
  const pb = b.split(".").map((x) => parseInt(x, 10));
  if (pa.length !== 3 || pb.length !== 3) {
    throw new Error(`compareBases expects YY.M.D, got "${a}" vs "${b}"`);
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * #819: pick the effective base for the next bump — the later of today's
 * clock-derived base and the package.json-derived base. Prevents the
 * post-stable-cut downgrade described in #819.
 */
export function effectiveBase(todayBase: string, packageVersion: string): string {
  const pkgBase = extractBaseFromVersion(packageVersion);
  if (!pkgBase) return todayBase;
  return compareBases(pkgBase, todayBase) > 0 ? pkgBase : todayBase;
}

/**
 * Parse a tag/version suffix into {hour, letterIndex} where letterIndex is
 * 0 for plain `{hh}`, 1 for `{hh}b`, 2 for `{hh}c`, …, 25 for `{hh}z`.
 *
 * Returns null on:
 *   - hour out of range (must be 0-23) — rejects legacy monotonic ints ≥ 24
 *   - letter not in [b-z] — rejects "16a" (reserved for plain), multi-letter
 *     ("16ab"), uppercase, and any non-letter ("16-rc", "16.0", etc.)
 *
 * Exported for tests.
 */
export function parseSuffix(suffix: string): { hour: number; letterIndex: number } | null {
  // Match "{digits}" or "{digits}{single-lowercase-letter}".
  const m = suffix.match(/^(\d+)([b-z])?$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const letter = m[2];
  // letter "b" → index 1, "c" → 2, …, "z" → 25
  const letterIndex = letter ? letter.charCodeAt(0) - "a".charCodeAt(0) : 0;
  return { hour, letterIndex };
}

/**
 * Render a bucket index back to a suffix. 0 → "{hh}" (plain), 1 → "{hh}b",
 * …, 25 → "{hh}z". Throws on overflow (one-day-one-hour cap is 26 releases).
 */
export function renderSuffix(hour: number, letterIndex: number): string {
  if (letterIndex < 0 || letterIndex > 25) {
    throw new Error(`hour-bucket collision overflow: letterIndex=${letterIndex} (max 25 = 'z')`);
  }
  if (letterIndex === 0) return `${hour}`;
  const letter = String.fromCharCode("a".charCodeAt(0) + letterIndex);
  return `${hour}${letter}`;
}

/**
 * Walk tags for {base}-{channel}.* and return the highest letterIndex *for the
 * given hour bucket*. Returns -1 if no tag in that bucket exists yet.
 *
 * Legacy monotonic tags (e.g. v26.4.29-alpha.21 from the pre-#858 counter)
 * coexist: numerically `21` parses as hour 21 with letterIndex 0, so it
 * counts as a collision IF the user is bumping during hour 21. Other-hour
 * legacy tags are correctly ignored.
 *
 * Suffixes ≥ 24 (legacy ints like alpha.24, alpha.25) are rejected by
 * parseSuffix and don't poison the collision space.
 */
export function maxLetterInHour(
  base: string,
  channel: Channel,
  hour: number,
  tags: string[],
): number {
  const prefix = `v${base}-${channel}.`;
  let max = -1;
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const rest = tag.slice(prefix.length);
    const parsed = parseSuffix(rest);
    if (!parsed) continue;
    if (parsed.hour !== hour) continue;
    if (parsed.letterIndex > max) max = parsed.letterIndex;
  }
  return max;
}

/**
 * Same scan applied to package.json's version string. Returns -1 if the
 * version doesn't match base+channel+hour, or if it's not parseable.
 */
export function maxLetterInHourFromPackageJson(
  base: string,
  channel: Channel,
  hour: number,
  packageVersion: string,
): number {
  if (!packageVersion) return -1;
  const stripped = packageVersion.startsWith("v") ? packageVersion.slice(1) : packageVersion;
  const prefix = `${base}-${channel}.`;
  if (!stripped.startsWith(prefix)) return -1;
  const rest = stripped.slice(prefix.length);
  const parsed = parseSuffix(rest);
  if (!parsed) return -1;
  if (parsed.hour !== hour) return -1;
  return parsed.letterIndex;
}

async function listChannelTags(base: string, channel: Channel): Promise<string[]> {
  const res = await $`git tag --list ${`v${base}-${channel}.*`}`.nothrow().quiet();
  if (res.exitCode !== 0) return [];
  return res.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean);
}

export function computeVersion(
  args: Args,
  tags: string[] = [],
  packageVersion: string = "",
): string {
  const now = args.now ?? new Date();
  const todayBase = dateBase(now);
  const base = args.stable ? todayBase : effectiveBase(todayBase, packageVersion);
  if (args.stable) return base;

  const channel = args.channel ?? "alpha";
  const hour = args.hour ?? now.getHours();
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`invalid hour: ${hour} (must be 0-23)`);
  }

  const tagMax = maxLetterInHour(base, channel, hour, tags);
  const pkgMax = maxLetterInHourFromPackageJson(base, channel, hour, packageVersion);
  const max = Math.max(tagMax, pkgMax);
  // -1 → no collision yet, plain `{hh}`. Otherwise next letter.
  const next = max + 1;
  return `${base}-${channel}.${renderSuffix(hour, next)}`;
}

async function tagExists(version: string): Promise<boolean> {
  const res = await $`git rev-parse --verify --quiet ${`v${version}`}`.nothrow().quiet();
  return res.exitCode === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = args.now ?? new Date();
  const todayBase = dateBase(now);

  const pkgPath = join(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  const base = args.stable ? todayBase : effectiveBase(todayBase, pkg.version ?? "");

  const channelForTags: Channel = args.channel ?? "alpha";
  const tags = args.stable ? [] : await listChannelTags(base, channelForTags);
  const version = computeVersion(args, tags, pkg.version ?? "");
  const channel = args.stable ? "stable" : channelForTags;

  console.log(`Target: v${version}  [${channel}]`);

  if (args.check) {
    console.log("(check mode — no changes written)");
    return;
  }

  if (await tagExists(version)) {
    // Should never happen — we picked the next free letter — but guard the race.
    console.error(`\n❌ tag v${version} already exists`);
    if (args.stable) {
      console.error(`   → stable for today already cut; nothing to do`);
    } else {
      console.error(`   → race detected: another tag was created between scan and bump`);
    }
    process.exit(1);
  }

  const old = pkg.version;
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`✓ package.json: ${old} → ${version}`);

  console.log(`
Next:
  git add package.json && git commit -m "bump: v${version}" && git push origin main
  → calver-release.yml creates v${version} tag + GitHub release (+ builds dist/maw)
  → dist/maw attached to release`);
}

if (import.meta.main) main();
