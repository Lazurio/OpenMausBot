#!/bin/node
// No prompt, argv, environment or credentials may enter the guard journal.
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const codex = ["guard-codex", "codex"].includes(basename(process.argv[1]));
const record = (kind) => appendFileSync("/work/guard-events.ndjson", `${JSON.stringify({ kind, at: Date.now() })}\n`, { mode: 0o600 });
const deny = () => { record("denied"); process.stderr.write("migration-engine-request-denied\n"); process.exit(78); };
if (args.length === 1 && args[0] === "--version") {
  record("version");
  console.log(codex ? "codex-cli 0.160.1" : "2.1.232 (Claude Code)");
} else if (!codex && args[0] === "auth" && args[1] === "status" && args.slice(2).every((arg) => arg === "--json")) {
  record("auth-status");
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "fixture@example.test", subscriptionType: "pro" }));
} else if (codex && args[0] === "app-server") {
  const models = JSON.parse(readFileSync("/work/fixture-models.json", "utf8"));
  for await (const line of createInterface({ input: process.stdin })) {
    let message;
    try { message = JSON.parse(line); } catch { deny(); }
    const method = message.method;
    if (method === "initialized" || method === "notifications/initialized") { record("initialized"); continue; }
    let result;
    switch (method) {
      case "initialize": result = { userAgent: "migration-fixture" }; break;
      case "account/read": result = { account: { type: "chatgpt", email: "fixture@example.test", planType: "pro" }, requiresOpenaiAuth: true }; break;
      case "config/read": result = { config: { model_provider: "openai" }, origins: {}, layers: [] }; break;
      case "model/list": result = { data: models.map((id, index) => ({ id, model: id, displayName: id, hidden: false, isDefault: index === 0, supportedReasoningEfforts: [], defaultReasoningEffort: "medium" })), nextCursor: null }; break;
      default: deny();
    }
    record(method);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  }
} else deny();
