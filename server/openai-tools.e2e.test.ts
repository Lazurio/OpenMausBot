import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

type ChatMessage = { role: string; content?: string };
type ChatRequest = {
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string; description?: string } }>;
};

// The chat drivers keep the system message to the stable half of the prompt, so the provider's cached prefix survives a memory write.
const CONTEXT_NOTE = "Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:";
const MEMORY = "Your memory (MEMORY.md):\n# Memory\n- Fixture prefers concise replies.";
// Team availability changes whenever a teammate starts or finishes, so it must never reach the cached system message.
const AVAILABILITY = "Team availability";
function delivered(request: ChatRequest) {
  const system = request.messages.find((message) => message.role === "system")?.content ?? "";
  const turn = request.messages.findLast((message) => message.role === "user")?.content ?? "";
  return { system, turn, all: `${system}\n${turn}` };
}
function expectMemoryInTurn(request: ChatRequest, text: string) {
  const { system, turn } = delivered(request);
  expect(system).not.toContain("Fixture prefers concise replies.");
  expect(turn.slice(0, CONTEXT_NOTE.length + 2)).toBe(`${CONTEXT_NOTE}\n\n`);
  expect(turn).toContain(MEMORY);
  expect(turn.indexOf(MEMORY)).toBeLessThan(turn.lastIndexOf(text));
  expect(turn.slice(-text.length)).toBe(text);
}

  const requests: ChatRequest[] = [];
  let scenario = "text";
  const upstream = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer synthetic-fixture-key") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
      return;
    }
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as ChatRequest;
    requests.push(request);
    if (scenario === "tools-off" && "tools" in request) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "This fixture model supports text only." } }));
      return;
    }
    const call = { index: 0, id: "fixture-call", type: "function", function: { name: "fixture_write_file", arguments: '{"content":"verified"}' } };
    const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame({ content: scenario === "text" ? JSON.stringify(call) : "Hello from the fixture." }, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture provider address missing");
  const fixture = await launchVerificationServer().catch(async (error) => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    throw error;
  });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const api = async (method: string, path: string, body?: unknown, expectedStatus?: number) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    if (expectedStatus !== undefined) expect(response.status, JSON.stringify(result)).toBe(expectedStatus);
    else expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    const saved = await api("PATCH", "/api/config", { [instanceId]: {
      key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1`,
      ...(instanceId === "openaiCompat" ? { model: "fixture-model" } : {}),
    } });
    expect(saved[instanceId].configured).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("synthetic-fixture-key");
    expect(await api("POST", "/api/keys/test", { provider: instanceId })).toMatchObject({ ok: true, check: "models", models: ["fixture-model"] });
    await api("POST", `/api/instances/${instanceId}/refresh-models`, {});
    for (const mode of ["text", "ordinary", "tools-off"]) {
      scenario = mode;
      if (mode === "tools-off") {
        await api("PATCH", `/api/instances/${instanceId}`, { tools: "false" }, 400);
        await api("PATCH", "/api/instances/claude", { tools: false }, 400);
        const changed = await api("PATCH", `/api/instances/${instanceId}`, { tools: false });
        const instance = changed.instances.find((item: any) => item.instanceId === instanceId);
        expect(instance.capabilities).toMatchObject({ agentsMcp: false });
      }
      const { bot } = await control(["new-bot", "--name", `API tool ${mode}`]);
      await control(["set-model", "--bot", bot.id, "--instance", instanceId, "--model", "fixture-model"]);
      await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", description: "Verification assistant", soul: "Use structured tools when an operation is requested." });
      const memoryDirectory = join(fixture.info.dataDir, "workspaces", bot.id);
      mkdirSync(memoryDirectory, { recursive: true });
      writeFileSync(join(memoryDirectory, "MEMORY.md"), "# Memory\n- Fixture prefers concise replies.\n");
      const before = requests.length;
      expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Write the verification artifact if a structured tool is requested."])).success).toBe(true);
      const wait = () => control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20"]);
      const settled = await wait();
      const messages = await control(["messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "20"]);
      const first = delivered(requests[before]!);
      expectMemoryInTurn(requests[before]!, "Write the verification artifact if a structured tool is requested.");
      if (mode === "ordinary") {
        // the earlier modes' bots are this bot's teammates
        expect(first.system).not.toContain(AVAILABILITY);
        expect(first.turn).toContain(AVAILABILITY);
      }
      expect(first.all).not.toContain("update it with your file tools");
      expect(first.all).not.toContain("File locations for this bot");
      expect(first.all).not.toContain("read its exact SKILL.md path above with your file tools");
      if (mode === "tools-off" || mode === "scope-empty") {
      expect(requests).toHaveLength(before + 1);
      expect(settled.status).toBe("settled");
      if (mode === "text") expect(messages.messages.some((message: any) => message.text?.includes("fixture-call"))).toBe(true);
        expect(requests[before]).not.toHaveProperty("tools");
        if (mode === "tools-off") {
          expect(first.all).not.toContain("Use memory_update");
          expect(first.all).not.toContain("session_search tool");
          expect(first.all).not.toContain("The user also added an MCP server");
        }
        expect(messages.messages.some((message: any) => message.tool || message.card)).toBe(false);
      }
      evidence.push({ scenario: mode, status: settled.status, completionRequests: requests.length - before });
      if (mode === "ordinary" || mode === "tools-off") {
        const preview = await api("GET", `/api/bots/${bot.id}/system-prompt`);
        const previewText = JSON.stringify(preview.sections);
        expect(previewText).toContain("Fixture prefers concise replies.");
        expect(previewText).not.toContain("update it with your file tools");
        if (mode === "ordinary") expect(preview.sections.find((section: any) => section.id === "availability")?.text).toContain(AVAILABILITY);
        const { group } = await api("POST", "/api/groups", {
          name: "API memory room", memberIds: [bot.id],
          setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
        });
        await control(["send-channel", "--channel", group.id, "--text", "Greet this room."]);
        expect((await control(["wait", "--channel", group.id, "--timeout", "20"])).status).toBe("settled");
        const room = delivered(requests.at(-1)!);
        expectMemoryInTurn(requests.at(-1)!, `Greet this room.\n\n(Reply to the conversation above as API tool ${mode}.)`);
        expect(room.all).not.toContain("File locations for this bot");
        expect(room.all).not.toContain("update it with your file tools");
        await control(["messages", "--channel", group.id, "--limit", "10"]);
        if (mode === "tools-off") {
          expect(requests.at(-1)).not.toHaveProperty("tools");
          expect(room.all).not.toContain("Use memory_update");
          expect(previewText).not.toContain("Use memory_update");
        }
      }
    }
    const cleared = await api("PATCH", "/api/config", { [instanceId]: { key: "" } });
    expect(cleared[instanceId].configured).toBe(false);
    const fleet = await api("GET", "/api/instances");
    expect(fleet.instances.find((item: any) => item.instanceId === instanceId).snapshot.state).toBe("unavailable");
  } finally {
    const evidencePath = `${fixture.info.logPath}.${instanceId}-tools.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ evidencePath }));
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 120_000);
