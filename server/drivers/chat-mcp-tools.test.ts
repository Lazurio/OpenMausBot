import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { augmentedPath } from "../env-path.ts";
import { ChatToolSessionError, mountChatTools, type ChatToolSession } from "./chat-mcp-tools.ts";
import { wideSchema } from "../testing/oversized-tool-schema.ts";
import { schemaBytes, toolSchemaProfile } from "../tool-schema-profile.ts";

const killProbe = vi.hoisted(() => ({ override: false, stopped: false, budgets: [] as number[] }));
vi.mock("../procs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../procs.ts")>();
  return {
    ...actual,
    // Always runs the real kill for cleanup; the override only forces the verdict and records the budget.
    killCliTree: (child: Parameters<typeof actual.killCliTree>[0], budget = 5_000) => {
      killProbe.budgets.push(budget);
      const run = actual.killCliTree(child, budget);
      return killProbe.override ? run.then(() => killProbe.stopped) : run;
    },
  };
});

const dirs: string[] = [];
const sessions: ChatToolSession[] = [];
const controllers: AbortController[] = [];
const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };

function fixture(body = "", toolSchema: Record<string, unknown> = schema) {
  const dir = mkdtempSync(join(tmpdir(), "omb-chat-mcp-"));
  dirs.push(dir);
  const script = join(dir, "fake-mcp.mjs");
  const receipt = join(dir, "receipt.json");
  writeFileSync(script, `#!/usr/bin/env node
    import { writeFileSync } from "node:fs";
    import { spawn } from "node:child_process";
    const receipt = process.env.RECEIPT;
    const schema = ${JSON.stringify(toolSchema)};
    const calls = [];
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    const reply = (message, result) => send({jsonrpc:"2.0",id:message.id,result});
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        calls.push(message);
        writeFileSync(receipt, JSON.stringify({pid:process.pid,path:process.env.PATH,omb:Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("OMB_"))),calls}));
        ${body}
        if (message.method === "initialize") reply(message, {protocolVersion:"2024-11-05",capabilities:{tools:{}}});
        else if (message.method === "tools/list") reply(message, {tools:[{name:"write",description:"Fixture write",inputSchema:schema}]});
        else if (message.method === "tools/call") reply(message, {content:[{type:"text",text:"recorded:" + message.params.arguments.value}]});
      }
    });
  `);
  chmodSync(script, 0o755);
  const controller = new AbortController();
  controllers.push(controller);
  const server: { command: string; args: string[]; env: Record<string, string> } = { command: script, args: [], env: { RECEIPT: receipt } };
  return {
    dir, receipt, controller, server,
    read: () => JSON.parse(readFileSync(receipt, "utf8")) as { pid: number; path: string; omb: Record<string, string>; calls: Array<{ method: string; params?: { name?: string; arguments?: unknown } }> },
    async mount(computerUse = false) {
      const session = await mountChatTools({ data: server }, controller.signal, computerUse);
      sessions.push(session);
      return session;
    },
  };
}

/** A server that cannot mount fails the turn's setup, and its process is closed. */
async function expectRefused(f: ReturnType<typeof fixture>, reason: RegExp) {
  await expect(f.mount()).rejects.toThrow(reason);
  expect(alive(f.read().pid)).toBe(false);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("Chat MCP session", () => {
  it("mounts Data without computer access and preserves tool arguments", async () => {
    const f = fixture();
    const session = await mountChatTools({ data: f.server }, f.controller.signal, false);
    sessions.push(session);
    expect(session.definitions).toEqual([{ type: "function", function: { name: "data_write", description: "Fixture write", parameters: schema } }]);
    await expect(session.execute("data_write", { value: "query receipt" }, f.controller.signal)).resolves.toEqual({ text: "recorded:query receipt", ok: true });
    expect(f.read().calls.at(-1)).toMatchObject({ method: "tools/call", params: { name: "write", arguments: { value: "query receipt" } } });
  });

  it("discovers without executing, preserves schemas and validates before forwarding original arguments", async () => {
    const f = fixture();
    const session = await f.mount();
    expect(session.definitions).toEqual([{ type: "function", function: { name: "data_write", description: "Fixture write", parameters: schema } }]);
    expect(f.read().calls.map((call) => call.method)).not.toContain("tools/call");
    expect(() => session.validate("data_write", { value: 42 })).toThrow("input schema");
    await expect(session.execute("not_registered", {}, f.controller.signal)).rejects.toThrow("not advertised");
    expect(f.read().calls.map((call) => call.method)).not.toContain("tools/call");
    await expect(session.execute("data_write", { value: "receipt" }, f.controller.signal)).resolves.toEqual({ text: "recorded:receipt", ok: true });
    expect(f.read().calls.at(-1)).toMatchObject({ method: "tools/call", params: { name: "write", arguments: { value: "receipt" } } });
    const pid = f.read().pid;
    await session.close();
    expect(alive(pid)).toBe(false);
    await expect(session.execute("data_write", { value: "again" }, f.controller.signal)).rejects.toThrow("closed");
  });

  it("shows a model behind Moonshot each schema fitted to its limit, and still checks calls against the full one", async () => {
    const full = wideSchema(110);
    const f = fixture("", full);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const plain = await f.mount();
      expect(plain.definitions[0]!.function.parameters).toEqual(full);
      const session = await mountChatTools({ data: f.server }, f.controller.signal, false, undefined, toolSchemaProfile("moonshot"));
      sessions.push(session);
      const [definition] = session.definitions;
      expect(schemaBytes(definition!.function.parameters)).toBeLessThanOrEqual(12_000);
      expect(definition!.function.description).toContain("OpenMausBot shortened this tool's parameters to fit Kimi's size limit");
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^chat-mcp: data: kept only the top-level fields of tool "write"'s parameters/));
      expect(() => session.validate("data_write", { field_000: { label: 5 } })).toThrow("input schema");
      expect(() => session.validate("data_write", { field_000: { label: "five" } })).not.toThrow();
    } finally { warn.mockRestore(); }
  });

  it("starts servers with the widened PATH rather than the bare one the desktop shell inherits", async () => {
    // Launched from Finder, the harness sees only the system directories.
    const widened = augmentedPath();
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const f = fixture();
    await f.mount();
    expect(f.read().path).toBe(widened);
  });

  it("lets a PATH set on the server descriptor win over the widened one", async () => {
    const f = fixture();
    const own = `${augmentedPath()}:/opt/own-tools`;
    f.server.env = { ...f.server.env, PATH: own };
    await f.mount();
    expect(f.read().path).toBe(own);
  });

  it("keeps the operator's control-plane secrets from a chat bot's tool servers, but not what the descriptor grants", async () => {
    const secrets = ["OMB_CLOUD_READY_TOKEN", "OMB_CLOUD_BOOTSTRAP", "OMB_LICENSE_KEY", "OMB_INSTALLATION_CREDENTIAL"];
    for (const name of secrets) vi.stubEnv(name, "should-not-leak");
    vi.stubEnv("OMB_CLOUDFLARED_PATH", "/usr/local/bin/cloudflared");
    const f = fixture();
    f.server.env = { ...f.server.env, OMB_COMMS_TOKEN: "turn-capability" };
    await f.mount();
    const seen = f.read().omb;
    expect(seen).toMatchObject({ OMB_CLOUDFLARED_PATH: "/usr/local/bin/cloudflared", OMB_COMMS_TOKEN: "turn-capability" });
    for (const name of secrets) expect(seen).not.toHaveProperty(name);
  });

  it("mounts only supported descriptors and preserves conversations with no tools", async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const session = await mountChatTools({ phone: { command: "must-not-launch", args: [], env: {} } }, controller.signal);
    sessions.push(session);
    expect(session.definitions).toEqual([]);
    await session.close();
  });

  it("paginates deterministically and keeps colliding names within 64 characters", async () => {
    const long = "x".repeat(100);
    const f = fixture(`
      if (message.method === "tools/list") {
        reply(message, message.params.cursor
          ? {tools:[{name:${JSON.stringify(long + "-second")},inputSchema:schema}]}
          : {tools:[{name:${JSON.stringify(long)},inputSchema:schema}],nextCursor:"second"});
        continue;
      }
    `);
    const session = await f.mount();
    const names = session.definitions.map((tool) => tool.function.name);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => name.length <= 64)).toBe(true);
    expect(names[1]).toMatch(/_2$/);
    expect(f.read().calls.filter((call) => call.method === "tools/list")).toHaveLength(2);
  });

  it.each([
    ["repeated cursor", `reply(message, {tools:[],nextCursor:"same"});`],
    ["too many tools", `reply(message, {tools:Array.from({length:129},(_,i)=>({name:"tool"+i,inputSchema:schema}))});`],
    ["duplicate tool", `reply(message, {tools:[{name:"same",inputSchema:schema},{name:"same",inputSchema:schema}]});`],
    ["invalid RPC", `process.stdout.write('{"result":1}\\n');`],
    ["oversized incomplete frame", `process.stdout.write("x".repeat(2*1024*1024+1));`],
    ["oversized complete frame", `process.stdout.write("x".repeat(2*1024*1024+1) + "\\n");`],
    ["too many response frames", `process.stdout.write("\\n".repeat(10001));`],
    ["oversized tool catalog", `reply(message, {tools:[{name:"write",inputSchema:schema,description:"x".repeat(1024*1024)}]});`],
  ])("fails startup for a server that fails it and awaits child cleanup for %s", async (_label, response) => {
    const f = fixture(`if (message.method === "tools/list") { ${response} continue; }`);
    await expectRefused(f, /MCP/);
  });

  it("rejects untrusted transport error text without leaking it", async () => {
    const f = fixture(`if (message.method === "tools/call") { send({jsonrpc:"2.0",id:message.id,error:{code:-1,message:"secret-fixture-key"}}); continue; }`);
    const session = await f.mount();
    const result = await session.execute("data_write", { value: "test" }, f.controller.signal).catch((error: Error) => error);
    expect(result).toBeInstanceOf(ChatToolSessionError);
    expect(String(result)).toContain("MCP request failed");
    expect(String(result)).not.toContain("secret-fixture-key");
    expect(alive(f.read().pid)).toBe(false);
  });

  it("rejects malformed tool content instead of accepting an empty successful result", async () => {
    const f = fixture(`if (message.method === "tools/call") { reply(message,{content:[{type:"text",text:42}]}); continue; }`);
    const session = await f.mount();
    const pending = session.execute("data_write", {value:"test"}, f.controller.signal);
    await expect(pending).rejects.toBeInstanceOf(ChatToolSessionError);
    await expect(pending).rejects.toThrow("invalid content");
    expect(alive(f.read().pid)).toBe(false);
    expect(() => session.validate("data_write", {value:"test"})).toThrow(ChatToolSessionError);
  });

  it("keeps schema errors recoverable without dispatching or closing the transport", async () => {
    const f = fixture();
    const session = await f.mount();
    const result = await session.execute("data_write", {value:42}, f.controller.signal).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(ChatToolSessionError);
    expect(f.read().calls.some((call) => call.method === "tools/call")).toBe(false);
    await expect(session.execute("data_write", {value:"valid"}, f.controller.signal)).resolves.toMatchObject({ok:true});
  });

  it("returns ordinary MCP tool errors while keeping the session available", async () => {
    const f = fixture(`if(message.method === "tools/call" && message.params.arguments.value === "fail") { reply(message,{isError:true,content:[{type:"text",text:"fixture operation refused"}]}); continue; }`);
    const session = await f.mount();
    await expect(session.execute("data_write", {value:"fail"}, f.controller.signal)).resolves.toEqual({ok:false,text:"fixture operation refused"});
    await expect(session.execute("data_write", {value:"valid"}, f.controller.signal)).resolves.toMatchObject({ok:true});
  });

  it.each([false, true])("does not claim success for an unsupported result (has text: %s)", async (hasText) => {
    const f = fixture(`if(message.method === "tools/call") { reply(message,{content:[${hasText ? '{type:"text",text:"partial result"},' : ''}{type:"image",data:"fixture",mimeType:"image/png"}]}); continue; }`);
    const session = await f.mount();
    const result = await session.execute("data_write", {value:"valid"}, f.controller.signal);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("unsupported MCP content");
    expect(result.text).toContain("inspect its state before retrying");
    if (hasText) expect(result.text).toContain("partial result");
  });

  it("fails setup when one harness mount fails, and closes the others", async () => {
    const ready = fixture();
    const failed = fixture(`if(message.method === "tools/list") { reply(message,{tools:"invalid"}); continue; }`);
    await expect(mountChatTools({ agents: failed.server, data: ready.server }, ready.controller.signal)).rejects.toThrow("invalid result");
    expect(alive(ready.read().pid)).toBe(false);
    expect(alive(failed.read().pid)).toBe(false);
  });

  it("advertises only name, description and parameters, never outputSchema or other MCP tool fields", async () => {
    const f = fixture(`if(message.method === "tools/list") { reply(message,{tools:[{name:"write",title:"W",description:"d",inputSchema:${JSON.stringify(schema)},outputSchema:{type:"object"},annotations:{readOnlyHint:true}}]}); continue; }`);
    const session = await f.mount();
    expect(session.definitions).toEqual([{ type: "function", function: { name: "data_write", description: "d", parameters: schema } }]);
  });

  it("returns declared tool errors and bounds aggregate text without splitting UTF-8", async () => {
    const f = fixture(`if (message.method === "tools/call") { reply(message,{isError:true,content:[{type:"text",text:"á".repeat(30000)},{type:"image",data:"ignored",mimeType:"image/png"}],structuredContent:{status:"failed"}}); continue; }`);
    const session = await f.mount();
    const result = await session.execute("data_write", { value: "test" }, f.controller.signal);
    expect(result.ok).toBe(false);
    expect(Buffer.byteLength(result.text)).toBeLessThan(52_000);
    expect(result.text).toContain("truncated");
    expect(result.text).not.toContain("�");
  });

  it.each(["initialize", "tools/list", "tools/call"])("cancels %s and awaits its owned process tree", async (method) => {
    const f = fixture(`if (message.method === ${JSON.stringify(method)}) {
      const helper = spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
      helper.on("spawn",()=>writeFileSync(receipt,JSON.stringify({pid:process.pid,helper:helper.pid,calls})));
      continue;
    }`);
    const pending = method === "tools/call"
      ? f.mount().then((session) => session.execute("data_write", { value: "test" }, f.controller.signal))
      : f.mount();
    const rejected = expect(pending).rejects.toThrow(/cancelled|closed/);
    let receipt!: { pid: number; helper: number };
    await vi.waitFor(() => {
      receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
      expect(receipt.helper).toBeGreaterThan(0);
    }, { timeout: 10_000 });
    f.controller.abort();
    await rejected;
    expect(alive(receipt.pid)).toBe(false);
    expect(alive(receipt.helper)).toBe(false);
  });
});

describe("Chat MCP shutdown verdict", () => {
  afterEach(() => {
    killProbe.override = false;
    killProbe.stopped = false;
    killProbe.budgets.length = 0;
  });

  it("a slow shutdown resolves close when no call was in flight", async () => {
    const f = fixture();
    const session = await f.mount();
    killProbe.override = true;
    killProbe.stopped = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(session.close()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("chat-mcp:"));
    } finally { warn.mockRestore(); }
  });

  it("an unconfirmed shutdown still fails close when a call was in flight", async () => {
    const f = fixture(`if (message.method === "tools/call") return;`);
    const session = await mountChatTools({ data: f.server }, f.controller.signal);
    const executing = session.execute("data_write", { value: "in flight" }, f.controller.signal).catch(() => {});
    await vi.waitFor(() => { expect(f.read().calls.some((call) => call.method === "tools/call")).toBe(true); });
    killProbe.override = true;
    killProbe.stopped = false;
    await expect(session.close()).rejects.toThrow("MCP server shutdown could not be confirmed; execution outcome may be uncertain");
    await executing;
  });

  it("the close budget is 15 seconds on Windows and 5 seconds elsewhere", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [platform, budget] of [["win32", 15_000], ["linux", 5_000]] as const) {
        const f = fixture();
        const session = await f.mount();
        killProbe.budgets.length = 0;
        Object.defineProperty(process, "platform", { ...descriptor, value: platform });
        try { await session.close(); }
        finally { Object.defineProperty(process, "platform", descriptor); }
        expect(killProbe.budgets.at(-1)).toBe(budget);
      }
    } finally { warn.mockRestore(); }
  });

  it("the session close fails only when a server with an in-flight call could not be stopped", async () => {
    killProbe.override = true;
    killProbe.stopped = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const one = fixture(); const two = fixture();
      const session = await mountChatTools({ agents: one.server, data: two.server }, one.controller.signal);
      sessions.push(session);
      await expect(session.close()).resolves.toBeUndefined();

      const busy = fixture(`if (message.method === "tools/call") return;`);
      const risky = await mountChatTools({ data: busy.server }, busy.controller.signal);
      const executing = risky.execute("data_write", { value: "in flight" }, busy.controller.signal).catch(() => {});
      await vi.waitFor(() => { expect(busy.read().calls.some((call) => call.method === "tools/call")).toBe(true); });
      await expect(risky.close()).rejects.toBeInstanceOf(ChatToolSessionError);
      await expect(risky.close()).rejects.toThrow("MCP server shutdown could not be confirmed; execution outcome may be uncertain");
      await executing;
    } finally { warn.mockRestore(); }
  });
});

const grantFor = (server: string, tool: string) => expect.stringMatching(new RegExp(`^\\["${server}","[0-9a-f]{64}","${tool}"\\]$`));

describe("Chat MCP approvals by server", () => {
  it("asks nothing for OpenMausBot's agents server", async () => {
    const agents = fixture(); const data = fixture();
    const session = await mountChatTools({ agents: agents.server, data: data.server }, agents.controller.signal, true);
    sessions.push(session);
    expect(session.definitions.map((tool) => tool.function.name).sort()).toEqual(["agents_write", "data_write"]);
    expect(session.view("agents_write", { value: "x" })).toEqual({ title: "agents_write", input: { value: "x" }, ask: false });
    expect(session.view("data_write", { value: "x" })).toEqual({ title: "data_write", input: { value: "x" }, ask: true, grant: grantFor("data", "write") });
  });

  it("ties an allow to the server as launched: the same server keeps it, a changed one under the same name does not", async () => {
    const audit = fixture(); const other = fixture();
    const grant = async (server: typeof audit.server) => {
      const session = await mountChatTools({ data: server }, audit.controller.signal);
      sessions.push(session);
      return session.view("data_write", { value: "x" }).grant;
    };
    const first = await grant(audit.server);
    expect(first).toEqual(grantFor("data", "write"));
    expect(await grant({ ...audit.server, env: { ...audit.server.env } })).toBe(first);
    expect(await grant(other.server)).not.toBe(first);
    expect(await grant({ ...audit.server, env: { ...audit.server.env, AUDIT_TOKEN: "rotated" } })).not.toBe(first);
    expect(first).not.toContain("rotated");
  });
});

describe("Chat MCP startup budgets", () => {
  /** Lets real I/O run, the faked clock standing still, until `condition`. */
  async function untilReal(condition: () => boolean): Promise<void> {
    const started = Date.now();
    while (!condition() && Date.now() - started < 15_000) await new Promise((resolve) => setImmediate(resolve));
    expect(condition()).toBe(true);
  }
  /** Past a deadline: steps the faked clock too, by at most `budgetMs`, pausing in real time so a process can exit. */
  async function settleWithin(budgetMs: number, condition: () => boolean): Promise<void> {
    for (let spent = 0; !condition() && spent < budgetMs; spent += 25) {
      const until = Date.now() + 20;
      while (Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(25);
    }
    expect(condition()).toBe(true);
  }
  function watch<T>(pending: Promise<T>) {
    const state: { done: boolean; value?: T; error?: unknown } = { done: false };
    void pending.then((value) => { state.done = true; state.value = value; }, (error: unknown) => { state.done = true; state.error = error; });
    return state;
  }

  it("gives a command server 8 seconds to list its tools", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = fixture(`if (message.method === "tools/list") return;`);
      const mounting = watch(f.mount());
      const listed = () => { try { return f.read().calls.some((call) => call.method === "tools/list"); } catch { return false; } };
      await untilReal(listed);
      await vi.advanceTimersByTimeAsync(7_900);
      expect(mounting.done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      // stopped at 8 seconds
      await settleWithin(1_000, () => mounting.done);
      expect(String(mounting.error)).toMatch(/timed out/);
    } finally { vi.useRealTimers(); }
  });
});

describe("Chat MCP schema validation", () => {
  it("retains native unsigned/composition constraints while exposing an object schema", async () => {
    const f = fixture("", { type: "object", properties: { value: { type: "integer", format: "uint32" } },
      anyOf: [{ required: ["value"] }], additionalProperties: false });
    const session = await f.mount(true);
    expect(session.definitions[0].function.parameters).not.toHaveProperty("anyOf");
    expect(session.definitions[0].function.description).toContain('"anyOf"');
    expect(() => session.validate("data_write", {})).toThrow("input schema");
    expect(() => session.validate("data_write", { value: -1 })).toThrow("input schema");
    expect(() => session.validate("data_write", { value: 2 ** 32 })).toThrow("input schema");
    expect(() => session.validate("data_write", { value: 42 })).not.toThrow();
  });

  it("carries large images from the Data server", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=", "base64");
    const chunk = Buffer.alloc(2 * 1024 * 1024 + 12);
    chunk.writeUInt32BE(chunk.length - 12, 0); chunk.write("tEXt", 4); chunk.write("fixture\0", 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const data = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]).toString("base64");
    const f = fixture('if(message.method === "tools/call") { reply(message,{content:[{type:"image",mimeType:"image/png",data:process.env.IMAGE}]}); continue; }');
    f.server.env.IMAGE_FILE = join(f.dir, "image.txt");
    writeFileSync(f.server.env.IMAGE_FILE, data);
    writeFileSync(join(f.dir, "fake-mcp.mjs"), readFileSync(join(f.dir, "fake-mcp.mjs"), "utf8").replace('import { writeFileSync }', 'import { writeFileSync, readFileSync }').replace('process.env.IMAGE', 'readFileSync(process.env.IMAGE_FILE,"utf8")'));
    const session = await f.mount(true);
    const result = await session.execute("data_write", { value: "screenshot" }, f.controller.signal);
    expect(result).toEqual({ ok: true, text: "Screenshot captured.", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }] });
  });

  it("keeps a bounded frame limit for image-enabled servers", async () => {
    const f = fixture('if(message.method === "tools/call") { process.stdout.write("x".repeat(32*1024*1024+1)); continue; }');
    const session = await f.mount(true);
    await expect(session.execute("data_write", { value: "large" }, f.controller.signal)).rejects.toThrow(/frame|limit/i);
  });

  it("rejects malformed image results without claiming execution success", async () => {
    const f = fixture('if(message.method === "tools/call") { reply(message,{content:[{type:"image",mimeType:"image/png",data:"not-base64"}]}); continue; }');
    const session = await f.mount(true);
    await expect(session.execute("data_write", { value: "screenshot" }, f.controller.signal)).rejects.toThrow("Invalid or oversized MCP image");
  });
  it.each([
    { type: "object", properties: { value: { type: "string", minLength: 2 } }, required: ["value"] },
    { type: "object", properties: { value: { type: "string", enum: ["a"], minLength: 2 } }, required: ["value"] },
    { type: "object", properties: { value: { type: "array", minItems: 2 } }, required: ["value"] },
    { type: "object", properties: { value: { type: "string", default: "fallback" } }, required: ["value"] },
    { type: "object", required: ["value"] },
    { type: "object", properties: { value: { type: "array", items: {type:"string"}, uniqueItems: true } }, required: ["value"] },
  ])("enforces original constraints without defaults or coercion %#", async (toolSchema) => {
    const f = fixture("", toolSchema);
    const session = await f.mount();
    const invalid = "enum" in (toolSchema.properties?.value ?? {}) ? {value:"a"}
      : "uniqueItems" in (toolSchema.properties?.value ?? {}) ? {value:["a","a"]}
        : toolSchema.properties?.value.type === "array" ? {value:[]}
          : "minLength" in (toolSchema.properties?.value ?? {}) ? {value:"😀"} : {};
    expect(() => session.validate("data_write", invalid)).toThrow("input schema");
    expect(f.read().calls.some((call) => call.method === "tools/call")).toBe(false);
    expect(session.definitions[0].function.parameters).toEqual(toolSchema);
  });

  it("retains composition and draft 2020-12 constraints", async () => {
    const toolSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
      properties: { value: {type:"array",items:{type:"number"},contains:{const:2},minContains:1} },
      required: ["value"], additionalProperties: false,
    };
    const f = fixture("", toolSchema);
    const session = await f.mount();
    expect(() => session.validate("data_write", {value:[1]})).toThrow("input schema");
    expect(() => session.validate("data_write", {value:[2]})).not.toThrow();
  });

  it("accepts GitHub MCP's x-mcp-header annotation and still enforces the schema", async () => {
    const toolSchema = {
      type: "object",
      properties: { owner: { type: "string", "x-mcp-header": "owner" }, repo: { type: "string", "x-mcp-header": "repo" } },
      required: ["owner", "repo"],
    };
    const f = fixture("", toolSchema);
    const session = await f.mount();
    expect(() => session.validate("data_write", { owner: "octo", repo: "hello" })).not.toThrow();
    expect(() => session.validate("data_write", { owner: "octo" })).toThrow("input schema");
    expect(() => session.validate("data_write", { owner: 1, repo: "hello" })).toThrow("input schema");
  });

  it("accepts Google MCP's x-google-enum-descriptions annotation and still enforces the enum", async () => {
    const toolSchema = {
      type: "object",
      properties: {
        value: { type: "string", enum: ["METRIC", "IMPERIAL"], "x-google-enum-descriptions": ["Metric units.", "Imperial units."] },
      },
      required: ["value"],
    };
    const f = fixture("", toolSchema);
    const session = await f.mount();
    expect(() => session.validate("data_write", { value: "METRIC" })).not.toThrow();
    expect(() => session.validate("data_write", { value: "KELVIN" })).toThrow("input schema");
  });

  it.each([
    ["email", "user@example.com", "invalid"],
    ["uri", "https://example.com/path", "not a uri"],
    ["date-time", "2026-09-13T12:00:00Z", "2026-13-41"],
  ])("enforces the standard %s format", async (format, valid, invalid) => {
    const f = fixture("", {type:"object",properties:{value:{type:"string",format}},required:["value"]});
    const session = await f.mount();
    expect(() => session.validate("data_write", {value:valid})).not.toThrow();
    expect(() => session.validate("data_write", {value:invalid})).toThrow("input schema");
  });

  it.each([
    { type: "object", properties: {value:{type:"string",format:"unregistered-format"}} },
    { type: "object", properties: {value:{$ref:"https://example.invalid/private-schema"}} },
    { type: "object", properties: {value:{type:"string",unrecognizedAssertion: true}} },
    { type: "object", properties: {value:{type:"string","x-mcp-header": 5}} },
    { type: "object", properties: {value:{type:"string","x-google-enum-descriptions": "not a list"}} },
  ])("refuses schemas it cannot validate instead of silently weakening them %#", async (toolSchema) => {
    const f = fixture("", toolSchema);
    await expectRefused(f, /schema could not be validated/);
  });

  it("honors the configured per-call timeout instead of the fixed default", async () => {
    const delayed = `if (message.method === "tools/call") { setTimeout(() => reply(message, {content:[{type:"text",text:"recorded:"+message.params.arguments.value}]}), 400); return; }`;
    const f = fixture(delayed);
    const short = await mountChatTools({ data: f.server }, f.controller.signal, false, 100);
    sessions.push(short);
    await expect(short.execute("data_write", { value: "x" }, f.controller.signal)).rejects.toThrow("MCP request timed out");
    await expect(f.read().calls.filter((call) => call.method === "tools/call")).toHaveLength(1);

    const long = await mountChatTools({ data: f.server }, f.controller.signal, false, 5_000);
    sessions.push(long);
    await expect(long.execute("data_write", { value: "y" }, f.controller.signal)).resolves.toMatchObject({ ok: true, text: "recorded:y" });
  });
});
