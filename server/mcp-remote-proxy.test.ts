import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { gateServer, mcpStdioServer } from "./mcp-gate-config.ts";
import { SERVER_ROOT } from "./proxy-paths.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startFakeHttpMcp, type FakeHttpMcp, type FakeHttpMcpTool } from "./testing/fake-http-mcp-server.ts";
import { makeTestTls, TEST_TLS_HOST } from "./testing/test-tls.ts";
import { createPageSchema } from "./testing/oversized-tool-schema.ts";
import { schemaBytes, TOOL_SCHEMA_PROFILE_ENV } from "./tool-schema-profile.ts";
import { TOOL_LIMIT_ENV } from "./tool-count-limit.ts";

const TOKEN = "disposable-remote-fixture-token";
type Frame = { id?: string | number; method?: string; params?: Record<string, unknown> };

async function remoteFixture(mode: "http" | "event-stream" | "sse") {
  const calls: string[] = [];
  const frames: Frame[] = [];
  const events = new EventEmitter();
  const streams = new Set<ServerResponse>();
  let signalClosed!: () => void;
  const closed = new Promise<void>((resolve) => { signalClosed = resolve; });
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
      if (req.method === "DELETE") { signalClosed(); return res.writeHead(204).end(); }
      if (mode === "sse" && req.method === "GET") {
        streams.add(res);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
        res.on("close", () => { streams.delete(res); signalClosed(); });
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      const frame = JSON.parse(body) as Frame;
      frames.push(frame);
      let result: unknown;
      let error: unknown;
      if (frame.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "disposable", version: "1" } };
      } else if (frame.method === "tools/list") {
        result = frame.params?.cursor === "next" ? { tools: [{ name: "write", inputSchema: { type: "object" } }] }
          : { tools: [{ name: "read", inputSchema: { type: "object" } }, { name: "write", inputSchema: { type: "object" } }], nextCursor: "next" };
      } else if (frame.method === "tools/call") {
        const name = frame.params?.name as string;
        calls.push(name);
        events.emit("call", frame);
        if (frame.params?.arguments && (frame.params.arguments as Record<string, unknown>).hold) {
          if (mode === "sse") res.writeHead(202).end();
          return;
        }
        const refusedWith = (frame.params?.arguments as Record<string, unknown>)?.status;
        if (typeof refusedWith === "number") return res.writeHead(refusedWith).end(TOKEN);
        if ((frame.params?.arguments as Record<string, unknown>)?.error) error = { code: -32000, message: TOKEN };
        else result = { content: [{ type: "text", text: (frame.params?.arguments as Record<string, unknown>)?.large ? "x".repeat(2_000_000) : "read completed" }] };
      } else {
        if (frame.method === "notifications/cancelled") events.emit("cancelled", frame);
        return res.writeHead(202).end();
      }
      const answer = JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...(error ? { error } : { result }) });
      if (mode === "sse") {
        res.writeHead(202).end();
        for (const stream of streams) stream.write(`event: message\ndata: ${answer}\n\n`);
      } else if (mode === "event-stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "disposable-session" });
        res.end(`event: message\ndata: ${answer}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "disposable-session" }).end(answer);
      }
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    spec: { type: mode === "sse" ? "sse" as const : "http" as const, url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } },
    calls, frames, events, closed,
    close: () => new Promise<void>((resolve) => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Above the largest fixture result, so the gate relays every answer whole. */
const GATE_BUDGET = 3_000_000;

describe("gated remote MCP subprocess", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let fixture: Awaited<ReturnType<typeof remoteFixture>> | undefined;
  let scratch: string | undefined;
  let lines: string[];
  let waiter: ((line: string) => void) | undefined;
  let stderr: string;

  function start(descriptor: NonNullable<ReturnType<typeof gateServer>>) {
    lines = [];
    stderr = "";
    child = spawn(descriptor.command, ["--experimental-strip-types", "--no-warnings", ...descriptor.args], {
      stdio: "pipe", env: { ...process.env, ...descriptor.env },
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (waiter) { const consume = waiter; waiter = undefined; consume(line); }
      else lines.push(line);
    });
  }

  function send(frame: Frame) { child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`); }
  async function answer() {
    const line = lines.shift() ?? await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No remote reply: ${stderr}`)), 5_000);
      waiter = (value) => { clearTimeout(timer); resolve(value); };
    });
    return JSON.parse(line);
  }
  async function initialize() {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
    expect((await answer()).result.serverInfo.name).toBe("disposable");
    send({ method: "notifications/initialized" });
  }

  afterEach(async () => {
    waiter = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    child = undefined;
    await fixture?.close(); fixture = undefined;
    if (scratch) await removeTempDir(scratch);
    scratch = undefined;
  });

  it.each(["http", "event-stream", "sse"] as const)("lists and executes over %s with private headers and orderly shutdown", async (mode) => {
    fixture = await remoteFixture(mode);
    const gated = gateServer({ name: "notes", server: fixture.spec, budget: GATE_BUDGET, gateRemote: true, threadId: "fixture" });
    expect(gated!.args.join(" ")).not.toContain(TOKEN);
    expect(gated!.args.join(" ")).not.toContain(fixture.spec.url);
    start(gated!);
    await initialize();
    send({ id: 2, method: "tools/list" });
    expect((await answer()).result).toEqual({ tools: [{ name: "read", inputSchema: { type: "object" } }, { name: "write", inputSchema: { type: "object" } }], nextCursor: "next" });
    send({ id: 3, method: "tools/list", params: { cursor: "next" } });
    expect((await answer()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["write", "query_result"]);
    send({ id: 4, method: "tools/call", params: { name: "write", arguments: {} } });
    expect((await answer()).result.content[0].text).toBe("read completed");
    send({ id: 5, method: "tools/call", params: { name: "read", arguments: {} } });
    expect((await answer()).result.content[0].text).toBe("read completed");
    expect(fixture.calls).toEqual(["write", "read"]);
    const stopped = once(child!, "close"); child!.stdin.end();
    expect((await stopped)[0]).toBe(0);
    await fixture.closed;
    expect(fixture.frames.filter((frame) => frame.method === "notifications/initialized")).toHaveLength(1);
  });

  it.each(["http", "sse"] as const)("cancels an in-flight %s call using its remote request ID", async (mode) => {
    fixture = await remoteFixture(mode);
    start(gateServer({ name: "notes", server: fixture.spec, budget: GATE_BUDGET, gateRemote: true, threadId: "fixture" })!);
    await initialize();
    const reached = once(fixture.events, "call");
    send({ id: "held-request", method: "tools/call", params: { name: "read", arguments: { hold: true } } });
    const [remote] = await reached;
    const cancelled = once(fixture.events, "cancelled");
    send({ method: "notifications/cancelled", params: { requestId: "held-request" } });
    expect((await cancelled)[0].params.requestId).toBe(remote.id);
    expect(await answer()).toMatchObject({ id: "held-request", error: { code: -32800 } });
  });

  it("does not expose credentials from a remote error", async () => {
    fixture = await remoteFixture("http");
    start(gateServer({ name: "notes", server: fixture.spec, budget: GATE_BUDGET, gateRemote: true, threadId: "fixture" })!);
    await initialize();
    send({ id: 2, method: "tools/call", params: { name: "read", arguments: { error: true } } });
    const reply = await answer();
    expect(reply.error).toBeDefined();
    expect(JSON.stringify(reply)).not.toContain(TOKEN);
    expect(stderr).not.toContain(TOKEN);
  });

  it.each([
    [403, "HTTP 403", "permission (scope)"],
    [404, "HTTP 404", "Check its URL"],
    [429, "HTTP 429", "Try again in a moment"],
    [503, "HTTP 503", "Try again later"],
    [418, "Remote MCP request failed (HTTP 418)", "HTTP 418"],
  ])("names HTTP %i from the remote server without its body", async (status, said, hint) => {
    fixture = await remoteFixture("http");
    start(gateServer({ name: "notes", server: fixture.spec, budget: GATE_BUDGET, gateRemote: true, threadId: "fixture" })!);
    await initialize();
    send({ id: 2, method: "tools/call", params: { name: "read", arguments: { status } } });
    const reply = await answer();
    expect(reply.error.code).toBe(-32603);
    expect(reply.error.message).toContain(said);
    expect(reply.error.message).toContain(hint);
    expect(JSON.stringify(reply)).not.toContain(TOKEN);
    expect(JSON.stringify(reply)).not.toContain(fixture.spec.url);
  });

  it("says when the remote server cannot be reached", async () => {
    fixture = await remoteFixture("http");
    start(gateServer({ name: "notes", server: fixture.spec, budget: GATE_BUDGET, gateRemote: true, threadId: "fixture" })!);
    await initialize();
    await fixture.close();
    send({ id: 2, method: "tools/call", params: { name: "read", arguments: {} } });
    const reply = await answer();
    expect(reply.error).toEqual({ code: -32603, message: "Could not reach this MCP server. Check its URL and that it is online." });
    expect(JSON.stringify(reply)).not.toContain(fixture.spec.url);
  });

  it("runs the shipped helpers without a TypeScript source tree", async () => {
    fixture = await remoteFixture("http");
    scratch = mkdtempSync(join(tmpdir(), "omb-remote-bundle-"));
    await build({ entryPoints: ["mcp-gate.ts", "mcp-remote-proxy.ts"].map((name) => join(SERVER_ROOT, name)), outdir: scratch, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const gated = gateServer({ name: "notes", server: fixture.spec, budget: GATE_BUDGET, gateRemote: true, threadId: "fixture" })!;
    gated.args = [join(scratch, "mcp-gate.js")];
    const upstream = JSON.parse(gated.env.OMB_GATE_UPSTREAM);
    upstream.args = [join(scratch, "mcp-remote-proxy.js")];
    gated.env.OMB_GATE_UPSTREAM = JSON.stringify(upstream);
    start(gated);
    await initialize();
    send({ id: 2, method: "tools/call", params: { name: "read", arguments: { large: true } } });
    expect((await answer()).result.content[0].text).toHaveLength(2_000_000);
    expect(fixture.calls).toEqual(["read"]);
  });
});

describe("remote MCP pass-through proxy", () => {
  type Frame = { id?: number | string; method?: string; result?: any; error?: { code: number; message: string } };
  type Descriptor = { command: string; args?: string[]; env?: Record<string, string> };
  let child: ChildProcessWithoutNullStreams | undefined;
  let fake: FakeHttpMcp | undefined;
  let frames: Frame[];
  let arrived: () => void;
  let nextId: number;
  const catalog: FakeHttpMcpTool[] = [
    { name: "payments_list", description: "List payments for a company.", inputSchema: { type: "object", properties: { company_id: { type: "string" } }, required: ["company_id"] } },
    { name: "payments_get", description: "Retrieve one payment by its ID.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
    { name: "members_list", description: "List members of a company.", inputSchema: { type: "object" } },
  ];
  const spec = (url: string) => ({ type: "http" as const, url, headers: { Authorization: "Bearer proxy-fixture-token" } });

  function start(descriptor: Descriptor, inherited: NodeJS.ProcessEnv = process.env) {
    frames = [];
    nextId = 1;
    arrived = () => {};
    child = spawn(descriptor.command, ["--experimental-strip-types", "--no-warnings", ...(descriptor.args ?? [])], {
      stdio: "pipe", env: { ...inherited, ...descriptor.env },
    });
    createInterface({ input: child.stdout }).on("line", (line) => { frames.push(JSON.parse(line)); arrived(); });
  }
  async function take(match: (frame: Frame) => boolean): Promise<Frame> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const index = frames.findIndex(match);
      if (index !== -1) return frames.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`no matching frame: ${JSON.stringify(frames)}`);
      await new Promise<void>((resolve) => { arrived = resolve; setTimeout(resolve, 100); });
    }
  }
  async function request(method: string, params?: unknown): Promise<Frame> {
    const id = nextId++;
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return take((frame) => frame.id === id);
  }
  async function initialize() {
    expect((await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } })).result.serverInfo.name).toBe("fake-http-mcp");
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }
  const call = async (name: string, args?: unknown) => (await request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }));

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    child = undefined;
    await fake?.close(); fake = undefined;
  });

  it("passes a catalog and its calls through unchanged", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    start(mcpStdioServer(spec(fake.url))!);
    await initialize();
    expect((await request("tools/list")).result).toEqual({ tools: catalog });
    expect((await call("payments_list", { company_id: "biz_1" })).result.content[0].text).toBe("remote execution recorded");
  });

  it("fits the tools it lists to the engine's provider profile, and lists them as they came without one", async () => {
    const tools = [{ name: "small", description: "Small.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "create_page", description: "Create a page.", inputSchema: createPageSchema() }];
    fake = await startFakeHttpMcp({ tools });
    start(mcpStdioServer(spec(fake.url))!, { ...process.env, [TOOL_SCHEMA_PROFILE_ENV]: "moonshot" });
    await initialize();
    const [small, page] = (await request("tools/list")).result.tools;
    expect(small).toEqual(tools[0]);
    expect(schemaBytes(page.inputSchema)).toBeLessThanOrEqual(12_000);
    expect(page.description).toContain("OpenMausBot shortened this tool's parameters to fit Kimi's size limit");
    const closed = once(child!, "close"); child!.kill(); await closed;

    start(mcpStdioServer(spec(fake.url))!);
    await initialize();
    expect((await request("tools/list")).result.tools).toEqual(tools);
  });

  it("lists no more of a remote server's tools than its share of the model's tool limit", async () => {
    const tools = ["a", "b", "c"].map((name) => ({ name, inputSchema: { type: "object" } }));
    fake = await startFakeHttpMcp({ tools });
    start(mcpStdioServer(spec(fake.url))!, { ...process.env, [TOOL_LIMIT_ENV]: "1" });
    await initialize();
    expect((await request("tools/list")).result.tools).toEqual(tools.slice(0, 1));
  });

  it("reads its settings from a private record when mounts share one environment", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    const record = `OMB_REMOTE_MCP_CONFIG_${"a".repeat(64)}`;
    const descriptor = mcpStdioServer(spec(fake.url), { configEnvName: record })!;
    expect(descriptor.args!.slice(1)).toEqual(["--config-env", record]);
    expect(Object.keys(descriptor.env!)).toEqual([record]);
    expect(descriptor.args!.join(" ")).not.toContain("proxy-fixture-token");
    start(descriptor);
    await initialize();
    expect((await request("tools/list")).result.tools).toHaveLength(3);
  });

  const withoutProxies = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?_proxy|no_proxy|node_use_env_proxy)$/i.test(name)));

  // A throwaway certificate for an https:// fake, trusted by the proxy child via NODE_EXTRA_CA_CERTS; undefined without openssl.
  const tlsDir = mkdtempSync(join(tmpdir(), "omb-remote-proxy-tls-"));
  const tls = makeTestTls(tlsDir);
  afterAll(() => removeTempDir(tlsDir));

  // The proxy switch is set for https:// servers only, through CONNECT, which works on Node 24 and 26 alike.
  it.skipIf(!tls)("reaches an internet https server through the person's proxy", async () => {
    fake = await startFakeHttpMcp({ tools: catalog, tls });
    const port = Number(new URL(fake.url).port);
    // a CONNECT proxy that knows where the test's "internet" host lives
    const tunnels: string[] = [];
    const forwarded: string[] = [];
    const sockets = new Set<Socket>();
    const proxy = createServer((req, res) => { forwarded.push(req.url ?? ""); res.writeHead(502).end(); });
    proxy.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
      tunnels.push(req.url ?? "");
      sockets.add(client);
      const upstream = connect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const via = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const internet = `https://${TEST_TLS_HOST}:${port}/mcp`;
      start(mcpStdioServer(spec(internet), { sourceEnv: { HTTPS_PROXY: via, NODE_EXTRA_CA_CERTS: tls!.certPath } })!, withoutProxies());
      await initialize();
      expect((await request("tools/list")).result.tools).toHaveLength(3);
      expect(tunnels.length).toBeGreaterThan(0);
      expect(tunnels.every((target) => target === `${TEST_TLS_HOST}:${port}`)).toBe(true);
      expect(forwarded).toEqual([]);
    } finally {
      for (const socket of sockets) socket.destroy();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("reaches a server on this computer directly, past a proxy that could not", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    // nothing listens here: a request sent to this "proxy" is refused
    const unreachable = "http://127.0.0.1:9";
    // an http:// server: no proxy switch at all, so a direct connection
    for (const sourceEnv of [{ HTTP_PROXY: unreachable }, { HTTP_PROXY: unreachable, NO_PROXY: "corp.internal" }]) {
      start(mcpStdioServer(spec(fake.url), { sourceEnv })!, withoutProxies());
      await initialize();
      expect((await request("tools/list")).result.tools).toHaveLength(3);
      const stopped = once(child!, "close"); child!.kill(); await stopped;
    }
    const localhost = fake.url.replace("127.0.0.1", "localhost");
    start(mcpStdioServer(spec(localhost), { sourceEnv: { HTTPS_PROXY: unreachable, HTTP_PROXY: unreachable } })!, withoutProxies());
    await initialize();
    expect((await request("tools/list")).result.tools).toHaveLength(3);
  });

  it.skipIf(!tls)("reaches an https server on this computer directly, past a proxy that could not", async () => {
    fake = await startFakeHttpMcp({ tools: catalog, tls });
    const unreachable = "http://127.0.0.1:9";
    const trust = { NODE_EXTRA_CA_CERTS: tls!.certPath };
    for (const [url, sourceEnv] of [
      [fake.url, { HTTPS_PROXY: unreachable }],
      [fake.url, { HTTPS_PROXY: unreachable, NO_PROXY: "corp.internal" }],
      [fake.url.replace("127.0.0.1", "localhost"), { HTTPS_PROXY: unreachable, HTTP_PROXY: unreachable }],
    ] as const) {
      const descriptor = mcpStdioServer(spec(url), { sourceEnv: { ...sourceEnv, ...trust } })!;
      expect(descriptor.env!.NODE_USE_ENV_PROXY).toBe("1");
      start(descriptor, withoutProxies());
      await initialize();
      expect((await request("tools/list")).result.tools).toHaveLength(3);
      const stopped = once(child!, "close"); child!.kill(); await stopped;
    }
  });

  // Node's env-proxy matcher compares an IPv6 host bracketed, so only the "[::1]" NO_PROXY entry keeps https://[::1] direct.
  it.skipIf(!tls)("reaches an https server on IPv6 loopback directly, never through the proxy", async (ctx) => {
    try {
      fake = await startFakeHttpMcp({ tools: catalog, tls, host: "::1" });
    } catch {
      return ctx.skip(); // no IPv6 loopback on this machine
    }
    // a proxy that records what it is asked and answers nothing
    const tunnels: string[] = [];
    const proxy = createServer((req, res) => { tunnels.push(`${req.method} ${req.url}`); res.writeHead(502).end(); });
    proxy.on("connect", (req: IncomingMessage, client: Socket) => { tunnels.push(`CONNECT ${req.url}`); client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const via = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const descriptor = mcpStdioServer(spec(fake.url), { sourceEnv: { HTTPS_PROXY: via, NODE_EXTRA_CA_CERTS: tls!.certPath } })!;
      expect(descriptor.env!.NODE_USE_ENV_PROXY).toBe("1");
      start(descriptor, withoutProxies());
      const answer = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
      expect(tunnels).toEqual([]);
      // Node 24's fetch checks an https://[::1] certificate against "::1." and refuses it; Node 26 connects.
      if (Number(process.versions.node.split(".")[0]) >= 26) expect(answer.result.serverInfo.name).toBe("fake-http-mcp");
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  // The gate and some engines hand the proxy child this whole environment; Node 24 fails an http:// request through the proxy.
  it("reaches an http server directly when this process turns the proxy switch on", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    const unreachable = "http://127.0.0.1:9";
    const inherited = { ...withoutProxies(), NODE_USE_ENV_PROXY: "1", HTTP_PROXY: unreachable, HTTPS_PROXY: unreachable };
    for (const sourceEnv of [inherited, { NODE_USE_ENV_PROXY: "1" }]) {
      const descriptor = mcpStdioServer(spec(fake.url), { sourceEnv })!;
      expect(descriptor.env!.NODE_USE_ENV_PROXY).toBe("0");
      start(descriptor, inherited);
      await initialize();
      expect((await request("tools/list")).result.tools).toHaveLength(3);
      const stopped = once(child!, "close"); child!.kill(); await stopped;
    }
  });

  it("runs from the shipped bundle", async () => {
    fake = await startFakeHttpMcp({ tools: catalog });
    const scratch = mkdtempSync(join(tmpdir(), "omb-remote-proxy-bundle-"));
    try {
      await build({ entryPoints: [join(SERVER_ROOT, "mcp-remote-proxy.ts")], outdir: scratch, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
      const descriptor = mcpStdioServer(spec(fake.url))!;
      start({ ...descriptor, args: [join(scratch, "mcp-remote-proxy.js")] });
      await initialize();
      expect((await request("tools/list")).result.tools).toHaveLength(3);
      expect((await call("payments_list", { company_id: "biz_1" })).result.content[0].text).toBe("remote execution recorded");
      expect(fake.calls).toEqual([{ name: "payments_list", arguments: { company_id: "biz_1" } }]);
    } finally {
      await removeTempDir(scratch);
    }
  });
});
