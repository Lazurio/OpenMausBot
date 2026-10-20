// The stdio MCP servers a turn hands an agent (the harness proxies), shared by the ACP
// family and Muse Code.
import type { SendTurnInput } from "../contracts.ts";

export interface TurnStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function turnStdioMcpServers(turn: SendTurnInput): TurnStdioMcpServer[] {
  const servers: TurnStdioMcpServer[] = [];
  const add = (name: string, server: { command: string; args: string[]; env?: Record<string, string> } | undefined) => {
    if (server) servers.push({ name, command: server.command, args: server.args, env: server.env ?? {} });
  };
  add("agents", turn.integrations?.agents);
  add("browser", turn.integrations?.browser);
  add("data", turn.integrations?.data);
  // Cua connections expose Cua Driver's own MCP server.
  add("computer", turn.integrations?.localComputer);
  return servers;
}
