import { describe, expect, it } from "vitest";

import type { SendTurnInput } from "../contracts.ts";
import { AGENTS_ENV_HEADER } from "../routes/own-mcp-http-path.ts";
import { TOOL_LIMIT_ENV, TOOL_LIMIT_HEADER } from "../tool-count-limit.ts";
import { TOOL_SCHEMA_PROFILE_ENV } from "../tool-schema-profile.ts";
import { agentsToolList } from "./agents-mcp.ts";
import { acpMcpServers, ownMcpOverHttp } from "./turn-mcp.ts";

const HARNESS = "http://127.0.0.1:8799";
const turn = (extra: Partial<SendTurnInput> = {}): SendTurnInput => ({
  threadId: "t1",
  text: "x",
  integrations: {
    agents: { command: "/usr/local/bin/node", args: ["/app/dist-server/drivers/agents-proxy.js"],
      env: { OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "agents-capability", OMB_BOT_ID: "chief", OMB_THREAD_ID: "t1", OMB_CHIEF_OF_STAFF: "1", NODE_OPTIONS: "--x" } },
    data: { command: "node", args: ["--experimental-strip-types", "/src/server/harness-mcp-proxy.ts", "data"],
      env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_DATA: "data-capability" } },
  },
  ...extra,
} as SendTurnInput);
const env = (server: ReturnType<typeof acpMcpServers>[number]) =>
  Object.fromEntries(("env" in server ? server.env : []).map(({ name, value }) => [name, value]));
const header = (server: ReturnType<typeof acpMcpServers>[number], name: string) =>
  ("headers" in server ? server.headers : []).find((entry) => entry.name === name)?.value;

describe("OpenMausBot's own MCP servers for an engine that reaches servers by URL", () => {
  it("turns each own proxy into this server's endpoint with the same capability", () => {
    const servers = acpMcpServers(turn(), { http: true });
    expect(servers.map((server) => [server.name, "url" in server ? server.url : server.command])).toEqual([
      ["agents", `${HARNESS}/api/internal/mcp-http/agents`],
      ["data", `${HARNESS}/api/internal/mcp-http/data`],
    ]);
    const agents = servers[0] as { type: string; headers: Array<{ name: string; value: string }> };
    expect(agents.type).toBe("http");
    expect(header(servers[0]!, "authorization")).toBe("Bearer agents-capability");
    expect(JSON.parse(Buffer.from(header(servers[0]!, AGENTS_ENV_HEADER)!, "base64url").toString("utf8")))
      .toEqual({ OMB_BOT_ID: "chief", OMB_THREAD_ID: "t1", OMB_CHIEF_OF_STAFF: "1" });
    expect((servers[1] as { headers: unknown }).headers).toEqual([{ name: "authorization", value: "Bearer data-capability" }]);
  });

  it("keeps every proxy process for an engine that does not", () => {
    expect(acpMcpServers(turn()).every((server) => "command" in server)).toBe(true);
  });

  it("recognises only a proxy that reaches this server on loopback and carries its capability", () => {
    const data = { name: "data", command: "node", args: ["/app/dist-server/harness-mcp-proxy.js", "data"], env: { OMB_HARNESS_URL: HARNESS } };
    expect(ownMcpOverHttp(data)).toBeNull();
    expect(ownMcpOverHttp({ ...data, env: { OMB_HARNESS_URL: "http://203.0.113.9:8799", OMB_MCP_TOKEN_DATA: "c" } })).toBeNull();
    expect(ownMcpOverHttp({ ...data, args: ["/app/dist-server/harness-mcp-proxy.js", "shell"], env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_DATA: "c" } })).toBeNull();
    expect(ownMcpOverHttp({ name: "x", command: "node", args: ["/tmp/my-agents-proxy.js.bak"], env: { OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "c" } })).toBeNull();
    expect(ownMcpOverHttp({ ...data, env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_DATA: "c" } })).not.toBeNull();
  });
});

describe("the MCP servers a Kimi Code turn gets", () => {
  it("carry Moonshot's schema profile on every server", () => {
    const servers = acpMcpServers(turn(), { engine: "kimiAgent" });
    expect(servers.map((server) => server.name)).toEqual(["agents", "data"]);
    for (const server of servers) expect([server.name, env(server)[TOOL_SCHEMA_PROFILE_ENV]]).toEqual([server.name, "moonshot"]);
  });

  it("are unchanged for every other engine", () => {
    for (const engine of [undefined, "opencodeGo", "grokAgent", "qwenAgent"]) {
      expect(acpMcpServers(turn(), { engine }).some((server) => TOOL_SCHEMA_PROFILE_ENV in env(server))).toBe(false);
    }
  });
});

describe("the MCP servers of a turn whose model takes a limited number of tools", () => {
  const agentsTools = agentsToolList(turn().integrations!.agents!.env).listed.length;

  it("keeps the agents server's whole list and gives the rest to the other server, over the way that server reads it", () => {
    const servers = acpMcpServers(turn(), { http: true, toolBudget: agentsTools + 10 });
    expect(servers.map((server) => server.name)).toEqual(["agents", "data"]);
    const agents = JSON.parse(Buffer.from(header(servers[0]!, AGENTS_ENV_HEADER)!, "base64url").toString("utf8"));
    expect(agents[TOOL_LIMIT_ENV]).toBe(String(agentsTools));
    expect(header(servers[1]!, TOOL_LIMIT_HEADER)).toBe("10");
  });

  it("trims the agents server too when the budget is smaller than its list", () => {
    const servers = acpMcpServers(turn(), { toolBudget: 5 });
    expect(servers.map((server) => env(server)[TOOL_LIMIT_ENV])).toEqual(["5", "0"]);
  });

  it("leaves every server as it was without a limit", () => {
    for (const server of acpMcpServers(turn(), { http: true })) {
      expect(env(server)[TOOL_LIMIT_ENV]).toBeUndefined();
      expect(header(server, TOOL_LIMIT_HEADER)).toBeUndefined();
    }
  });
});
