// Lazurio overlay (DEV-6673 M3, issue #35): the upstream features Lazurio
// removes from the code answer no request any more. The routes come from the
// removal manifests in lazurio/removals/ (scripts/lazurio-removals.node-test.mjs
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
});