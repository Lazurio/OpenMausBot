import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { startFakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { mcpStdioServer } from "../mcp-gate-config.ts";

import extension, {
  allocateToolName,
  StdioMcp,
  toTypebox,
  truncateToolText,
} from "./pi-mcp-extension.ts";

const tempDirs: string[] = [];
const clients: StdioMcp[] = [];
const originalMcpConfig = process.env.OMB_MCP_CONFIG;

type ExtensionApi = Parameters<typeof extension>[0];
type RegisteredTool = Parameters<ExtensionApi["registerTool"]>[0];
type ShutdownHandler = Parameters<ExtensionApi["on"]>[1];

interface SchemaNode {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: SchemaNode[];
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  properties?: Record<string, SchemaNode>;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-pi-mcp-ext-"));
  tempDirs.push(dir);
  return dir;
}

function fakeMcpScript(source: string): string {
  const dir = tempDir();
  const path = join(dir, "fake-mcp.mjs");
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function createClient(source: string, env: Record<string, string> = {}): StdioMcp {
  const client = new StdioMcp({ command: process.execPath, args: [fakeMcpScript(source)], env });
  clients.push(client);
  return client;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.dispose();
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
  if (originalMcpConfig === undefined) delete process.env.OMB_MCP_CONFIG;
  else process.env.OMB_MCP_CONFIG = originalMcpConfig;
});

describe("Pi MCP JSON Schema conversion", () => {
  it("keeps the cua browser_prepare regression schema object-shaped at the root", () => {
    const schema = toTypebox({
      type: "object",
      additionalProperties: true,
      anyOf: [
        { required: ["pid"] },
        {
          properties: {
            allow_launch: { const: true },
            profile: { properties: { mode: { enum: ["isolated_new", "isolated_named"] } } },
          },
          required: ["allow_launch", "profile"],
        },
      ],
      properties: {
        allow_launch: { type: "boolean" },
        pid: { type: "integer" },
        profile: {
          type: "object",
          properties: { mode: { type: "string", enum: ["isolated_new", "isolated_named"] } },
          required: ["mode"],
        },
      },
      required: [],
    });
    const inspected = schema as SchemaNode;

    expect(inspected.type).toBe("object");
    expect(inspected.additionalProperties).toBe(true);
    expect(inspected.properties?.pid.type).toBe("integer");
    expect(inspected.properties?.profile.type).toBe("object");
    expect(inspected.properties?.profile.required).toEqual(["mode"]);
  });

  it("preserves nested combinators, nullability, const and Google-compatible string enums", () => {
    const schema = toTypebox({
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "null" }] },
        flag: { type: ["boolean", "null"] },
        mode: { type: "string", enum: ["ax", "vision"] },
        enabled: { const: true },
      },
      required: ["value"],
    });
    const inspected = schema as SchemaNode;

    expect(inspected.type).toBe("object");
    expect(inspected.required).toEqual(["value"]);
    expect(inspected.properties?.value.anyOf?.map((item) => item.type)).toEqual(["string", "null"]);
    expect(inspected.properties?.flag.anyOf?.map((item) => item.type)).toEqual(["boolean", "null"]);
    expect(inspected.properties?.mode).toMatchObject({ type: "string", enum: ["ax", "vision"] });
    expect(inspected.properties?.enabled).toMatchObject({ type: "boolean", const: true });
  });

  it("collects properties declared only inside root combinator branches", () => {
    const schema = toTypebox({
      oneOf: [
        { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      ],
    });
    const inspected = schema as SchemaNode;

    expect(inspected.type).toBe("object");
    expect(Object.keys(inspected.properties ?? {})).toEqual(["query", "id"]);
    expect(inspected.required).toBeUndefined();
  });

  it("always returns an object schema for malformed, nullable or absent root schemas", () => {
    expect(toTypebox(undefined)).toMatchObject({ type: "object" });
    expect(toTypebox({ anyOf: [] })).toMatchObject({ type: "object" });
    expect(toTypebox({ type: "object", nullable: true })).toMatchObject({ type: "object" });
  });
});

describe("Pi MCP tool names and output bounds", () => {
  it("keeps collision suffixes inside the provider 64-character limit", () => {
    const used = new Set<string>();
    const long = "x".repeat(100);
    const names = Array.from({ length: 12 }, () => {
      const name = allocateToolName("computer", long, used);
      used.add(name);
      return name;
    });

    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length <= 64)).toBe(true);
    expect(names.at(-1)).toMatch(/_12$/);
  });

  it("truncates by lines and UTF-8 bytes without splitting a code point", () => {
    const manyLines = Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n");
    expect(truncateToolText(manyLines)).toContain("2000-line limit");

    const manyAccents = "á".repeat(30_000);
    const truncated = truncateToolText(manyAccents);
    expect(truncated).toContain("50KB limit");
    expect(truncated).not.toContain("�");
  });
});

describe("StdioMcp", () => {
  it("initializes, paginates tools/list, preserves images and truncates text", async () => {
    const client = createClient(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list" && !msg.params?.cursor) send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "page-2" } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "second", inputSchema: { type: "object" } }] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [
            { type: "text", text: "x".repeat(60 * 1024) },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }
          ] } });
        }
      });
    `);

    await client.init();
    await expect(client.listTools()).resolves.toMatchObject([{ name: "first" }, { name: "second" }]);
    const result = await client.callTool("first", {});
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("50KB limit") });
    expect(result.content[1]).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
  });

  it("propagates abort and sends MCP notifications/cancelled", async () => {
    const dir = tempDir();
    const dump = join(dir, "cancel.json");
    const client = createClient(
      `
        import { writeFileSync } from "node:fs";
        let buffer = "";
        process.stdin.setEncoding("utf8");
        const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\\n")) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
            else if (msg.method === "notifications/cancelled") writeFileSync(process.env.DUMP, JSON.stringify(msg.params));
          }
        });
      `,
      { DUMP: dump },
    );
    await client.init();
    const controller = new AbortController();
    const pending = client.callTool("slow", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8"))).toMatchObject({ requestId: 2 }));
  });
});

describe("Pi MCP startup budgets", () => {
  /** Lets real I/O run, the faked clock standing still, until `condition`. */
  async function untilReal(condition: () => boolean): Promise<void> {
    const started = Date.now();
    while (!condition() && Date.now() - started < 15_000) await new Promise((resolve) => setImmediate(resolve));
    expect(condition()).toBe(true);
  }
  function watch<T>(pending: Promise<T>) {
    const state: { done: boolean; value?: T; error?: unknown } = { done: false };
    void pending.then((value) => { state.done = true; state.value = value; }, (error: unknown) => { state.done = true; state.error = error; });
    return state;
  }

  it("gives a server 8 seconds to list its tools", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const remote = await startFakeHttpMcp({ tools: [{ name: "read", inputSchema: { type: "object" } }], toolsDelayMs: 20_000 });
    try {
      const descriptor = mcpStdioServer({ type: "http", url: remote.url, headers: {} })!;
      const plain = new StdioMcp({ command: descriptor.command, args: descriptor.args, env: descriptor.env });
      clients.push(plain);
      const failing = watch(plain.init().then(() => plain.listTools()));
      await untilReal(() => remote.delayedToolsLists === 1);
      await vi.advanceTimersByTimeAsync(8_000);
      await untilReal(() => failing.done);
      expect(String(failing.error)).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
      await remote.close();
    }
  });
});

describe("Pi MCP extension registration", () => {
  it("refuses an unreadable configuration", async () => {
    process.env.OMB_MCP_CONFIG = join(tempDir(), "mcp.json");
    writeFileSync(process.env.OMB_MCP_CONFIG, "not json");
    await expect(extension({ registerTool() {}, on() {} })).rejects.toThrow(/configuration/i);
  });

  it("registers every MCP tool under a collision-free name and calls it by its raw name", async () => {
    const receipt = join(tempDir(), "execution.txt");
    const script = fakeMcpScript(`
      import { createInterface } from "node:readline";
      import { writeFileSync } from "node:fs";
      createInterface({input:process.stdin}).on("line", line => {
        const m = JSON.parse(line); if (m.id === undefined) return;
        let result = {};
        if (m.method === "tools/list") result = {tools:[{name:"read-notes",inputSchema:{type:"object"}},{name:"read_notes",inputSchema:{type:"object"}}]};
        if (m.method === "tools/call") { writeFileSync(process.env.RECEIPT, m.params.name); result = {content:[{type:"text",text:"done"}]}; }
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result}) + "\\n");
      });
    `);
    process.env.OMB_MCP_CONFIG = join(tempDir(), "mcp.json");
    writeFileSync(process.env.OMB_MCP_CONFIG, JSON.stringify({ mcpServers: { mail: { command: process.execPath, args: [script], env: { RECEIPT: receipt } } } }));
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({ registerTool(tool) { tools.push(tool); }, on(event, handler) { handlers.set(event, handler); } });
    try {
      expect(tools.map((tool) => tool.name)).toEqual(["ask_user", "mail_read_notes", "mail_read_notes_2"]);
      await tools[2].execute("call-1", {}, undefined, undefined, { ui: { confirm: async () => { throw new Error("not a host tool: never asks"); } } });
      expect(readFileSync(receipt, "utf8")).toBe("read_notes");
    } finally { await handlers.get("session_shutdown")?.(); }
  });

  it("keeps earlier tools alive when a later registration fails", async () => {
    const script = fakeMcpScript(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
            { name: "good", inputSchema: { type: "object", properties: {} } },
            { name: "bad", inputSchema: { type: "object", properties: {} } }
          ] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "still alive" }] } });
        }
      });
    `);
    const dir = tempDir();
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [script] } } }));
    process.env.OMB_MCP_CONFIG = config;

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({
      registerTool(tool) {
        if (tool.name.endsWith("_bad")) throw new Error("synthetic registration failure");
        tools.push(tool);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["ask_user", "test_good"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("synthetic registration failure"));
    await expect(
      tools[1].execute("call-1", {}, undefined, undefined, { ui: { confirm: async () => true } }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "still alive" }] });
    await handlers.get("session_shutdown")?.();
  });

  it("throws when an MCP tool result declares isError", async () => {
    const script = fakeMcpScript(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "fail", inputSchema: { type: "object", properties: {} } }] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "remote failure" }] } });
        }
      });
    `);
    const dir = tempDir();
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [script] } } }));
    process.env.OMB_MCP_CONFIG = config;

    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({
      registerTool(tool) {
        tools.push(tool);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["ask_user", "test_fail"]);
    await expect(
      tools[1].execute("call-1", {}, undefined, undefined, { ui: { confirm: async () => true } }),
    ).rejects.toThrow("remote failure");
    await handlers.get("session_shutdown")?.();
  });
});

describe("Pi ask_user tool", () => {
  const load = async () => {
    const dir = tempDir();
    process.env.OMB_MCP_CONFIG = join(dir, "mcp.json");
    writeFileSync(process.env.OMB_MCP_CONFIG, JSON.stringify({}));
    const tools: RegisteredTool[] = [];
    await extension({ registerTool(tool) { tools.push(tool); }, on() {} });
    return tools.find((tool) => tool.name === "ask_user");
  };
  // What pi's RPC mode does with each dialog: the driver answers with the
  // picked label, the person's typed words, or a cancel (undefined).
  const dialogs = (replies: Array<string | undefined>) => {
    const asked: Array<{ method: string; title: string; options?: string[] }> = [];
    const next = async () => replies.shift();
    return { asked, ctx: { ui: {
      confirm: async () => false,
      select: async (title: string, options: string[]) => { asked.push({ method: "select", title, options }); return next(); },
      input: async (title: string) => { asked.push({ method: "input", title }); return next(); },
    } } };
  };
  const QUESTIONS = { questions: [
    { question: "Which color?", options: [{ label: "Blue" }, { label: "Green", description: "the calm one" }] },
    { question: "Any notes?" },
  ] };

  it("registers ask_user as a model-only tool", async () => {
    expect(await load()).toMatchObject({ name: "ask_user", exposure: "model-only" });
  });

  it("asks each question in turn and returns the answers in the shared Q:/A: form", async () => {
    const tool = (await load())!;
    const { asked, ctx } = dialogs(["Green", "Ship it on Friday"]);
    const result = await tool.execute("call-1", QUESTIONS, undefined, undefined, ctx);
    expect(asked).toEqual([
      // the description shows under the question; the labels stay exact
      { method: "select", title: "Which color?\n\nGreen: the calm one", options: ["Blue", "Green"] },
      { method: "input", title: "Any notes?" },
    ]);
    expect(result.content).toEqual([{ type: "text", text:
      "The user answered your questions.\n\nQ: Which color?\nA: Green\n\nQ: Any notes?\nA: Ship it on Friday" }]);
  });

  it("returns the person's own words when they answer a select in free text", async () => {
    const tool = (await load())!;
    const result = await tool.execute("call-2", { questions: [QUESTIONS.questions[0]] }, undefined, undefined, dialogs(["Purple, please"]).ctx);
    expect(result.content).toEqual([{ type: "text", text: "The user answered your questions.\n\nQ: Which color?\nA: Purple, please" }]);
  });

  it("says plainly when nobody answered, and stops at the first unanswered question", async () => {
    const tool = (await load())!;
    await expect(tool.execute("call-3", QUESTIONS, undefined, undefined, dialogs([undefined]).ctx)).rejects.toThrow(/did not answer/);
    const partial = dialogs(["Blue", undefined]);
    const result = await tool.execute("call-4", QUESTIONS, undefined, undefined, partial.ctx);
    expect(partial.asked).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Q: Which color?\nA: Blue\n\nThe person did not answer the other questions.") });
  });

  it("refuses multi-select and malformed calls with words the model can act on", async () => {
    const tool = (await load())!;
    const { asked, ctx } = dialogs([]);
    await expect(tool.execute("call-5", { questions: [{ question: "Which?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] }, undefined, undefined, ctx))
      .rejects.toThrow(/one answer per question/);
    await expect(tool.execute("call-6", { questions: [] }, undefined, undefined, ctx)).rejects.toThrow(/malformed/);
    expect(asked).toEqual([]);
  });
});

