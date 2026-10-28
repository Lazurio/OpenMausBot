// The Lazurio distribution seeds no MausBot helper bot: a new place's first bot is an ordinary Chief.
// Real server, the repository's fake engines, a temporary home.
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

type Bot = { id: string; name: string; chiefOfStaff?: boolean; defaultBot?: unknown };

it("starts a new place with one ordinary Chief and no MausBot", async () => {
  const fixture = await launchVerificationServer();
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const bots = (await api("GET", "/api/bots?messages=0")).body.bots as Bot[];
    expect(bots.filter((bot) => bot.defaultBot !== undefined)).toEqual([]);
    expect(bots.map((bot) => bot.name)).not.toContain("MausBot");
    expect(bots.filter((bot) => bot.chiefOfStaff)).toHaveLength(1);
    const first = bots.find((bot) => bot.chiefOfStaff)!;
    expect((await api("POST", `/api/bots/${first.id}/helper-followup`, {})).status).toBe(404);
  } finally {
    await fixture.close();
  }
}, 60_000);
