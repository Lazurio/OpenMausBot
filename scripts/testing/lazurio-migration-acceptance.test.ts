import { chmodSync, linkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrationCommand, migrationIsolationArgs, migrationVerdict } from "./lazurio-migration-acceptance.ts";
import { inspectMigrationSnapshot, prepareMigrationCopy, separatePaths } from "./lazurio-migration-snapshot.ts";

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
    const hardlinked = fixture();
    linkSync(join(hardlinked, "config.json"), join(hardlinked, "second-link"));
    expect(() => inspectMigrationSnapshot(hardlinked)).toThrow("special-file");
    const credentialFile = fixture();
    writeFileSync(join(credentialFile, ".env"), "FIXTURE_ONLY=true");
    expect(() => inspectMigrationSnapshot(credentialFile)).toThrow();
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
  it("requires clean isolation exit and complete evidence even when the worker says PASS", () => {
    const complete = { exitCode: 0, cancelled: false, complete: true, tracePresent: true, workerStatus: "PASS",
      scenarios: [{ id: "first-start", status: "PASS" }, { id: "second-start", status: "PASS" }], unexpectedConnects: 0 };
    expect(migrationVerdict(complete)).toBe("PASS");
    for (const partial of [{ exitCode: 1 }, { exitCode: null }, { cancelled: true }, { complete: false }, { tracePresent: false }, { scenarios: [] }, { workerStatus: "unknown" }]) {
      expect(migrationVerdict({ ...complete, ...partial })).toBe("BLOCKED");
    }
    expect(migrationVerdict({ ...complete, unexpectedConnects: 1 })).toBe("FAIL");
    expect(migrationVerdict({ ...complete, workerStatus: "FAIL" })).toBe("FAIL");
  });
  it("keeps the original read-only file unchanged while making its private copy writable", () => {
    const snapshot = fixture();
    const work = realpathSync(mkdtempSync(join(tmpdir(), "migration-copy-unit-")));
    directories.push(work);
    chmodSync(join(snapshot, "config.json"), 0o400);
    prepareMigrationCopy(snapshot, work);
    expect(statSync(join(snapshot, "config.json")).mode & 0o777).toBe(0o400);
    expect(statSync(join(work, "data/config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(work, "data")).mode & 0o777).toBe(0o700);
  });
});
