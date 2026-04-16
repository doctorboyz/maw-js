import { hostExec } from "../../../sdk";
import { existsSync } from "fs";

/**
 * Step 1: Ensure the oracle's GitHub repo exists and is cloned locally.
 * Idempotent — skips creation/clone if already present.
 */
export async function ensureBudRepo(
  budRepoSlug: string,
  budRepoPath: string,
  budRepoName: string,
  org: string,
): Promise<void> {
  if (existsSync(budRepoPath)) {
    console.log(`  \x1b[90m○\x1b[0m repo already exists: ${budRepoPath}`);
    return;
  }
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
