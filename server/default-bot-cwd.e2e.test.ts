// OMB_DEFAULT_BOT_CWD through the real isolated server: the first-run bot and
// New bot start in the configured folder, and a request that names its own
// folder, or explicitly none, still decides for itself.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("a server started with OMB_DEFAULT_BOT_CWD", () => {
  const folder = mkdtempSync(join(tmpdir(), "omb-default-cwd-e2e-"));
  const other = mkdtempSync(join(tmpdir(), "omb-default-cwd-e2e-other-"));
  let fixture: VerificationServer;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const persisted = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as Array<{ id: string; cwd?: string }>;
  const persistedBot = (botId: string) => persisted().find((bot) => bot.id === botId);

  beforeAll(async () => {
    fixture = await launchVerificationServer({ ...process.env, OMB_DEFAULT_BOT_CWD: folder });
  });

  afterAll(async () => {
    await fixture?.close();
    rmSync(folder, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it("starts the first-run bot in the configured folder", () => {
    const bots = persisted();
    expect(bots).toHaveLength(1);
    expect(bots[0].cwd).toBe(folder);
  });

  it("starts a bot from New bot in the configured folder unless the request chooses", async () => {
    const defaulted = await api("POST", "/api/bots", { name: "Defaulted", useDefaults: false });
    expect(defaulted.status).toBe(201);
    expect(persistedBot(defaulted.body.bot.id)?.cwd).toBe(folder);

    const chosen = await api("POST", "/api/bots", { name: "Chosen", settings: { cwd: other } });
    expect(chosen.status).toBe(201);
    expect(persistedBot(chosen.body.bot.id)?.cwd).toBe(other);

    const privateWorkspace = await api("POST", "/api/bots", { name: "Private", settings: { cwd: null } });
    expect(privateWorkspace.status).toBe(201);
    expect(persistedBot(privateWorkspace.body.bot.id)).not.toHaveProperty("cwd");
  });
});
