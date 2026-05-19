/** Module-level cache shared between command.ts (setter) and command-logic.ts (consumer). */
let _ollamaModel = "";

export function setOllamaModelCache(model: string) { _ollamaModel = model; }
export function getOllamaModelCache(): string { return _ollamaModel; }
