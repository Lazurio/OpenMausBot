import { chmodSync, copyFileSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrationCommand, migrationIsolationArgs, migrationVerdict } from "./lazurio-migration-acceptance.ts";
import { inspectMigrationSnapshot, prepareMigrationCopy, separatePaths } from "./lazurio-migration-snapshot.ts";
import { engineInvocation, migrationDiagnostic, migrationFetch, validModelCache } from "./lazurio-migration-contract.mjs";

const directories: string[] = [];

describe("migration discovery contract", () => {
  it("accepts only bounded model catalog metadata, never provider credentials or arbitrary files", () => {
    const catalog = { default: "fixture", options: [{ id: "fixture", label: "Fixture" }] };
    expect(validModelCache(catalog)).toBe(true);
    for (const extra of [{ apiKey: "fictional-secret" }, { prompt: "fictional-secret" }, { custom: "not-a-boolean" }, { contextWindow: -1 }]) {
      expect(validModelCache({ ...catalog, options: [{ ...catalog.options[0], ...extra }] })).toBe(false);
    }
    expect(validModelCache({ ...catalog, token: "fictional-secret" })).toBe(false);
    expect(validModelCache({ ...catalog, options: [] })).toBe(false);
  });
  it("admits exact read-only CLI probes and refuses extra arguments and generation", () => {
    expect(engineInvocation(true, ["login", "status"])).toBe("login-status");
    expect(engineInvocation(false, ["--help"])).toBe("help");
    expect(engineInvocation(false, ["auth", "status", "--json"])).toBe("auth-status");
    expect(engineInvocation(true, ["app-server"])).toBe("app-server");
    for (const args of [["login"], ["login", "status", "--token", "fictional-secret"], ["app-server", "--unknown"], ["auth", "status"], ["--version", "extra"]]) {
      for (const codex of [true, false]) expect(engineInvocation(codex, args)).toMatch(/^denied-/);
    }
    expect(engineInvocation(false, ["-p", "fictional prompt"])).toBe("denied-generation-cli");
    expect(engineInvocation(true, ["exec", "fictional prompt"])).toBe("denied-generation-cli");
  });
  it("answers only the pinned local discovery GETs with empty synthetic catalogs", async () => {
    const journal: string[] = [];
    const fetch = migrationFetch((kind: string) => journal.push(kind));
    for (const [port, path] of [[8080, "/v1/models"], [8080, "/v1/models/status"], [11434, "/v1/models"], [11434, "/api/ps"],
      [52415, "/v1/models"], [1234, "/v1/models"], [1234, "/api/v0/models"], [8888, "/v1/models"]]) {
      expect(await (await fetch(`http://127.0.0.1:${port}${path}`)).json()).toEqual({ data: [], models: [] });
    }
    expect(journal).toEqual(Array(8).fill("synthetic-local-discovery"));
  });
  it("refuses generation, body-bearing discovery, redirects and every other fetch without leaking inputs", async () => {
    const journal: string[] = [];
    const fetch = migrationFetch((kind: string) => journal.push(kind));
    for (const url of ["https://example.test/fictional-secret", "http://127.0.0.1:11434/v1/chat/completions",
      "http://127.0.0.1:8080/v1/models?token=fictional-secret", "http://localhost:8080/v1/models", "http://127.0.0.1:19971/api/health"]) {
      await expect(fetch(url)).rejects.toThrow("migration-network-request-denied");
    }
    await expect(fetch("http://127.0.0.1:8080/v1/models", { method: "POST", body: "fictional prompt" })).rejects.toThrow();
    const bodyOnly = { body: "fictional prompt" };
    await expect(fetch("http://127.0.0.1:8080/v1/models", bodyOnly)).rejects.toThrow();
    await expect(fetch(new Request("http://127.0.0.1:8080/v1/models", { method: "POST", body: "fictional prompt" }))).rejects.toThrow();
    expect(journal).toEqual(Array(8).fill("denied-network-request"));
  });
  it("reports fixed error categories and phases without exception contents", () => {
    expect(migrationDiagnostic(new TypeError("fictional-secret"), "first-start")).toEqual({ phase: "first-start", code: "type-error" });
    expect(migrationDiagnostic({ code: "ERR_SQLITE_ERROR", message: "database is locked" }, "first-start")).toEqual({ phase: "first-start", code: "sqlite-busy" });
    expect(migrationDiagnostic(new Error("fictional-secret"), "second-start")).toEqual({ phase: "second-start", code: "unknown-error" });
  });
  it("forwards only fixture health and prohibits following redirects", async () => {
    const calls: unknown[] = [];
    const fetch = migrationFetch(() => {}, async (...args: unknown[]) => { calls.push(args); return Response.json({ app: "openmausbot" }); });
    await fetch("http://127.0.0.1:19971/api/health", { redirect: "follow" });
    expect(calls).toEqual([["http://127.0.0.1:19971/api/health", { redirect: "error" }]]);
    await expect(fetch("http://127.0.0.1:19971/api/health?token=fictional-secret")).rejects.toThrow();
    await expect(fetch("http://127.0.0.1:19971/api/health", { method: "POST" })).rejects.toThrow();
    await expect(fetch("http://127.0.0.1:19971/api/internal/send")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("keeps the known release metadata check offline without permitting package downloads", async () => {
    const events: string[] = [];
    const fetch = migrationFetch((kind: string) => events.push(kind), async () => { throw new Error("must-not-connect"); });
    expect((await fetch("https://registry.npmjs.org/@openai/codex/latest")).status).toBe(503);
    expect(events).toEqual(["synthetic-release-offline"]);
    for (const url of ["https://registry.npmjs.org/@openai/codex/-/codex-0.160.1.tgz", "https://registry.npmjs.org/@openai/codex/latest?token=fictional-secret"]) {
      await expect(fetch(url)).rejects.toThrow("migration-network-request-denied");
    }
    await expect(fetch("https://registry.npmjs.org/@openai/codex/latest", { method: "POST" })).rejects.toThrow();
  });
  it("the executable guard denies session/generation RPC and extra CLI arguments without logging their payload", () => {
    const root = fixture();
    const journal = join(root, "journal.ndjson");
    const models = join(root, "models.json");
    writeFileSync(models, '["fixture-model"]');
    const guard = join(root, "codex");
    writeFileSync(guard, readFileSync(new URL("./lazurio-migration-engine-guard.mjs", import.meta.url), "utf8")
      .replace('"/work/guard-events.ndjson"', JSON.stringify(journal)).replace('"/work/fixture-models.json"', JSON.stringify(models)));
    copyFileSync(new URL("./lazurio-migration-contract.mjs", import.meta.url), join(root, "lazurio-migration-contract.mjs"));
    const login = spawnSync(process.execPath, [guard, "login", "status"], { encoding: "utf8", timeout: 5000 });
    expect(login.status).toBe(0);
    expect(login.stdout).toContain("Logged in using ChatGPT");
    for (const method of ["thread/start", "thread/resume", "turn/start", "fictional-secret"]) {
      const request = JSON.stringify({ id: 1, method, params: { prompt: "fictional-secret" } });
      const call = spawnSync(process.execPath, [guard, "app-server"], { input: `${request}\n`, encoding: "utf8", timeout: 5000 });
      expect(call.status).toBe(78);
      expect(call.stdout).toBe("");
    }
    expect(spawnSync(process.execPath, [guard, "login", "status", "fictional-secret"], { timeout: 5000 }).status).toBe(78);
    const events = readFileSync(journal, "utf8");
    expect(events).toContain("denied-session-or-generation-rpc");
    expect(events).toContain("denied-unknown-rpc");
    expect(events).toContain("denied-unknown-cli");
    expect(events).not.toContain("fictional-secret");
  });
});
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
    for (const name of ["messages.db-wal", "routines.json", "sessions.json", "calendar-calls.json", "memory-capture-pending.json", "room-handoffs.json"]) {
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
