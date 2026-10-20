import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";

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
    expect(text.startsWith("⚠️ TRUNCATED by OpenMausBot:")).toBe(true);

    const spillDir = join(scratch, "spill");
    const [file] = readdirSync(spillDir);
    expect(file).toContain("search_products");
    expect(readFileSync(join(spillDir, file), "utf8")).toBe(full);
    expect(text).not.toContain(join(spillDir, file));

    const kept = JSON.parse(text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n\n⚠️ TRUNCATED")));
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
    const kept = JSON.parse(text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n\n⚠️ TRUNCATED")));
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
    const kept = JSON.parse(text.slice(text.indexOf("\n\n") + 2, text.lastIndexOf("\n\n⚠️ TRUNCATED")));
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
});
