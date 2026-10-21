// Lazurio overlay (DEV-6673 M3 and M4a, issue #35): settings of features removed from Lazurio's distribution.
// A saved config.json that still has them loads and drops them (the config schema strips unknown keys);
// a write that names one (PUT /api/config) is refused as a whole, never half-applied.
import type { JsonValue } from "./schema.ts";

const REMOVED_CONFIG_KEYS: ReadonlyArray<readonly string[]> = [
  ["box"], ["vps"], ["localVm"], ["composio"], ["mcpServers"], ["features", "sharedComputers"],
  ...["computer", "cloudBackend", "autoStartVps", "composio", "mcpServers"].map((key) => ["newBotDefaults", "profile", key]),
  // DEV-6673, LAZURIO.md principle 2: bots contact each other without a person's approval.
  ["newBotDefaults", "profile", "approvePeerComms"],
  // DEV-6673, LAZURIO.md principle 3: every bot gets the Environment's tools; there is no per-bot tool selection.
  ["newBotDefaults", "profile", "toolScope"],
  // DEV-6673, LAZURIO.md principles 3 and 5: Claude bots always load the Environment's Claude Code MCP servers.
  ["features", "claudeUserMcp"],
  // DEV-6673 M4a: MausBot's own browser; bots work in the Environment browser.
  ["browserEngine"], ["browserProfiles"], ["features", "browser"],
  ...["browser", "browserProfile"].map((key) => ["newBotDefaults", "profile", key]),
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

// Request fields of removed gates (DEV-6673, LAZURIO.md principle 2): the confirmation upstream's Auto warning asked
// for, the switch that made a bot ask a person before contacting another bot, and the desktop's approval grant.
// And the per-bot tool selection (LAZURIO.md principle 3): every bot gets the tools the Environment provides.
const REMOVED_BOT_FIELDS: readonly string[] = ["acknowledgeLocalAuto", "approvePeerComms", "approvalGrant", "toolScope"];

/** A field or value a bot or thread write names that Lazurio removed (DEV-6673), or null; such a write is refused with 400. */
export function removedBotSetting(settings: unknown): string | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const record = settings as Record<string, unknown>;
  for (const key of REMOVED_BOT_FIELDS) if (Object.hasOwn(record, key)) return key;
  for (const [key, value] of REMOVED_BOT_VALUES) if (record[key] === value) return `${key} ${JSON.stringify(value)}`;
  return null;
}

export const removedBotSettingError = (removed: string) => `${removed} is not available in this distribution (it was removed)`;

const WRITES = new Set(["POST", "PUT", "PATCH"]);

/** Every bot and thread write (POST, PUT or PATCH under /api/bots) reads its body through this, so a body that names
 * a removed field or value, at its top or in its `settings`, is refused with 400 before any route changes anything. */
export function refusingRemovedBotSettings<C extends { method: string; path: string; readBody: (...args: any[]) => Promise<any> }>(ctx: C): C {
  if (!WRITES.has(ctx.method) || (ctx.path !== "/api/bots" && !ctx.path.startsWith("/api/bots/"))) return ctx;
  const read = ctx.readBody;
  const readBody = async (...args: unknown[]) => {
    const body = await read(...args);
    const removed = removedBotSetting(body) ?? (body && typeof body === "object" ? removedBotSetting((body as Record<string, unknown>).settings) : null);
    if (removed) throw Object.assign(new Error(removedBotSettingError(removed)), { status: 400 });
    return body;
  };
  return { ...ctx, readBody: readBody as C["readBody"] };
}
