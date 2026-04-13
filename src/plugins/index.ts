/**
 * Plugin system — re-exports from numbered modules.
 * Number prefix = boot order. ls shows the sequence.
 *
 *   00_types.ts           → types, no deps
 *   10_system.ts          → PluginSystem (4-phase pipeline)
 *   20_loader.ts          → load from disk (TS/JS/WASM)
 *   30_hooks-registry.ts  → manifest hooks → system
 *   40_watcher.ts         → hot-reload
 */

export type { MawPlugin, MawHooks, PluginScope, PluginInfo } from "./00_types";
export { PluginSystem } from "./10_system";
export { loadPlugins, reloadUserPlugins } from "./20_loader";
export { registerManifestHooks } from "./30_hooks-registry";
export { watchUserPlugins } from "./40_watcher";
