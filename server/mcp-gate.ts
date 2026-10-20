// stdout is the MCP transport. Never log there.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { resolveCliSpawn } from "./env-path.ts";
import { QUERY_TOOL, QUERY_TOOL_NAME, ResultStore, answerQuery, describeShape, exampleQuery } from "./mcp-shape.ts";
import { fitToolList } from "./mcp-tool-schema.ts";
import { DEFAULT_RESULT_BUDGET, type HeldResult, trimResultText, trimStructured } from "./mcp-trim.ts";
import { killCliTree } from "./procs.ts";
import { toolSchemaProfileFromEnv } from "./tool-schema-profile.ts";
import { capToolListResult, toolLimitFromEnv } from "./tool-count-limit.ts";

type Json = Record<string, unknown>;

const NAME = process.env.OMB_GATE_NAME || "mcp";
const SPILL_DIR = process.env.OMB_GATE_SPILL_DIR || "";
const rawBudget = Number(process.env.OMB_GATE_BUDGET);
const BUDGET = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : DEFAULT_RESULT_BUDGET;
const SPILL_MAX_AGE_MS = 24 * 60 * 60_000;
const SPILL_HINT = process.env.OMB_GATE_SPILL_HINT === "1";
const SCHEMA_PROFILE = toolSchemaProfileFromEnv(process.env);
const TOOL_LIMIT = toolLimitFromEnv(process.env);

function fail(message: string): never {
  process.stderr.write(`mcp-gate(${NAME}): ${message}\n`);
  process.exit(1);
}

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requestKey(id: unknown): string | undefined {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
    ? `${typeof id}:${id}` : undefined;
}

interface Upstream {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function upstreamSpec(): Upstream {
  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env.OMB_GATE_UPSTREAM ?? "");
  } catch {
    fail("OMB_GATE_UPSTREAM is not valid JSON");
  }
  const spec = parsed as Upstream | null;
  if (!spec || typeof spec !== "object" || typeof spec.command !== "string" || !spec.command) {
    fail("OMB_GATE_UPSTREAM needs a command");
  }
  return spec;
}

function sweepSpill(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SPILL_MAX_AGE_MS;
  for (const entry of entries) {
    try {
      const path = join(dir, entry);
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
    }
  }
}

let spilled = 0;
/** Whole results the model can query instead of re-reading: one gate, one MCP connection, one session. */
const store = new ResultStore();

/** Keep the parsed payload for query_result; only a JSON result can be queried, text is cut as before. */
function hold(tool: string, text: string): HeldResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const handle = store.put(tool, value, text.length);
  return { handle, shape: describeShape(value), example: exampleQuery(value) };
}

function spill(tool: string, text: string): string | undefined {
  if (!SPILL_DIR) return undefined;
  const safeTool = tool.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60) || "tool";
  const path = join(SPILL_DIR, `${Date.now()}-${process.pid}-${spilled++}-${safeTool}.json`);
  try {
    mkdirSync(SPILL_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  } catch (error) {
    process.stderr.write(`mcp-gate(${NAME}): could not save the full result: ${String(error)}\n`);
    return undefined;
  }
}

/** Object key order aside (a server may build the two copies differently); array order counts. */
function sameJson(text: string, value: unknown): boolean {
  try {
    return sameValue(JSON.parse(text), value, 0);
  } catch {
    return false;
  }
}

function sameValue(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (depth > 200 || !a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i], depth + 1));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key], depth + 1));
}

function trimCallResult(result: Json, tool: string): boolean {
  if (BUDGET === 0) return false;
  const content = result.content;
  if (!Array.isArray(content)) return false;

  const textBlocks = content.filter(
    (block): block is Json & { text: string } =>
      Boolean(block) && typeof block === "object" && (block as Json).type === "text" && typeof (block as Json).text === "string",
  );
  const total = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
  if (!textBlocks.length || total <= BUDGET) return false;

  const share = Math.floor(BUDGET / textBlocks.length);
  const path = spill(tool, textBlocks.map((block) => block.text).join("\n"));
  const held = textBlocks.length === 1 ? hold(tool, textBlocks[0]!.text) : undefined;
  const structuredIsText = textBlocks.length === 1 && Boolean(result.structuredContent) && typeof result.structuredContent === "object"
    && sameJson(textBlocks[0]!.text, result.structuredContent);
  let trimmed = false;
  let keptValue: unknown;
  for (const block of textBlocks) {
    const outcome = trimResultText({ text: block.text, budget: share, spillPath: path, spillHint: SPILL_HINT, toolName: tool, held });
    if (!outcome.trimmed) continue;
    block.text = outcome.text;
    keptValue = outcome.value;
    trimmed = true;
  }

  // Trim structuredContent too, or the provider gets a second full copy; structurally only, so it stays valid against the output schema.
  if (trimmed && result.structuredContent && typeof result.structuredContent === "object") {
    if (structuredIsText && keptValue && typeof keptValue === "object") {
      result.structuredContent = keptValue as Json;
    } else {
      const structured = trimStructured(result.structuredContent, BUDGET);
      if (structured) result.structuredContent = structured.value as Json;
    }
  }
  return trimmed;
}

const spec = upstreamSpec();
if (SPILL_DIR) sweepSpill(SPILL_DIR);

const childEnv: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
for (const key of Object.keys(childEnv)) if (key.startsWith("OMB_GATE_")) delete childEnv[key];

// CreateProcess cannot exec an npm .cmd shim or a node-shebang script, and a shell would re-interpret JSON argv.
const resolved = resolveCliSpawn(spec.command, spec.args ?? []);
const child = spawn(resolved.command, resolved.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
  shell: false,
  // a console app spawned from the desktop shell flashes a window otherwise
  ...(process.platform === "win32" ? { windowsHide: true } : {}),
});

// The real server must not outlive a killed gate, and on Windows only taskkill /T reaps a tree.
let reaping = false;
const reapChild = () => {
  if (reaping) return;
  reaping = true;
  void killCliTree(child);
};
process.on("SIGTERM", () => {
  reapChild();
  process.exit(0);
});
process.on("SIGINT", () => {
  reapChild();
  process.exit(0);
});
process.on("exit", reapChild);

child.on("error", (error) => {
  process.stderr.write(`mcp-gate(${NAME}): could not start ${resolved.command}: ${String(error)}\n`);
  process.exit(1);
});
child.stderr.pipe(process.stderr);

type Pending = { kind: "call"; tool: string } | { kind: "list" };

/** JSON-RPC string and numeric IDs are separate, even when their text is equal. */
const pending = new Map<string, Pending>();

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: Json | undefined;
  if (line.trim()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) message = parsed;
    } catch {}
  }
  const id = requestKey(message?.id);
  const params = isRecord(message?.params) ? message.params : undefined;
  // The gate's own read-only tool: it reads a held result and never reaches upstream.
  if (BUDGET > 0 && message?.method === "tools/call" && params?.name === QUERY_TOOL_NAME) {
    if (!id) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answerQuery(store, params.arguments, BUDGET) })}\n`);
    return;
  }
  if (id && message?.method === "tools/call") {
    pending.set(id, { kind: "call", tool: typeof params?.name === "string" ? params.name : "tool" });
  } else if (id && message?.method === "tools/list") {
    pending.set(id, { kind: "list" });
  }
  child.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => child.stdin.end());

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let message: Json | undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed)) message = parsed;
  } catch {}
  if (!message) {
    process.stdout.write(`${line}\n`);
    return;
  }
  const id = typeof message.method === "string" ? undefined : requestKey(message.id);
  const request = id === undefined ? undefined : pending.get(id);
  if (id !== undefined) pending.delete(id);
  const result = message.result;
  if (SCHEMA_PROFILE && request?.kind === "list" && message.error === undefined && isRecord(result) && Array.isArray(result.tools)) {
    result.tools = fitToolList(result.tools, SCHEMA_PROFILE, (note) => process.stderr.write(`mcp-gate(${NAME}): ${note}\n`));
  }
  if (BUDGET > 0 && request?.kind === "list" && message.error === undefined && isRecord(result) && Array.isArray(result.tools) && result.nextCursor === undefined) {
    result.tools = [...result.tools.filter((tool: unknown) => !isRecord(tool) || tool.name !== QUERY_TOOL_NAME), QUERY_TOOL];
  }
  if (TOOL_LIMIT !== undefined && request?.kind === "list" && message.error === undefined && isRecord(result)) {
    message.result = capToolListResult(result, TOOL_LIMIT, (note) => process.stderr.write(`mcp-gate(${NAME}): ${note}\n`));
  }
  if (request?.kind === "call" && isRecord(result)) {
    try {
      if (trimCallResult(result, request.tool)) {
        process.stderr.write(`mcp-gate(${NAME}): trimmed ${request.tool} to ${BUDGET} chars\n`);
      }
    } catch (error) {
      process.stderr.write(`mcp-gate(${NAME}): could not trim ${request.tool}: ${String(error)}\n`);
      process.stdout.write(`${line}\n`);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
