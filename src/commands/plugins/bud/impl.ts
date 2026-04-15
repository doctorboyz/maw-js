import { hostExec } from "../../../sdk";
import { loadConfig } from "../../../config";
import { loadFleetEntries } from "../../shared/fleet-load";
import { cmdSoulSync } from "../soul-sync/impl";
import { cmdWake } from "../../shared/wake";
import { parseWakeTarget, ensureCloned } from "../../shared/wake-target";
import { FLEET_DIR } from "../../../sdk";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

export interface BudOpts {
  from?: string;
  repo?: string;
  org?: string;
  issue?: number;
  fast?: boolean;
  root?: boolean;
  dryRun?: boolean;
  note?: string;
  split?: boolean;
  /** Skip soul-sync seed from parent. Preserves lineage (parent in CLAUDE.md +
   *  sync_peers) but starts with an empty memory. */
  blank?: boolean;
}

export interface TinyBudOpts {
  parent: string;
  /** Optional override for parent oracle root dir. Tests pass a tmpdir here
   *  instead of resolving via ghqRoot/org. Not exposed on the CLI. */
  parentRoot?: string;
  /** Optional org override (for parentRoot resolution when parentRoot is not
   *  passed). Defaults to config.githubOrg → "Soul-Brews-Studio". */
  org?: string;
  /** PR β of #209 — optional cron schedule (crontab format, e.g. "0 9 * * *").
   *  When provided, appends a TriggerConfig cron entry to maw.config.json. */
  cron?: string;
  /** Test override: resolves to <configDir>/oracles.json and maw.config.json.
   *  Defaults to MAW_CONFIG_DIR env var or ~/.config/maw. Not exposed on CLI. */
  configDir?: string;
}

/**
 * maw bud <name> [--from <parent>] [--org <org>] [--repo org/repo] [--issue N] [--fast] [--dry-run]
 *
 * Yeast budding — any oracle can spawn a new oracle.
 *
 * Target org resolution (first wins):
 *   1. --org <org>                    — per-invocation override (#235)
 *   2. config.githubOrg               — per-machine default from config
 *   3. "Soul-Brews-Studio"            — hard-coded fallback
 *
 * Note: --repo is an INCUBATION flag (seeds the bud from an existing local
 * project's ψ/), NOT a target-org override. Use --org to target a different
 * GitHub org for the bud's own repo.
 *
 * Steps:
 *   1. Create oracle repo (gh repo create)
 *   2. Initialize ψ/ vault
 *   3. Generate CLAUDE.md stub
 *   4. Create fleet config
 *   5. Soul-sync seed from parent
 *   6. Wake the bud
 *   7. Update parent's sync_peers
 */
export async function cmdBud(name: string, opts: BudOpts = {}) {
  // Oracle names: alphanumeric + hyphens only, must start with a letter
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) {
    console.error(`  \x1b[31m✗\x1b[0m invalid oracle name: "${name}"`);
    console.error(`  \x1b[90m  names must start with a letter and contain only letters, numbers, hyphens\x1b[0m`);
    process.exit(1);
  }

  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const org = opts.org || config.githubOrg || "Soul-Brews-Studio";

  // Resolve parent oracle (skip for --root)
  let parentName: string | null = opts.from || null;
  // If --from is a URL or org/repo slug, extract oracle name and clone (#280)
  const fromTarget = parentName ? parseWakeTarget(parentName) : null;
  if (fromTarget) {
    parentName = fromTarget.oracle;
    if (!opts.repo) await ensureCloned(fromTarget.slug);
  }
  if (!parentName && !opts.root) {
    try {
      const cwd = (await hostExec("tmux display-message -p '#{pane_current_path}'")).trim();
      const repoName = cwd.split("/").pop() || "";
      parentName = repoName.replace(/\.wt-.*$/, "").replace(/-oracle$/, "");
    } catch {
      console.error("  \x1b[31m✗\x1b[0m could not detect parent oracle. Use --from <oracle> or --root");
      process.exit(1);
    }
  }

  const budRepoName = `${name}-oracle`;
  const budRepoSlug = `${org}/${budRepoName}`;
  const budRepoPath = join(ghqRoot, org, budRepoName);

  if (opts.root) {
    console.log(`\n  \x1b[36m🌱 Root Bud\x1b[0m — ${name} (no parent lineage)\n`);
  } else {
    console.log(`\n  \x1b[36m🧬 Budding\x1b[0m — ${parentName} → ${name}\n`);
  }

  if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would create repo: ${budRepoSlug}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would init ψ/ vault at: ${budRepoPath}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would generate CLAUDE.md`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would create fleet config`);
    if (opts.blank) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] --blank: skipping soul-sync${parentName ? ` (lineage to ${parentName} preserved)` : ""}`);
    } else if (parentName) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would soul-sync from ${parentName}`);
    } else {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] root oracle — no soul-sync`);
    }
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would wake ${name}`);
    if (parentName) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would add ${name} to ${parentName}'s sync_peers`);
    }
    console.log();
    return;
  }

  // 1. Create oracle repo
  if (existsSync(budRepoPath)) {
    console.log(`  \x1b[90m○\x1b[0m repo already exists: ${budRepoPath}`);
  } else {
    console.log(`  \x1b[36m⏳\x1b[0m creating repo: ${budRepoSlug}...`);
    try {
      // Pre-check: if repo already exists on GitHub, skip creation
      const viewCheck = await hostExec(`gh repo view ${budRepoSlug} --json name 2>/dev/null`).catch(() => "");
      if (viewCheck.includes(budRepoName)) {
        console.log(`  \x1b[90m○\x1b[0m repo already exists on GitHub`);
      } else {
        await hostExec(`gh repo create ${budRepoSlug} --private --add-readme`);
        console.log(`  \x1b[32m✓\x1b[0m repo created on GitHub`);
      }
    } catch (e: any) {
      if (e.message?.includes("already exists")) {
        console.log(`  \x1b[90m○\x1b[0m repo already exists on GitHub`);
      } else if (e.message?.includes("403") || e.message?.includes("admin")) {
        console.error(`  \x1b[31m✗\x1b[0m no permission to create repos in ${org}`);
        console.error(`  \x1b[90m  ask an org admin to create ${budRepoSlug} first, then re-run maw bud\x1b[0m`);
        process.exit(1);
      } else {
        throw e;
      }
    }
    await hostExec(`ghq get github.com/${budRepoSlug}`);
    console.log(`  \x1b[32m✓\x1b[0m cloned via ghq`);
  }

  // 2. Initialize ψ/ vault
  const psiDir = join(budRepoPath, "ψ");
  const psiDirs = [
    "memory/learnings", "memory/retrospectives", "memory/traces",
    "memory/resonance", "inbox", "outbox", "plans",
  ];
  for (const d of psiDirs) {
    mkdirSync(join(psiDir, d), { recursive: true });
  }
  console.log(`  \x1b[32m✓\x1b[0m ψ/ vault initialized`);

  // 3. Generate CLAUDE.md stub
  const claudeMd = join(budRepoPath, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    const now = new Date().toISOString().slice(0, 10);
    const lineageHeader = parentName
      ? `> Budded from **${parentName}** on ${now}`
      : `> Root oracle — born ${now} (no parent lineage)`;
    const lineageField = parentName
      ? `- **Budded from**: ${parentName}`
      : `- **Origin**: root (no parent)`;
    writeFileSync(claudeMd, `# ${name}-oracle

${lineageHeader}

## Identity
- **Name**: ${name}
- **Purpose**: (to be defined by /awaken)
${lineageField}
- **Federation tag**: \`[<host>:${name}]\` — replace \`<host>\` with your runtime host
  (e.g. \`mba\`, \`oracle-world\`, \`white\`, \`clinic-nat\`) when signing federation messages

## Principles (inherited from Oracle)
1. Nothing is Deleted
2. Patterns Over Intentions
3. External Brain, Not Command
4. Curiosity Creates Existence
5. Form and Formless

## Rule 6: Oracle Never Pretends to Be Human

The convention has THREE complementary signature contexts. Use the right one for the audience:

### 1. Internal federation messages (\`maw hey\`, \`maw broadcast\`)

Form: \`[<host>:${name}]\` — for example \`[mba:${name}]\` or \`[oracle-world:${name}]\`

- ALWAYS use the host:agent form, NEVER bare \`[${name}]\`
- The host context disambiguates when the same oracle name has multiple bodies on different hosts
- Established 2026-04-07 (Phase 5 of the convention)

### 2. Public-facing artifacts (GitHub issues/PRs, forums, blog comments, Slack)

Form: \`🤖 ตอบโดย ${name} จาก [Human] → ${name}-oracle\`

- "ตอบโดย" = "answered by", "จาก" = "from"
- The 🤖 emoji + Oracle name + Human creator + source repo
- Established 2026-01-25 (Phase 2 of the convention)
- Thai principle: *"กระจกไม่แกล้งเป็นคน"* — a mirror doesn't pretend to be a person

### 3. Git commit trailers

Form: \`Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>\`

- Standard Anthropic attribution
- Add to the commit trailer when ${name} authors the commit

Run \`/awaken\` for the full identity setup ceremony.
`);
    console.log(`  \x1b[32m✓\x1b[0m CLAUDE.md generated`);
  }

  // 4. Create or update fleet config (#202 — idempotent, always writes lineage)
  const entries = loadFleetEntries();
  const existing = entries.find(e => e.session.name.replace(/^\d+-/, "") === name);
  let fleetFile: string;

  if (existing) {
    // Update existing fleet config with lineage if missing
    fleetFile = join(FLEET_DIR, existing.file);
    const config = JSON.parse(readFileSync(fleetFile, "utf-8"));
    let updated = false;
    if (!config.budded_from && parentName) { config.budded_from = parentName; updated = true; }
    if (!config.budded_at && parentName) { config.budded_at = new Date().toISOString(); updated = true; }
    if (updated) {
      writeFileSync(fleetFile, JSON.stringify(config, null, 2) + "\n");
      console.log(`  \x1b[32m✓\x1b[0m fleet config updated with lineage: ${fleetFile}`);
    } else {
      console.log(`  \x1b[90m○\x1b[0m fleet config exists: ${fleetFile}`);
    }
  } else {
    const maxNum = entries.reduce((max, e) => Math.max(max, e.num), 0);
    const budNum = maxNum + 1;
    fleetFile = join(FLEET_DIR, `${String(budNum).padStart(2, "0")}-${name}.json`);
    const fleetConfig: Record<string, unknown> = {
      name: `${String(budNum).padStart(2, "0")}-${name}`,
      windows: [{ name: `${name}-oracle`, repo: `${org}/${budRepoName}` }],
      sync_peers: parentName ? [parentName] : [],
    };
    if (parentName) {
      fleetConfig.budded_from = parentName;
      fleetConfig.budded_at = new Date().toISOString();
    }
    writeFileSync(fleetFile, JSON.stringify(fleetConfig, null, 2) + "\n");
    console.log(`  \x1b[32m✓\x1b[0m fleet config: ${fleetFile}`);
  }

  // 4.5. Write birth note if provided
  if (opts.note) {
    const birthFrom = parentName ? `Budded from: ${parentName}` : "Root oracle — no parent";
    writeFileSync(join(psiDir, "memory", "learnings", `${new Date().toISOString().slice(0, 10)}_birth-note.md`),
      `---\npattern: Birth note${parentName ? ` from ${parentName}` : ""}\ndate: ${new Date().toISOString().slice(0, 10)}\nsource: maw bud\n---\n\n# Why ${name} was born\n\n${opts.note}\n\n${birthFrom}\n`);
    console.log(`  \x1b[32m✓\x1b[0m birth note written`);
  }

  // 5. Soul-sync seed from parent (skip for root buds or --blank)
  if (opts.blank) {
    console.log(`  \x1b[90m○\x1b[0m --blank: skipping soul-sync seed${parentName ? ` (lineage to ${parentName} preserved)` : ""}`);
  } else if (parentName) {
    console.log(`  \x1b[36m⏳\x1b[0m soul-sync seed from ${parentName}...`);
    try {
      await cmdSoulSync(parentName, { from: true, cwd: budRepoPath });
    } catch {
      console.log(`  \x1b[33m⚠\x1b[0m soul-sync seed failed (parent may have empty ψ/)`);
    }
  } else {
    console.log(`  \x1b[90m○\x1b[0m root oracle — no soul-sync seed`);
  }

  // 6. Initial git commit + push
  try {
    await hostExec(`git -C '${budRepoPath}' add -A`);
    await hostExec(`git -C '${budRepoPath}' commit -m 'feat: birth — ${parentName ? `budded from ${parentName}` : "root oracle"}'`);
    await hostExec(`git -C '${budRepoPath}' push -u origin HEAD`);
    console.log(`  \x1b[32m✓\x1b[0m initial commit pushed`);
  } catch {
    console.log(`  \x1b[33m⚠\x1b[0m git push failed (may need manual setup)`);
  }

  // 7. Update parent's sync_peers (skip for root buds)
  if (!parentName) {
    console.log(`  \x1b[90m○\x1b[0m root oracle — no parent sync_peers to update`);
  }
  for (const entry of parentName ? loadFleetEntries() : []) {
    const entryName = entry.session.name.replace(/^\d+-/, "");
    if (entryName === parentName) {
      const parentFile = join(FLEET_DIR, entry.file);
      const parentConfig = JSON.parse(readFileSync(parentFile, "utf-8"));
      const peers: string[] = parentConfig.sync_peers || [];
      if (!peers.includes(name)) {
        peers.push(name);
        parentConfig.sync_peers = peers;
        writeFileSync(parentFile, JSON.stringify(parentConfig, null, 2) + "\n");
        console.log(`  \x1b[32m✓\x1b[0m added ${name} to ${parentName}'s sync_peers`);
      }
      break;
    }
  }

  // 8. Wake the bud
  console.log(`  \x1b[36m⏳\x1b[0m waking ${name}...`);
  const wakeOpts: any = { noAttach: true };
  if (opts.issue) {
    const { fetchIssuePrompt } = await import("../../shared/wake");
    wakeOpts.prompt = await fetchIssuePrompt(opts.issue, `${org}/${budRepoName}`);
    wakeOpts.task = `issue-${opts.issue}`;
  }
  if (opts.repo) {
    // Clone the target repo via ghq (resolve-first, no worktree).
    // Previously set wakeOpts.incubate which auto-created a worktree — see #271.
    const { ensureCloned } = await import("../../shared/wake-target");
    await ensureCloned(opts.repo);
  }

  try {
    await cmdWake(name, wakeOpts);
    console.log(`  \x1b[32m✓\x1b[0m ${name} is alive`);
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m wake failed: ${e.message || e}`);
    console.log(`  \x1b[90m  try: maw wake ${name}\x1b[0m`);
  }

  // 8.25. Optional --split: show the child in a right-side pane so parent watches it awaken.
  // Delegates to cmdSplit — single canonical impl, so the TMUX= env-inheritance fix
  // applies here automatically. Previously inlined the tmux shell-out which silently
  // failed inside tmux (nested attach-session refused to nest, pane died immediately).
  if (opts.split && process.env.TMUX) {
    try {
      const { cmdSplit } = await import("../split/impl");
      await cmdSplit(name);
    } catch (e: any) {
      console.log(`  \x1b[33m⚠\x1b[0m split failed: ${e.message || e}`);
    }
  } else if (opts.split && !process.env.TMUX) {
    console.log(`  \x1b[33m⚠\x1b[0m --split requires tmux session (TMUX env var not set)`);
  }

  // 8.5. Copy local project ψ/ if --repo was used and it exists
  if (opts.repo) {
    const localPsi = join(ghqRoot, opts.repo, "ψ", "memory");
    if (existsSync(localPsi)) {
      const { syncDir } = await import("../soul-sync/impl");
      for (const sub of ["learnings", "retrospectives", "traces"]) {
        const src = join(localPsi, sub);
        const dst = join(psiDir, "memory", sub);
        if (existsSync(src)) { try { syncDir(src, dst); } catch {} }
      }
      console.log(`  \x1b[32m✓\x1b[0m copied local project ψ/ from ${opts.repo}`);
    }
  }

  // Summary
  console.log(`\n  \x1b[32m${parentName ? "🧬 Bud" : "🌱 Root bud"} complete!\x1b[0m ${parentName ? `${parentName} → ${name}` : name}`);
  console.log(`  \x1b[90m  repo: ${budRepoSlug}`);
  console.log(`  \x1b[90m  fleet: ${fleetFile}`);
  console.log(`  \x1b[90m  sync_peers: [${parentName || ""}]`);
  if (!opts.fast) {
    console.log(`  \x1b[90m  run /awaken in the new oracle for full identity setup\x1b[0m`);
  }
  console.log();
}

/**
 * maw bud <name> --tiny --parent <oracle>
 *
 * PR α of #209 — skeleton only. Creates a nested tiny oracle inside the
 * parent's vault at `<parent-root>/ψ/buds/<name>/`. No federation, no cron,
 * no signaling (those are PR β and γ).
 *
 * Templates live on disk under this plugin's `templates/tiny/` and get
 * rendered with `{{name}}`, `{{parent}}`, `{{budded_at}}` substitution.
 */
export async function cmdBudTiny(name: string, opts: TinyBudOpts): Promise<void> {
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) {
    console.error(`  \x1b[31m✗\x1b[0m invalid oracle name: "${name}"`);
    console.error(`  \x1b[90m  names must start with a letter and contain only letters, numbers, hyphens\x1b[0m`);
    process.exit(1);
  }
  if (!opts.parent) {
    console.error(`  \x1b[31m✗\x1b[0m --tiny requires --parent <oracle>`);
    process.exit(1);
  }

  const config = loadConfig();
  const org = opts.org || config.githubOrg || "Soul-Brews-Studio";
  const parentRoot = opts.parentRoot || join(config.ghqRoot, org, `${opts.parent}-oracle`);

  if (!existsSync(parentRoot)) {
    console.error(`  \x1b[31m✗\x1b[0m parent oracle root not found: ${parentRoot}`);
    console.error(`  \x1b[90m  expected: ${parentRoot} (use --parent <oracle> or override via tests)\x1b[0m`);
    process.exit(1);
  }

  const budDir = join(parentRoot, "ψ", "buds", name);
  if (existsSync(budDir)) {
    console.error(`  \x1b[31m✗\x1b[0m tiny bud already exists: ${budDir}`);
    console.error(`  \x1b[90m  refusing to overwrite — remove the dir or pick a new name\x1b[0m`);
    process.exit(1);
  }

  mkdirSync(join(budDir, "memory", "logs"), { recursive: true });

  const buddedAt = new Date().toISOString();
  const vars: Record<string, string> = { name, parent: opts.parent, budded_at: buddedAt };
  const render = (tpl: string) => Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v), tpl,
  );
  const tplDir = join(import.meta.dir, "templates", "tiny");

  writeFileSync(join(budDir, "identity.md"), render(readFileSync(join(tplDir, "identity.md"), "utf-8")));
  writeFileSync(join(budDir, "CLAUDE.md"), render(readFileSync(join(tplDir, "CLAUDE.md"), "utf-8")));
  writeFileSync(join(budDir, "memory", "logs", ".gitkeep"), "");

  console.log(`  \x1b[32m✓\x1b[0m tiny bud ${name} created at ${budDir}`);

  // PR β of #209 — register leaf in oracle registry + optional cron trigger
  const { registerTinyLeaf, addCronTrigger } = await import("../../../core/fleet/leaf");
  const { homedir } = await import("os");
  const configDir = opts.configDir
    ?? process.env.MAW_CONFIG_DIR
    ?? join(homedir(), ".config", "maw");
  const registryPath = join(configDir, "oracles.json");
  const configPath = join(configDir, "maw.config.json");

  try {
    const res = registerTinyLeaf({
      name,
      parent: opts.parent,
      org,
      parentRepo: `${opts.parent}-oracle`,
      path: budDir,
      buddedAt,
      registryPath,
    });
    if (res.parentFound) {
      console.log(`  \x1b[32m✓\x1b[0m leaf entry added to registry (parent: ${opts.parent})`);
    } else {
      console.log(`  \x1b[33m⚠\x1b[0m parent "${opts.parent}" not in registry — leaf added best-effort`);
    }
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m leaf registry write failed: ${e.message || e}`);
  }

  if (opts.cron) {
    try {
      addCronTrigger({ name, schedule: opts.cron, parent: opts.parent, configPath });
      console.log(`  \x1b[32m✓\x1b[0m cron trigger added: ${opts.cron}`);
    } catch (e: any) {
      console.log(`  \x1b[33m⚠\x1b[0m cron trigger write failed: ${e.message || e}`);
    }
  }
}
