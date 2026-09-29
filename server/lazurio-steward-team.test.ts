// The Lazurio Steward team (lazurio/teams/steward.openmaus.json) is a valid
// portable team package: a leader who is the team's Chief of Staff and three
// workers, no secrets, and no persona name baked into the instructions, so
// the same file serves every persona (rename the leader after import).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { packageScanFindings, packageSecretFindings, parsePackageDocument } from "../shared/package-format.ts";
import { PUBLISH_MARKER } from "./github-intake.ts";

const raw = JSON.parse(readFileSync(new URL("../lazurio/teams/steward.openmaus.json", import.meta.url), "utf8")) as unknown;

describe("the Lazurio Steward team package", () => {
  const document = parsePackageDocument(raw, { trust: "file" });
  const pkg = document.package;

  it("is a version 2 package with a leader and three workers", () => {
    expect(document).toMatchObject({ format: "openmaus.package", version: 2 });
    expect(pkg.team?.leader).toBe("leader");
    const leader = pkg.agents.find((agent) => agent.key === pkg.team?.leader);
    expect(leader?.name).toBe("Henry");
    expect(pkg.agents.filter((agent) => agent !== leader)).toHaveLength(3);
    expect(pkg.rooms?.[0]).toMatchObject({ defaultResponder: { kind: "agent", agent: "leader" } });
    expect(pkg.rooms?.[0].members).toHaveLength(4);
  });

  it("carries no secrets and nothing the import scan warns about", () => {
    expect(packageSecretFindings(document)).toEqual([]);
    expect(packageScanFindings(document)).toEqual([]);
  });

  it("names the rules the intake relies on, without a persona name", () => {
    const brief = pkg.team?.brief ?? "";
    expect(brief).toContain(PUBLISH_MARKER);
    expect(brief).toContain("AGENTS.md");
    expect(brief).toContain("commit_id");
    expect(pkg.agents.find((agent) => agent.key === "leader")?.soul).toContain("delegate_bot");
    for (const text of [brief, ...pkg.agents.map((agent) => agent.soul ?? "")]) {
      expect(text).not.toMatch(/henry|pablo/i);
    }
  });
});
