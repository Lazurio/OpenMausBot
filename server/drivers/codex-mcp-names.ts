import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseToml } from "../toml-lite.ts";

const HEADER = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))[ \t]*[.\]]/gm;

/** Inline tables are not scanned; a collision there still surfaces as codex's own configuration error. */
export function mcpServerNamesInToml(toml: string): Set<string> {
  const names = new Set<string>();
  for (const match of toml.matchAll(HEADER)) {
    const name = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2] ?? match[3];
    if (name) names.add(name);
  }
  return names;
}

/** config.toml's servers: every name it declares, and each one's table where the file can be read. */
export interface CodexConfigMcp {
  names: Set<string>;
  tables: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function codexConfigMcp(env: Record<string, string | undefined>): CodexConfigMcp {
  const codexHome = env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".codex");
  let text = "";
  try {
    text = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {}
  let tables: Record<string, unknown> = {};
  try {
    const servers = parseToml(text).mcp_servers;
    if (isRecord(servers)) tables = servers;
  } catch {}
  return { names: mcpServerNamesInToml(text), tables };
}

export function codexConfigMcpServerNames(env: Record<string, string | undefined>): Set<string> {
  return codexConfigMcp(env).names;
}
