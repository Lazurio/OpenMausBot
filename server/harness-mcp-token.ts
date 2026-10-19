/** Codex starts every MCP server from one shared environment, so each harness family needs its own token variable. */
export function harnessMcpTokenEnv(kind: "computer" | "data"): string {
  return `OMB_MCP_TOKEN_${kind.toUpperCase()}`;
}
