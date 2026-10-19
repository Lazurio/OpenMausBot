// A saved config.json that still has them loads and drops them (the config schema strips unknown keys);
// a write that names one (PUT /api/config) is refused as a whole, never half-applied.
import type { JsonValue } from "./schema.ts";

const REMOVED_CONFIG_KEYS: ReadonlyArray<readonly string[]> = [
  ["box"], ["vps"], ["localVm"], ["composio"], ["mcpServers"], ["features", "sharedComputers"],
  ...["computer", "cloudBackend", "autoStartVps", "composio", "mcpServers"].map((key) => ["newBotDefaults", "profile", key]),
  // LAZURIO.md principle 3: no research key of MausBot's own.
  ["treg"],
];

// Values a setting can no longer take (DEV-6673, LAZURIO.md principle 2): upstream's Custom approval level.
const REMOVED_BOT_VALUES: ReadonlyArray<readonly [string, string]> = [["approvalMode", "custom"]];
const REMOVED_CONFIG_VALUES: ReadonlyArray<readonly [readonly string[], string]> =
  REMOVED_BOT_VALUES.map(([key, value]) => [["newBotDefaults", "profile", key], value] as const);

const child = (node: JsonValue | undefined, key: string): JsonValue | undefined =>
  node && typeof node === "object" && !Array.isArray(node) ? node[key] : undefined;

/** The dotted path of the first removed setting the patch names, or null. */
export function removedConfigKey(value: JsonValue): string | null {
  for (const path of REMOVED_CONFIG_KEYS) {
    let node: JsonValue | undefined = value;
    for (const key of path.slice(0, -1)) node = child(node, key);
    if (node && typeof node === "object" && !Array.isArray(node) && Object.hasOwn(node, path.at(-1)!)) return path.join(".");
  }
  for (const [path, removed] of REMOVED_CONFIG_VALUES) {
    if (path.reduce<JsonValue | undefined>(child, value) === removed) return `${path.join(".")} ${JSON.stringify(removed)}`;
  }
  return null;
}

const REMOVED_BOT_FIELDS: readonly string[] = ["acknowledgeLocalAuto", "approvePeerComms", "approvalGrant", "toolScope", "xResearch", "phoneApps", "vpsAlias"];
export function removedBotSetting(settings: unknown): string | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const record = settings as Record<string, unknown>;
  for (const [key, value] of REMOVED_BOT_VALUES) if (record[key] === value) return `${key} ${JSON.stringify(value)}`;
  return null;
}