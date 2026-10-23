import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { projectMcpServers, userMcpServers } from "./claude-mcp-servers.ts";

const homes: string[] = [];
function home() {
  const directory = mkdtempSync(join(tmpdir(), "environment-mcp-"));
  homes.push(directory);
  return directory;
}
afterEach(() => homes.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

it("uses the configured Claude directory before HOME without merging other identities", () => {
  const directory = home();
  const configured = join(directory, "claude");
  mkdirSync(configured);
  writeFileSync(join(directory, ".claude.json"), JSON.stringify({ mcpServers: { unrelated: { command: "other" } } }));
  const executor = { type: "stdio", command: "/fixture/executor", args: ["mcp"], env: {} };
  writeFileSync(join(configured, ".claude.json"), JSON.stringify({ mcpServers: { executor }, hooks: { ignored: true } }));
  expect(userMcpServers({ HOME: directory, CLAUDE_CONFIG_DIR: configured })).toEqual({ executor });
});

it("does not fall back to another home when the configured file is missing or malformed", () => {
  const directory = home();
  const configured = join(directory, "claude");
  mkdirSync(configured);
  writeFileSync(join(directory, ".claude.json"), JSON.stringify({ mcpServers: { unrelated: { command: "other" } } }));
  const env = { HOME: directory, CLAUDE_CONFIG_DIR: configured };
  expect(userMcpServers(env)).toEqual({});
  writeFileSync(join(configured, ".claude.json"), "{broken");
  expect(userMcpServers(env)).toEqual({});
});

it.each([null, [], "invalid", { mcpServers: [] }, { mcpServers: "invalid" }])("ignores invalid MCP containers: %j", (value) => {
  const directory = home();
  writeFileSync(join(directory, ".claude.json"), JSON.stringify(value));
  expect(userMcpServers({ HOME: directory })).toEqual({});
});

it("forwards only server objects and reads project scope independently", () => {
  const directory = home();
  const executor = { command: "executor", args: ["mcp"] };
  writeFileSync(join(directory, ".mcp.json"), JSON.stringify({ mcpServers: { executor, absent: null, invalid: [], text: "no" } }));
  expect(projectMcpServers(directory)).toEqual({ executor });
  expect(userMcpServers({ HOME: directory })).toEqual({});
});
