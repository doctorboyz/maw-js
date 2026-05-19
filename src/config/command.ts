import { execSync } from "child_process";
import { createInterface } from "readline";
import { loadConfig } from "./load";
import { buildCommandFromConfig, buildCommandInDirFromConfig } from "./command-logic";
import { setOllamaModelCache } from "./ollama-cache";

export { buildCommandFromConfig, buildCommandInDirFromConfig } from "./command-logic";

function askUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

/** Let interactive callers pre-select the model before buildCommand() runs. */
export function setOllamaModel(model: string) { setOllamaModelCache(model); }

/** Return currently pulled Ollama model names (e.g. ["glm-5.1:cloud", "kimi-k2.6:cloud"]) */
export function getOllamaModels(): string[] {
  try {
    const output = execSync("ollama list", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return output.trim().split("\n").slice(1)
      .map(line => line.trim().split(/\s+/)[0])
      .filter(name => name && !name.startsWith("failed") && !name.startsWith("NAME"));
  } catch {
    return [];
  }
}

/**
 * Present a numbered list of locally pulled Ollama models and ask the user
 * to pick one.  Falls back to the first model when stdin isn't a TTY.
 * Throws when no models are available.
 */
export async function resolveOllamaModel(): Promise<string> {
  const models = getOllamaModels();
  if (!models.length) throw new Error("no Ollama models found — pull one first: ollama pull <model>:cloud");

  // Non-interactive fallback (fleet wake, ws handler, CI)
  if (!process.stdin.isTTY) {
    console.log(`\x1b[36m→\x1b[0m non-interactive — using ${models[0]}`);
    setOllamaModel(models[0]);
    return models[0];
  }

  console.log("\n\x1b[36m⚡ Pick an Ollama model:\x1b[0m\n");
  models.forEach((name, i) => console.log(`  \x1b[33m${i + 1}\x1b[0m. ${name}`));

  const picked = await askUser(`\n  model [1-${models.length}] (default 1): `);
  const idx = parseInt(picked || "1", 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= models.length) {
    console.log(`  \x1b[33m→ using ${models[0]}\x1b[0m\n`);
    setOllamaModel(models[0]);
    return models[0];
  }
  console.log(`  \x1b[32m→ using ${models[idx]}\x1b[0m\n`);
  setOllamaModel(models[idx]);
  return models[idx];
}

export function buildCommand(agentName: string, engine?: string): string {
  return buildCommandFromConfig(loadConfig(), agentName, engine);
}

export function buildCommandInDir(agentName: string, cwd: string, engine?: string): string {
  return buildCommandInDirFromConfig(loadConfig(), agentName, cwd, engine);
}

export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
