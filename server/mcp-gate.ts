// stdout is the MCP transport. Never log there.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { resolveCliSpawn } from "./env-path.ts";
import { DEFAULT_RESULT_BUDGET, trimResultText, trimStructured } from "./mcp-trim.ts";
import { killCliTree } from "./procs.ts";

type Json = Record<string, unknown>;

const NAME = process.env.OMB_GATE_NAME || "mcp";
const SPILL_DIR = process.env.OMB_GATE_SPILL_DIR || "";
const rawBudget = Number(process.env.OMB_GATE_BUDGET);
const BUDGET = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : DEFAULT_RESULT_BUDGET;
const SPILL_MAX_AGE_MS = 24 * 60 * 60_000;
const SPILL_HINT = process.env.OMB_GATE_SPILL_HINT === "1";

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
  const structuredIsText = textBlocks.length === 1 && Boolean(result.structuredContent) && typeof result.structuredContent === "object"
    && sameJson(textBlocks[0]!.text, result.structuredContent);
  let trimmed = false;
  let keptValue: unknown;
  for (const block of textBlocks) {
    const outcome = trimResultText({ text: block.text, budget: share, spillPath: path, spillHint: SPILL_HINT, toolName: tool });
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

/** Tool names by JSON-RPC request; string and numeric IDs are separate, even when their text is equal. */
const pending = new Map<string, string>();

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: Json | undefined;
  if (line.trim()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) message = parsed;
    } catch {
    }
  }
  const id = requestKey(message?.id);
  if (id && message?.method === "tools/call") {
    const params = isRecord(message.params) ? message.params : undefined;
    pending.set(id, typeof params?.name === "string" ? params.name : "tool");
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
  } catch {
  }
  if (!message) {
    process.stdout.write(`${line}\n`);
    return;
  }
  const id = typeof message.method === "string" ? undefined : requestKey(message.id);
  const tool = id === undefined ? undefined : pending.get(id);
  if (id !== undefined) pending.delete(id);
  const result = message.result;
  if (tool !== undefined && isRecord(result)) {
    try {
      if (trimCallResult(result, tool)) {
        process.stderr.write(`mcp-gate(${NAME}): trimmed ${tool} to ${BUDGET} chars\n`);
      }
    } catch (error) {
      process.stderr.write(`mcp-gate(${NAME}): could not trim ${tool}: ${String(error)}\n`);
      process.stdout.write(`${line}\n`);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
