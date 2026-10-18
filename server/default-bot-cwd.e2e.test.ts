// Lazurio overlay: OMB_DEFAULT_BOT_CWD through the real isolated server. Every
// creation path starts a bot in the configured folder: the first-run bot, New
// bot (POST /api/bots), a Chief's create_bot, and team imports (a package
// file and a team backup). A request that names its own folder, or
// explicitly none, still decides for itself.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const FIXTURES = join(import.meta.dirname, "..", "shared", "package-fixtures");

describe("a server started with OMB_DEFAULT_BOT_CWD", () => {
  const folder = mkdtempSync(join(tmpdir(), "omb-default-cwd-e2e-"));
  const other = mkdtempSync(join(tmpdir(), "omb-default-cwd-e2e-other-"));
  const gate = join(other, "finish");
  let fixture: VerificationServer;
  const api = async (method: string, path: string, body?: unknown, expected?: number, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    if (expected !== undefined) expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  const persisted = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as Array<{ id: string; cwd?: string }>;
  const persistedBot = (botId: string) => persisted().find((bot) => bot.id === botId);

  beforeAll(async () => {
    fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, OMB_DEFAULT_BOT_CWD: folder });
  });

  afterAll(async () => {
    writeFileSync(gate, "finish");
    await fixture?.close();
    await removeTempDir(folder);
    await removeTempDir(other);
  });

  it("starts the first-run bot in the configured folder", () => {
    const bots = persisted();
    expect(bots).toHaveLength(1);
    expect(bots[0].cwd).toBe(folder);
  });

  it("starts a bot from New bot in the configured folder unless the request chooses", async () => {
    const defaulted = await api("POST", "/api/bots", { name: "Defaulted", useDefaults: false }, 201);
    expect(persistedBot(defaulted.bot.id)?.cwd).toBe(folder);

    const chosen = await api("POST", "/api/bots", { name: "Chosen", settings: { cwd: other } }, 201);
    expect(persistedBot(chosen.bot.id)?.cwd).toBe(other);

    const privateWorkspace = await api("POST", "/api/bots", { name: "Private", settings: { cwd: null } }, 201);
    expect(persistedBot(privateWorkspace.bot.id)).not.toHaveProperty("cwd");
  });

  it("starts a Chief's create_bot teammate in the configured folder, keeping an explicit private workspace", async () => {
    const chief = (await api("POST", "/api/bots", { name: "Chief", section: "Design" }, 201)).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true }, 200);
    await api("POST", `/api/bots/${chief.id}/messages`, { text: "Prepare two specialists." }, 202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const create = async (name: string, cwd?: string) => {
      const result = await api("POST", "/api/internal/create-bot", {
        fromBotId: chief.id, fromThreadId: chief.threadId, name, role: "Specialist", instructions: "Complete assigned work.",
        ...(cwd === undefined ? {} : { cwd }),
      }, 201, token);
      expect(result).toMatchObject({ state: "applied", applied: true });
      return result.id as string;
    };
    expect(persistedBot(await create("Default specialist"))?.cwd).toBe(folder);
    expect(persistedBot(await create("Private specialist", ""))).not.toHaveProperty("cwd");
    expect(persistedBot(await create("Chosen specialist", other))?.cwd).toBe(other);
    writeFileSync(gate, "finish");
  });

  it("starts imported bots in the configured folder: a team backup and a package file", async () => {
    // A backup carries no folders: even the bot that chose its own lands in the default.
    const backup = await api("POST", "/api/teams/export", { format: "backup", name: "Everything" }, 200);
    const restored = await api("POST", "/api/teams/import", backup, 201);
    expect(restored.bots.length).toBeGreaterThan(0);
    for (const bot of restored.bots) expect(persistedBot(bot.id)?.cwd).toBe(folder);

    const document = JSON.parse(readFileSync(join(FIXTURES, "full-team.v2.json"), "utf8"));
    const imported = await api("POST", "/api/teams/import", document, 201);
    expect(imported.bots.length).toBeGreaterThan(0);
    for (const bot of imported.bots) expect(persistedBot(bot.id)?.cwd).toBe(folder);
  });
});
