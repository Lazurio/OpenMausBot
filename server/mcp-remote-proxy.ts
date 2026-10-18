// The upstream handshake is OMB's own, never the engine's: an engine's client adds capability fields a strict server
// refuses. stdout carries only protocol frames.
import { createInterface } from "node:readline";
import { redactSecretsInText } from "../shared/redact.ts";

import {
  MAX_REMOTE_MCP_BYTES,
  McpHttpError,
  McpRpcError,
  REMOTE_MCP_CONFIG_ENV,
  RemoteMcpClient,
  plainHttpProxyFetch,
  remoteMcpSpec,
} from "./mcp-http.ts";

type Json = Record<string, unknown>;
function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function requestKey(id: unknown): string | undefined {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) ? `${typeof id}:${id}` : undefined;
}
function send(frame: unknown): void { process.stdout.write(`${JSON.stringify(frame)}\n`); }
function error(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id: requestKey(id) ? id : null, error: { code, message } });
}
function fail(message: string): never {
  process.stderr.write(`mcp-remote-proxy: ${message}\n`);
  process.exit(1);
}

const CREDENTIALS_REFUSED = "This MCP server refused its credentials (HTTP 401). Check its header values.";

const SETTINGS = ["OMB_REMOTE_MCP_SERVER"];
/** Codex hands every MCP child one shared environment, so a mount names its own record; settings leave this env once read. */
function privateSettings(): Record<string, string | undefined> {
  if (process.argv.length === 2) {
    const settings = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
    for (const name of SETTINGS) delete process.env[name];
    return settings;
  }
  const key = process.argv[3];
  if (process.argv.length !== 4 || process.argv[2] !== "--config-env" || !key || !REMOTE_MCP_CONFIG_ENV.test(key)) return {};
  const raw = process.env[key];
  delete process.env[key];
  try {
    const value: unknown = JSON.parse(raw ?? "");
    if (isRecord(value) && Object.entries(value).every(([name, setting]) => SETTINGS.includes(name) && typeof setting === "string")) {
      return value as Record<string, string>;
    }
  } catch {}
  return {};
}

const settings = privateSettings();
let spec;
try { spec = remoteMcpSpec(JSON.parse(settings.OMB_REMOTE_MCP_SERVER ?? "")); } catch {}
if (!spec) fail("invalid remote MCP configuration");

const REMOTE_ERROR_CHARS = 1_000;
/** Configured values (address parts, header values) a remote error must never echo. */
const configured: string[] = (() => {
  const values = new Set<string>([spec.url]);
  try {
    const url = new URL(spec.url);
    values.add(url.href);
    values.add(`${url.origin}${url.pathname}`);
    if (url.pathname.length > 1) values.add(url.pathname);
    for (const segment of url.pathname.split("/")) if (segment.length >= 16) values.add(segment);
    for (const value of url.searchParams.values()) if (value.length >= 4) values.add(value);
  } catch {}
  for (const value of Object.values(spec.headers)) {
    if (value.trim().length >= 4) values.add(value.trim());
    for (const word of value.split(/\s+/)) if (word.length >= 8) values.add(word);
  }
  return [...values].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
})();
function remoteErrorText(detail: string): string {
  let text = detail.slice(0, REMOTE_ERROR_CHARS * 8);
  for (const value of configured) text = text.split(value).join("«redacted»");
  text = redactSecretsInText(text).trim();
  if (text.length > REMOTE_ERROR_CHARS) text = `${text.slice(0, REMOTE_ERROR_CHARS - 1)}…`;
  return text || "Remote MCP request failed";
}
/** What a refused HTTP request means, in words a person can act on. The status code itself carries no secret. */
function remoteStatusText(status: number | undefined): string {
  if (status === 403) {
    return "This MCP server refused the request (HTTP 403). Its sign-in may be missing a permission (scope) it needs, "
      + "or the service may not be turned on for that account or project.";
  }
  if (status === 404) return "This MCP server's address was not found (HTTP 404). Check its URL.";
  if (status === 429) return "This MCP server is limiting requests right now (HTTP 429). Try again in a moment.";
  if (status !== undefined && status >= 500) return `This MCP server had a problem on its side (HTTP ${status}). Try again later.`;
  return status === undefined ? "Remote MCP request failed" : `Remote MCP request failed (HTTP ${status})`;
}
const closed = new AbortController();
const viaProxy = plainHttpProxyFetch(process.env);
const client = new RemoteMcpClient(spec, {
  maxBytes: MAX_REMOTE_MCP_BYTES,
  ...(viaProxy ? { fetch: viaProxy } : {}),
  onNotification: (message) => send(message),
});
const pending = new Map<string, AbortController>();
const tasks = new Set<Promise<void>>();
let initialized = false;
let closing = false;

async function handle(message: Json): Promise<void> {
  const id = requestKey(message.id);
  if (typeof message.method !== "string" || message.jsonrpc !== "2.0") {
    error(message.id, -32600, "Invalid JSON-RPC request");
    return;
  }
  if (message.method === "notifications/cancelled") {
    const key = isRecord(message.params) ? requestKey(message.params.requestId) : undefined;
    if (key) pending.get(key)?.abort();
    return;
  }
  if (!id) {
    if (message.method === "notifications/initialized" && initialized) return;
    try { await client.notify(message.method, message.params, AbortSignal.timeout(30_000)); }
    catch {}
    return;
  }
  if (pending.has(id)) { error(message.id, -32600, "Duplicate request ID"); return; }
  const controller = new AbortController();
  pending.set(id, controller);
  // Engines keep their own tool-call deadline (Gemini CLI and Qwen Code wait ten minutes) and cancel through this proxy.
  const deadline = message.method !== "tools/call" ? 30_000 : undefined;
  const signal = deadline === undefined ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(deadline)]);
  try {
    const result = message.method === "initialize"
      ? await client.initialize("OpenMausBot tool proxy", signal)
      : await client.request(message.method, message.params, signal);
    if (message.method === "initialize") initialized = true;
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (failure) {
    // Transport failures may carry URLs or header values: never relayed.
    if (failure instanceof McpRpcError) error(message.id, failure.code ?? -32603, remoteErrorText(failure.detail));
    else if (failure instanceof McpHttpError && failure.status === 401) error(message.id, -32603, CREDENTIALS_REFUSED);
    else if (failure instanceof McpHttpError && failure.kind === "status" && !signal.aborted) error(message.id, -32603, remoteStatusText(failure.status));
    else if (failure instanceof McpHttpError && failure.kind === "network" && failure.message === "request failed" && !signal.aborted) error(message.id, -32603, "Could not reach this MCP server. Check its URL and that it is online.");
    else error(message.id, signal.aborted ? -32800 : -32603, signal.aborted ? "MCP request cancelled" : "Remote MCP request failed");
  } finally { pending.delete(id); }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (closing || !line.trim()) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { error(null, -32700, "Invalid JSON-RPC frame"); return; }
  if (!isRecord(value)) { error(null, -32600, "Invalid JSON-RPC frame"); return; }
  const task = handle(value);
  tasks.add(task);
  void task.finally(() => tasks.delete(task));
});
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  input.close();
  for (const controller of pending.values()) controller.abort();
  closed.abort();
  await Promise.allSettled(tasks);
  await client.close();
  process.exit(0);
}
input.on("close", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
