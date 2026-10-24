import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrationCommand, migrationIsolationArgs } from "./lazurio-migration-acceptance.ts";
import { inspectMigrationSnapshot, separatePaths } from "./lazurio-migration-snapshot.ts";

const directories: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "migration-unit-")));
  directories.push(root);
  writeFileSync(join(root, "config.json"), JSON.stringify({ onboarding: { version: 1 } }));
  writeFileSync(join(root, "bots.json"), JSON.stringify([{ id: "fixture", modelSelection: { instanceId: "codex", model: "fixture" }, tasks: [] }]));
  return root;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("migration launcher admission, without launching any candidate", () => {
  it("help has no filesystem or subprocess requirement", async () => {
    expect(await migrationCommand(["--help"])).toContain("Linux x64 only");
  });
  it("refuses URL options instead of discovering a running server", async () => {
    await expect(migrationCommand(["qualify", "--url", "http://127.0.0.1:4102"])).rejects.toThrow();
  });
  it("refuses overlapping inputs and outputs", () => {
    const root = fixture();
    mkdirSync(join(root, "nested"));
    expect(() => separatePaths([root, join(root, "nested")])).toThrow("overlapping");
  });
  it("refuses credentials, a live WAL, automatic work and links", () => {
    for (const name of ["messages.db-wal", "routines.json", "sessions.json"]) {
      const root = fixture();
      writeFileSync(join(root, name), "{}");
      expect(() => inspectMigrationSnapshot(root)).toThrow();
    }
    const root = fixture();
    writeFileSync(join(root, "config.json"), JSON.stringify({ composio: { apiKey: "not-a-real-key" } }));
    expect(() => inspectMigrationSnapshot(root)).toThrow("credentials");
    const linked = fixture();
    symlinkSync(join(linked, "config.json"), join(linked, "link"));
    expect(() => inspectMigrationSnapshot(linked)).toThrow("special-file");
  });
  it("builds an empty-root namespace without inheriting network or home", () => {
    const args = migrationIsolationArgs("/fixture/work", "/fixture/artifact", "/fixture/harness", "/fixture/node", 90_000, "net:[fixture]");
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--clearenv");
    expect(args).not.toContain("--share-net");
    expect(args).not.toContain("--share-user");
    expect(args).not.toContain("/run/user");
    expect(args).not.toContain("--dev-bind");
    expect(args).not.toContain("/");
  });
});
