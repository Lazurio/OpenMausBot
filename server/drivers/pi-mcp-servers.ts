// The MCP servers a pi turn mounts: OpenMausBot's own, each over stdio.
import type { SendTurnInput } from "../contracts.ts";
import { mcpStdioServer } from "../mcp-gate-config.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

export function buildMcpServers(turn: SendTurnInput): Record<string, unknown> | null {
  const servers: Record<string, unknown> = {};
  if (turn.integrations?.agents) servers.agents = { ...turn.integrations.agents };
  if (turn.integrations?.phone) servers.phone = { ...turn.integrations.phone };
  if (turn.integrations?.dweb) {
    servers.dweb = {
      command: process.execPath,
      args: [SPAWNED_PROXIES.dweb],
      env: { ...NODE_ENV_FLAG, DWEB_URL: turn.integrations.dweb.url },
    };
  }
  if (turn.integrations?.data) servers.data = { ...turn.integrations.data };
  for (const [name, server] of Object.entries(servers)) {
    const stdio = mcpStdioServer(server, { nodeEnv: NODE_ENV_FLAG });
    if (!stdio) throw new Error("Pi MCP server configuration is invalid");
    const original = server as { scope?: string };
    servers[name] = { ...stdio, ...(original.scope ? { scope: original.scope } : {}) };
  }
  return Object.keys(servers).length ? servers : null;
}
