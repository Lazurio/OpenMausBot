import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { createPageSchema } from "./testing/oversized-tool-schema.ts";
import { schemaBytes, TOOL_SCHEMA_PROFILE_ENV } from "./tool-schema-profile.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "mcp-gate.ts");

/** Answers tools/call with whatever its script says and echoes anything else, to prove pass-through. */
const UPSTREAM = `
const { createInterface } = require("node:readline");
const { readFileSync } = require("node:fs");
const reply = JSON.parse(readFileSync(process.env.SCRIPT, "utf8"));
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: reply }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method, params: msg.params ?? null } }) + "\\n");
});
`;

/** Answers every request with what it sees of the gate's settings and of its own configuration. */
const ENV_UPSTREAM = `
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  const result = { gateName: process.env.OMB_GATE_NAME ?? null, upstream: process.env.OMB_GATE_UPSTREAM ?? null, upstreamOnly: process.env.UPSTREAM_ONLY };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`;

/** Answers tools/list with its script as the catalog. */
const LISTING_UPSTREAM = `
const { createInterface } = require("node:readline");
const { readFileSync } = require("node:fs");
const catalog = JSON.parse(readFileSync(process.env.SCRIPT, "utf8"));
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "tools/list" ? catalog : {} }) + "\\n");
});
`;

/** Two pages of tools; every call is appended to SCRIPT.calls and answers with the script's text. */
const PAGED_UPSTREAM = `
const { createInterface } = require("node:readline");
const { appendFileSync, readFileSync } = require("node:fs");
const script = JSON.parse(readFileSync(process.env.SCRIPT, "utf8"));
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const catalog = (params) => params?.cursor === "second"
  ? { tools: [{ name: "write", inputSchema: { type: "object" } }] }
  : { tools: [{ name: "read", inputSchema: { type: "object" } }, { name: "write", inputSchema: { type: "object" } }], nextCursor: "second" };
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "tools/list") return send(msg.id, catalog(msg.params));
  if (msg.method === "tools/call") {
    appendFileSync(process.env.SCRIPT + ".calls", msg.params.name + "\\n");
    return send(msg.id, { content: [{ type: "text", text: script.text ?? "executed" }] });
  }
  send(msg.id, {});
});
`;

describe("mcp-gate", () => {
  let scratch: string;
  let gate: ChildProcessWithoutNullStreams | undefined;
  let lines: string[];
  let waiting: Array<(line: string) => void>;

  const start = (reply: unknown, env: Record<string, string> = {}, source = UPSTREAM) => {
    const script = join(scratch, "reply.json");
    writeFileSync(script, JSON.stringify(reply));
    const upstreamJs = join(scratch, "upstream.cjs");
    writeFileSync(upstreamJs, source);
    gate = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", GATE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OMB_GATE_NAME: "shop",
        OMB_GATE_SPILL_DIR: join(scratch, "spill"),
        OMB_GATE_UPSTREAM: JSON.stringify({
          command: process.execPath,
          args: [upstreamJs],
          env: { SCRIPT: script, UPSTREAM_ONLY: "yes" },
        }),
        ...env,
      },
    }) as ChildProcessWithoutNullStreams;
    createInterface({ input: gate.stdout }).on("line", (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });
  };

  const nextLine = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const buffered = lines.shift();
      if (buffered !== undefined) return resolve(buffered);
      const timer = setTimeout(() => reject(new Error("no frame from the gate")), 15_000);
      const closed = () => {
        clearTimeout(timer);
        reject(new Error("gate closed before replying"));
      };
      gate!.once("close", closed);
      waiting.push((line) => {
        clearTimeout(timer);
        gate!.off("close", closed);
        resolve(line);
      });
    });

  const send = (message: unknown) => gate!.stdin.write(`${JSON.stringify(message)}\n`);

  const call = async (name: string, id = 1) => {
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
    return JSON.parse(await nextLine());
  };

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-gate-test-"));
    lines = [];
    waiting = [];
  });

  afterEach(async () => {
    if (gate && gate.exitCode === null && gate.signalCode === null) {
      const closed = once(gate, "close");
      gate.kill();
      await closed;
    }
    gate = undefined;
    await removeTempDir(scratch);
  });

  it("relays a frame that is not a tool result untouched", async () => {
    start({ content: [{ type: "text", text: "ok" }] });
    send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    expect(JSON.parse(await nextLine())).toEqual({ jsonrpc: "2.0", id: 7, result: { echoed: "tools/list", params: null } });
  });

  it("leaves a small tool result exactly as the server sent it", async () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ cart: { total: 131 } }) }] };
    start(result);
    expect((await call("get_food_cart")).result).toEqual(result);
    expect(existsSync(join(scratch, "spill"))).toBe(false);
  });

  it("trims an oversized result and saves the whole thing for the bot to read", async () => {
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: `Bar ${i}`, blurb: "x".repeat(300) }));
    const full = JSON.stringify({ nextOffset: "1", products });
    start({ content: [{ type: "text", text: full }] });

    const answer = await call("search_products");
    const text = answer.result.content[0].text;
    expect(text.length).toBeLessThan(full.length / 10);
    expect(text.startsWith("⚠️ SHAPED by OpenMausBot:")).toBe(true);

    const spillDir = join(scratch, "spill");
    const [file] = readdirSync(spillDir);
    expect(file).toContain("search_products");
    expect(readFileSync(join(spillDir, file), "utf8")).toBe(full);
    expect(text).not.toContain(join(spillDir, file));

    const kept = JSON.parse(text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n\n⚠️")));
    expect(kept.products[0]).toEqual(products[0]);
    expect(kept.nextOffset).toBe("1");
  });

  it("trims structuredContent alongside the text it duplicates", async () => {
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, blurb: "x".repeat(300) }));
    start({
      content: [{ type: "text", text: JSON.stringify({ products }) }],
      structuredContent: { products },
    });

    const answer = await call("search_products");
    expect(answer.result.structuredContent.products.length).toBeLessThan(300);
    expect(answer.result.structuredContent.products[0]).toEqual(products[0]);
    // the same records as the text, so the two copies never disagree
    const text: string = answer.result.content[0].text;
    const kept = JSON.parse(text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n\n⚠️")));
    expect(answer.result.structuredContent).toEqual(kept);
  });

  it("matches structuredContent to the text whatever its key order", async () => {
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, blurb: "x".repeat(300) }));
    start({
      content: [{ type: "text", text: JSON.stringify({ products, meta: "x" }) }],
      structuredContent: { meta: "x", products },
    });

    const answer = await call("search_products");
    const text: string = answer.result.content[0].text;
    const kept = JSON.parse(text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n\n⚠️")));
    expect(answer.result.structuredContent).toEqual(kept);
  });

  it("honours a budget the harness sets", async () => {
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, blurb: "x".repeat(300) }));
    start({ content: [{ type: "text", text: JSON.stringify({ products }) }], structuredContent: undefined }, { OMB_GATE_BUDGET: "2000" });
    const text = (await call("search_products")).result.content[0].text;
    expect(text.length).toBeLessThan(2_400);
  });

  it("keeps the upstream server's own environment and hides the gate's", async () => {
    start({}, {}, ENV_UPSTREAM);
    send({ jsonrpc: "2.0", id: 3, method: "peek" });
    expect(JSON.parse(await nextLine()).result).toEqual({ gateName: null, upstream: null, upstreamOnly: "yes" });
  });

  it("spawns an upstream named as a bare command on PATH", async () => {
    // `npx -y mcp-remote ...` is an npm shim on Windows, which CreateProcess cannot exec directly.
    const script = join(scratch, "reply.json");
    writeFileSync(script, JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    const upstreamJs = join(scratch, "upstream.cjs");
    writeFileSync(upstreamJs, UPSTREAM);
    gate = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", GATE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OMB_GATE_NAME: "shop",
        OMB_GATE_UPSTREAM: JSON.stringify({ command: "node", args: [upstreamJs], env: { SCRIPT: script } }),
      },
    }) as ChildProcessWithoutNullStreams;
    createInterface({ input: gate.stdout }).on("line", (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });

    expect((await call("get_food_cart")).result).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("relays a result whole when it is a shape the trimmer cannot cut", async () => {
    start({ someOtherShape: "z".repeat(40_000) });
    const answer = await call("weird_tool");
    expect(answer.result.someOtherShape.length).toBe(40_000);
  });

  it("fits each listed schema to the engine's provider profile, and lists tools as they came without one", async () => {
    const catalog = { tools: [{ name: "small", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "create_page", description: "Create a page.", inputSchema: createPageSchema() }] };
    start(catalog, { OMB_GATE_BUDGET: "0", [TOOL_SCHEMA_PROFILE_ENV]: "moonshot" }, LISTING_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const [small, page] = JSON.parse(await nextLine()).result.tools;
    expect(small).toEqual(catalog.tools[0]);
    expect(schemaBytes(page.inputSchema)).toBeLessThanOrEqual(12_000);
    expect(page.description).toMatch(/^Create a page\.\n\n\(OpenMausBot shortened this tool's parameters to fit Kimi's size limit/);
    gate!.kill();
    await once(gate!, "close");

    start(catalog, { OMB_GATE_BUDGET: "0" }, LISTING_UPSTREAM);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.parse(await nextLine()).result).toEqual(catalog);
  });

  describe("shaping an oversized result", () => {
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: `Bar ${i}`, price: 100 + i, blurb: "x".repeat(300) }));
    const full = JSON.stringify({ nextOffset: "1", products });
    const query = async (args: unknown, id: number) => {
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "query_result", arguments: args } });
      return JSON.parse(await nextLine());
    };

    it("lists query_result beside the server's tools only while it trims", async () => {
      start({ text: full }, {}, PAGED_UPSTREAM);
      send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const first = JSON.parse(await nextLine()).result;
      expect(first.tools.map((tool: { name: string }) => tool.name)).toEqual(["read", "write"]);
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "second" } });
      const last = JSON.parse(await nextLine()).result;
      expect(last.tools.map((tool: { name: string }) => tool.name)).toEqual(["write", "query_result"]);
      expect(last.tools[1].annotations.readOnlyHint).toBe(true);
    });

    it("never lists it when the budget is zero", async () => {
      start({ text: full }, { OMB_GATE_BUDGET: "0" }, PAGED_UPSTREAM);
      send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "second" } });
      expect(JSON.parse(await nextLine()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["write"]);
    });

    it("holds the whole result and answers a query locally with just the selection", async () => {
      start({ text: full }, {}, PAGED_UPSTREAM);
      const shaped: string = (await call("read")).result.content[0].text;
      expect(shaped.startsWith("⚠️ SHAPED by OpenMausBot:")).toBe(true);
      expect(shaped).toContain('query_result {"result":"r1","query":');
      expect(shaped).toContain("products: 300 items{id, name, price, blurb}");
      expect(shaped.length).toBeLessThan(8_200);

      const answer = await query({ result: "r1", query: "products[?price > `397`].{name: name, price: price}" }, 2);
      expect(answer.result.isError).toBeUndefined();
      expect(JSON.parse(answer.result.content[0].text)).toEqual([{ name: "Bar 298", price: 398 }, { name: "Bar 299", price: 399 }]);
      // the upstream saw the original call and nothing else
      expect(readFileSync(join(scratch, "reply.json.calls"), "utf8")).toBe("read\n");
    });

    it("cuts a query answer to the same budget, so the whole thing never comes back", async () => {
      start({ text: full }, { OMB_GATE_BUDGET: "2000" }, PAGED_UPSTREAM);
      await call("read");
      const answer = await query({ result: "r1", query: "@" }, 2);
      expect(answer.result.content[0].text.length).toBeLessThan(2_400);
      expect(answer.result.content[0].text).toContain("Narrow the query");
    });

    it("answers a bad handle or query as a tool error without touching upstream", async () => {
      start({ text: full }, {}, PAGED_UPSTREAM);
      expect((await query({ result: "r9", query: "@" }, 1)).result).toMatchObject({ isError: true });
      expect((await query({ query: "@" }, 2)).result).toMatchObject({ isError: true });
      expect(existsSync(join(scratch, "reply.json.calls"))).toBe(false);
    });
  });
});
