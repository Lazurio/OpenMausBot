// Lazurio overlay (DEV-6673 M3, issue #35): settings of features removed from Lazurio's distribution.
// A saved config.json that still has them loads and drops them (the config schema strips unknown keys);
// a write that names one (PUT /api/config) is refused as a whole, never half-applied.
import type { JsonValue } from "./schema.ts";

const REMOVED_CONFIG_KEYS: ReadonlyArray<readonly string[]> = [
  ["box"], ["vps"], ["localVm"], ["composio"], ["mcpServers"], ["features", "sharedComputers"],
  ...["computer", "cloudBackend", "autoStartVps", "composio", "mcpServers"].map((key) => ["newBotDefaults", "profile", key]),
];

/** The dotted path of the first removed setting the patch names, or null. */
export function removedConfigKey(value: JsonValue): string | null {
  for (const path of REMOVED_CONFIG_KEYS) {
    let node: JsonValue | undefined = value;
    for (const key of path.slice(0, -1)) node = node && typeof node === "object" && !Array.isArray(node) ? node[key] : undefined;
    if (node && typeof node === "object" && !Array.isArray(node) && Object.hasOwn(node, path.at(-1)!)) return path.join(".");
  }
  return null;
}
