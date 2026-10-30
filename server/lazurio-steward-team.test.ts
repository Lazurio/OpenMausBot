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
  const brief = pkg.team?.brief ?? "";

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
    expect(brief).toContain(PUBLISH_MARKER);
    expect(brief).toContain("AGENTS.md");
    expect(brief).toContain("commit_id");
    expect(pkg.agents.find((agent) => agent.key === "leader")?.soul).toContain("coordinate_bots");
    for (const text of [brief, ...pkg.agents.map((agent) => agent.soul ?? "")]) {
      expect(text).not.toMatch(/henry|pablo/i);
    }
  });

  it("blocks only real defects and reports every finding in one review on GitHub", () => {
    expect(brief).toContain("REQUEST_CHANGES is for a real defect");
    expect(brief).toContain("approve and write it in the review as non-blocking");
    expect(brief).toContain("When in doubt, do not block.");
    expect(brief).toContain("Find everything in one pass.");
    expect(brief).toMatch(/grouped as "Blocking" .+ and "Non-blocking"/);
    expect(brief).toMatch(/outside this pull request's purpose becomes a GitHub issue .+; it never blocks the pull request/);
  });

  it("removes each pull request's worktree and local branch when the work ends", () => {
    expect(brief).toContain("git worktree remove --force");
    expect(brief).toContain("git worktree prune");
    expect(brief).toContain("git branch -D");
  });
});
