/**
 * Canonical name-resolution helper for sessions, worktrees, and any
 * other `{ name }`-shaped items that users type bare names for.
 *
 * Why this exists:
 *   Previously the pattern `name.endsWith('-${userInput}')` was scattered
 *   across 7+ call sites. It silently picked the wrong answer when multiple
 *   items matched (e.g., target="view" matched mawjs-view, mawui-view,
 *   skills-cli-view — only the first won) and failed prefix-style names
 *   (e.g., target="mawjs" didn't match "mawjs-view").
 *
 * This helper makes resolution explicit: exact wins, otherwise collect all
 * suffix/prefix fuzzy matches and surface ambiguity to the caller. Silent
 * wrong-answer is worse than a loud failure.
 */

export type ResolveResult<T extends { name: string }> =
  | { kind: "none" }
  | { kind: "exact"; match: T }
  | { kind: "fuzzy"; match: T }
  | { kind: "ambiguous"; candidates: T[] };

/**
 * Resolve a bare user-typed name against a list of named items.
 * Priority: exact (case-insensitive) → suffix or prefix fuzzy → ambiguity.
 *
 * - If an item's name exactly equals the target (case-insensitive), return it
 *   as "exact". Exact wins even if other items also fuzzy-match.
 * - Otherwise collect items where name ends with `-${target}` OR starts with
 *   `${target}-` (both case-insensitive). If exactly one → "fuzzy". If two or
 *   more → "ambiguous" (return all candidates). If zero → "none".
 *
 * The target is trimmed before matching. An empty target returns "none" —
 * we don't want the empty string to match everything.
 */
export function resolveByName<T extends { name: string }>(
  target: string,
  items: readonly T[],
): ResolveResult<T> {
  const lc = target.trim().toLowerCase();
  if (lc === "") return { kind: "none" };

  // Step 1 — exact match wins, even if other items would fuzzy-match
  const exact = items.find(it => it.name.toLowerCase() === lc);
  if (exact) return { kind: "exact", match: exact };

  // Step 2+3 — fuzzy match (suffix OR prefix), case-insensitive
  const fuzzy = items.filter(it => {
    const n = it.name.toLowerCase();
    return n.endsWith(`-${lc}`) || n.startsWith(`${lc}-`);
  });

  if (fuzzy.length === 0) return { kind: "none" };
  if (fuzzy.length === 1) return { kind: "fuzzy", match: fuzzy[0]! };
  return { kind: "ambiguous", candidates: fuzzy };
}

// Thin convenience wrappers so call sites read cleanly at the use site.
// Both are the same generic — they exist purely for intent at the call site.
export const resolveSessionTarget = resolveByName;
export const resolveWorktreeTarget = resolveByName;
