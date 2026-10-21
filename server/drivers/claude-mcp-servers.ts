// The user-scope MCP servers of a Claude turn, which --strict-mcp-config stops Claude Code reading itself: they are
// forwarded verbatim in the turn's own MCP config, as `<cwd>/.mcp.json` is (claude-project-mcp.ts). A malformed file is ignored.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The user scope `claude mcp add --scope user` records in `~/.claude.json` (in `CLAUDE_CONFIG_DIR`, already
 * resolved, when set). Claude Code 2.1.306 reads it only with the `user` setting source, which also brings the
 * person's settings and hooks. */
export function userMcpServers(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return mcpServersIn(join(env.CLAUDE_CONFIG_DIR?.trim() || env.HOME || env.USERPROFILE || homedir(), ".claude.json"));
}

function mcpServersIn(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    if (server && typeof server === "object" && !Array.isArray(server)) out[name] = server;
  }
  return out;
}
