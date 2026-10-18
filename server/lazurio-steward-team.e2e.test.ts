// Lazurio overlay: the shipped Steward team imported into the real isolated
// server, as an Environment imports it from the installed release. The
// leader the GitHub intake targets arrives as the team's Chief of Staff, and
// every bot starts on upstream's default level, Full access, in the
// Environment's folder (OMB_DEFAULT_BOT_CWD), with nothing set after import.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("the shipped Steward team in a Lazurio server", () => {
  const folder = mkdtempSync(join(tmpdir(), "omb-steward-e2e-"));
  let fixture: VerificationServer;

  beforeAll(async () => {
    fixture = await launchVerificationServer({ OMB_DEFAULT_BOT_CWD: folder });
  });

  afterAll(async () => {
    await fixture?.close();
    await removeTempDir(folder);
  });

  it("imports a Chief leader and three workers on Full access in the Environment's folder", async () => {
    const steward = JSON.parse(readFileSync(new URL("../lazurio/teams/steward.openmaus.json", import.meta.url), "utf8"));
    const response = await fetch(`${fixture.info.url}/api/teams/import?mode=add`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: fixture.info.url },
      body: JSON.stringify(steward),
    });
    const imported = await response.json() as { bots: Array<{ id: string; name: string; chiefOfStaff?: boolean; section?: string; approvalMode?: string }> };
    expect(response.status, JSON.stringify(imported)).toBe(201);
    expect(imported.bots).toHaveLength(4);
    expect(imported.bots.find((bot) => bot.name === "Henry")).toMatchObject({ chiefOfStaff: true, section: "Steward" });
    for (const bot of imported.bots) expect(bot).toMatchObject({ section: "Steward", approvalMode: "full" });
    const persisted = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as Array<{ id: string; cwd?: string }>;
    for (const bot of imported.bots) expect(persisted.find((candidate) => candidate.id === bot.id)?.cwd).toBe(folder);
  });
});
