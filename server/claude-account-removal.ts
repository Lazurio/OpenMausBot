import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";

const ADDED_ACCOUNT_ID = /^claude-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function hasOwnConfigDir(entry: InstanceConfig): boolean {
  const config = entry.config;
  return Boolean(config && typeof config === "object" && !Array.isArray(config) && Object.hasOwn(config, "configDir"));
}

/** Bots use this computer's one Claude login: a saved Claude account with a configuration directory of its own loads without it. */
export function withoutClaudeAccounts(map: InstanceConfigMap): InstanceConfigMap {
  for (const [id, entry] of Object.entries(map)) {
    if (entry.driver !== "claudeAgent") continue;
    if (id !== "claude" && (ADDED_ACCOUNT_ID.test(id) || hasOwnConfigDir(entry))) {
      delete map[id];
    } else if (hasOwnConfigDir(entry)) {
      const { configDir: _configDir, ...config } = entry.config as Record<string, unknown>;
      map[id] = { ...entry, config };
    }
  }
  return map;
}
