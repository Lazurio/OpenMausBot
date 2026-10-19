// Lazurio overlay: engines removed from Lazurio's distribution.
// A saved config.json that still names one loads and drops it, so the next save leaves it off disk.
import type { InstanceConfigMap } from "./contracts.ts";

const REMOVED_ENGINE_DRIVERS: ReadonlySet<string> = new Set(["antigravityAgent"]);

/** A Codex entry with a sign-in mode of its own (the removed ChatGPT plan) is not Codex: Codex uses this computer's `codex login`. */
function ownCodexSignIn(entry: InstanceConfigMap[string]): boolean {
  return entry.driver === "codex" && (entry.config as { authMode?: unknown } | undefined)?.authMode !== undefined;
}

export function withoutRemovedEngines(map: InstanceConfigMap): InstanceConfigMap {
  for (const [id, entry] of Object.entries(map)) {
    if (REMOVED_ENGINE_DRIVERS.has(entry.driver) || ownCodexSignIn(entry)) delete map[id];
  }
  return map;
}
