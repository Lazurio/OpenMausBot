// Lazurio overlay (DEV-6673 M3, issue #35): the upstream features Lazurio
// removes from the code answer no request any more. The routes come from the
// removal manifests in lazurio/removals/ (scripts/lazurio-removals.node-test.mjs
// checks the files and strings); `:bot` stands for the first-run bot's id. A write that names a removed
// setting is refused as a whole, and the server-side Auto warning gate stays on the paths the removals touched.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

const DIR = join(import.meta.dirname, "..", "lazurio", "removals");
const manifests = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort()
  .map((file) => JSON.parse(readFileSync(join(DIR, file), "utf8")) as { area: string; routes: Array<{ method: string; path: string; body?: unknown }> });
const routes = manifests.flatMap((manifest) => manifest.routes.map((route) => ({ area: manifest.area, ...route })));

describe("a Lazurio server", () => {
  let fixture: VerificationServer;
  let botId = "";

  beforeAll(async () => {
    fixture = await launchVerificationServer({});
    const bots = await (await fetch(`${fixture.info.url}/api/bots`, { headers: { origin: fixture.info.url } })).json() as unknown;
    const list = Array.isArray(bots) ? bots : (bots as { bots?: unknown[] }).bots ?? [];
    botId = (list[0] as { id?: string } | undefined)?.id ?? "";
    expect(botId).not.toBe("");
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it.each(routes.map((route) => [`${route.area}: ${route.method} ${route.path}`, route] as const))("has no route for %s", async (_, route) => {
    const path = route.path.replaceAll(":bot", encodeURIComponent(botId));
    const response = await fetch(`${fixture.info.url}${path}`, {
      method: route.method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(route.method === "GET" ? {} : { body: JSON.stringify(route.body ?? {}) }),
    });
    expect(response.status, `${route.method} ${path}: ${await response.text()}`).toBe(404);
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };

  it("refuses a config write that names only a removed setting", async () => {
    for (const patch of [{ box: { token: "box_fixture" } }, { vps: { sshAlias: "fixture" } }, { localVm: { mode: "shared" } },
      { composio: { apiKey: "fixture" } }, { mcpServers: {} }, { features: { sharedComputers: true } },
      { newBotDefaults: { profile: { computer: "local" } } }]) {
      const result = await call("PUT", "/api/config", patch);
      expect(result.status, JSON.stringify(patch)).toBe(400);
      expect(result.body.error).toMatch(/removed/);
    }
  });

  it("refuses a mixed config write as a whole: the valid part is not saved either", async () => {
    const before = (await call("GET", "/api/config")).body.features?.browser;
    const result = await call("PUT", "/api/config", { box: { token: "box_fixture" }, features: { browser: before === false } });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/^box /);
    expect((await call("GET", "/api/config")).body.features?.browser).toBe(before);
  });

  it("refuses Auto over the API without the warning's acknowledgement, on creation and on a switch", async () => {
    const refused = /requires confirming the warning first \(acknowledgeLocalAuto\)/;
    const created = await call("POST", "/api/bots", { name: "Auto unconfirmed", settings: { approvalMode: "auto" } });
    expect(created.status).toBe(400);
    expect(created.body.error).toMatch(refused);
    const confirmed = await call("POST", "/api/bots", { name: "Auto confirmed", settings: { approvalMode: "auto" }, acknowledgeLocalAuto: true });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);

    const bot = await call("POST", "/api/bots", { name: "Switches to Auto", settings: { approvalMode: "ask" } });
    expect(bot.status).toBe(201);
    const id = bot.body.bot.id as string;
    const patched = await call("PATCH", `/api/bots/${id}`, { approvalMode: "auto" });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toMatch(refused);

    const listed = (await call("GET", "/api/bots?messages=0")).body.bots.find((row: { id: string }) => row.id === id);
    const threadId = (listed.tasks?.[0]?.threadId ?? listed.threadId) as string;
    const thread = await call("PATCH", `/api/bots/${id}/tasks/${threadId}`, { approvalMode: "auto" });
    expect(thread.status).toBe(400);
    expect(thread.body.error).toMatch(refused);

    const acknowledged = await call("PATCH", `/api/bots/${id}`, { approvalMode: "auto", acknowledgeLocalAuto: true });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
  });
});
