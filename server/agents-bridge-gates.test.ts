// Every mount starts the agents server as the turn's bridge decision built it.
// The prompt is written from that decision, so a mount that rewrote it would
// make the prompt untrue. These are the mounts, each given an integration that
// WAS asked to bridge.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SendTurnInput } from "./contracts.ts";
import { TOOL_BRIDGE_ENV } from "./drivers/agents-bridge.ts";
import { mountChatTools, type ChatToolSession } from "./drivers/chat-mcp-tools.ts";
import { buildMcpServers } from "./drivers/pi-mcp-servers.ts";
import { turnStdioMcpServers } from "./drivers/turn-mcp.ts";
import { gateServer } from "./mcp-gate-config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
type Server = { command: string; args: string[]; env: Record<string, string> };
/** A turn's agents integration as the harness builds it, asked to bridge.
 * Its harness is nowhere: nothing below gets as far as one. */
const BRIDGED: Server = {
  command: process.execPath,
  args: [join(HERE, "drivers", "agents-proxy.ts")],
  env: { OMB_HARNESS_URL: "http://127.0.0.1:9", OMB_BOT_ID: "bot-gated", OMB_THREAD_ID: "thread-gated", OMB_COMMS_TOKEN: "unused", OMB_TURN_DEPTH: "0", [TOOL_BRIDGE_ENV]: "1" },
};

/** The server a gate was told to start. */
const upstreamOf = (gate: { env: Record<string, string> }): Server => JSON.parse(gate.env.OMB_GATE_UPSTREAM!) as Server;

describe("a gate's upstream", () => {
  it("is the server as it came: a gate only trims results", () => {
    // nothing to trim: no gate at all
    expect(gateServer({ name: "agents", server: BRIDGED, threadId: "thread-gated", budget: 0 })).toBeNull();
    expect(upstreamOf(gateServer({ name: "agents", server: BRIDGED, threadId: "thread-gated", budget: 12_000 })!)).toEqual(BRIDGED);
    const other: Server = { command: "npx", args: ["some-server"], env: { TOKEN: "t", [TOOL_BRIDGE_ENV]: "1" } };
    expect(upstreamOf(gateServer({ name: "notes", server: other, threadId: "thread-gated", budget: 12_000 })!)).toEqual(other);
    // the integration the turn holds is not rewritten: the prompt was built from it
    expect(BRIDGED.env[TOOL_BRIDGE_ENV]).toBe("1");
    expect(other.env[TOOL_BRIDGE_ENV]).toBe("1");
  });
});

describe("every mount of the agents server", () => {
  const turn = (): SendTurnInput => ({ threadId: "thread-gated", text: "hi", integrations: { agents: BRIDGED } });

  it("the ACP mounts start it bridged as built", () => {
    expect(turnStdioMcpServers(turn()).find((server) => server.name === "agents")!.env[TOOL_BRIDGE_ENV]).toBe("1");
  });

  it("Pi's mount starts it bridged as built", () => {
    expect((buildMcpServers(turn())!.agents as Server).env[TOOL_BRIDGE_ENV]).toBe("1");
  });

  describe("the chat runtime", () => {
    let session: ChatToolSession | undefined;
    afterEach(async () => { await session?.close(); session = undefined; });

    it("is bridged as built", async () => {
      session = await mountChatTools({ agents: BRIDGED }, new AbortController().signal, false);
      const names = session.definitions.map((definition) => definition.function.name);
      expect(names.slice(-2)).toEqual(["agents_find_tool", "agents_use_tool"]);
      expect(names).not.toContain("agents_create_trigger");
      expect(session.view("agents_use_tool", { name: "list_triggers" })).toMatchObject({ ask: false });
    });
  });
});
