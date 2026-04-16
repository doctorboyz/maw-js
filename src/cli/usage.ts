import { discoverPackages } from "../plugin/registry";

export function usage() {
  const title = `\x1b[36mmaw\x1b[0m — Multi-Agent Workflow`;

  try {
    const all = discoverPackages();
    const active = all.filter(p => !p.disabled && p.manifest.cli?.command);
    const hasDisabled = all.some(p => p.disabled);

    // Group by weight tier: core < 10, standard 10-49, extra 50+
    const tiers = [
      { name: "core",     plugins: active.filter(p => (p.manifest.weight ?? 50) < 10) },
      { name: "standard", plugins: active.filter(p => { const w = p.manifest.weight ?? 50; return w >= 10 && w < 50; }) },
      { name: "extra",    plugins: active.filter(p => (p.manifest.weight ?? 50) >= 50) },
    ].filter(t => t.plugins.length > 0);

    const multiTier = tiers.length > 1;
    const lines: string[] = [title, ""];

    for (const tier of tiers) {
      const label = multiTier
        ? `\x1b[33m${tier.name} (${tier.plugins.length}):\x1b[0m`
        : `\x1b[33m${tier.name}:\x1b[0m`;
      lines.push(label);
      for (const p of tier.plugins) {
        const cmd = `maw ${p.manifest.cli!.command}`.padEnd(28);
        const desc = p.manifest.description ?? "";
        lines.push(`  ${cmd} ${desc}`);
      }
      lines.push("");
    }

    const countLine = hasDisabled
      ? `\x1b[90m${active.length} commands active. Run 'maw plugin enable <name>' for more.\x1b[0m`
      : `\x1b[90m${active.length} commands active.\x1b[0m`;
    lines.push(countLine);

    console.log(lines.join("\n"));
  } catch {
    // Registry not loaded yet — minimal fallback
    console.log(`${title}\n\nRun \x1b[33mmaw plugin ls\x1b[0m to see available commands.`);
  }
}
