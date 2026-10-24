import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MIGRATION_CANDIDATE, unpackMigrationCandidate } from "./lazurio-migration-artifact.ts";
import { prepareMigrationCopy, separatePaths } from "./lazurio-migration-snapshot.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const MIGRATION_HELP = "migration qualify --archive ABS --manifest ABS --snapshot ABS --work ABS --evidence ABS --input-kind synthetic|private-lumbio [--observe-ms 90000] (Linux x64 only; explicitly starts the isolated candidate)";

export function migrationIsolationArgs(work: string, candidate: string, harness: string, node: string, observeMs: number, parentNet: string): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/bin", "--dir", "/usr", "--dir", "/usr/lib"];
  for (const path of ["/lib", "/lib64", "/usr/lib"]) if (existsSync(path)) args.push("--ro-bind", realpathSync(path), path);
  args.push("--ro-bind", node, "/bin/node", "--ro-bind", candidate, "/candidate", "--ro-bind", harness, "/harness", "--bind", work, "/work",
    "--setenv", "MIGRATION_OBSERVE_MS", String(observeMs), "--setenv", "MIGRATION_PARENT_NET", parentNet,
    "--chdir", "/work", "/bin/node", "/harness/worker.mjs");
  return args;
}

/** No caller environment, production URL, download, service operation or unisolated fallback. */
export async function migrationCommand(argv: string[]): Promise<unknown> {
  try { return await qualify(argv); }
  catch (error) {
    const reason = error instanceof Error && /^[a-z][a-z0-9-]+$/.test(error.message) ? error.message : "migration-admission-error";
    throw new Error(reason);
  }
}

async function qualify(argv: string[]): Promise<unknown> {
  if (argv.length === 0 || argv.includes("--help")) return MIGRATION_HELP;
  if (argv[0] !== "qualify") throw new Error("unknown-migration-command");
  const { values } = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: false, options: {
    archive: { type: "string" }, manifest: { type: "string" }, snapshot: { type: "string" }, work: { type: "string" }, evidence: { type: "string" },
    "input-kind": { type: "string" }, "observe-ms": { type: "string", default: "90000" },
  } });
  const observe = Number(values["observe-ms"]);
  if (!Number.isSafeInteger(observe) || observe < 90_000 || observe > 300_000) throw new Error("invalid-observation-period");
  if (!["synthetic", "private-lumbio"].includes(values["input-kind"] ?? "")) throw new Error("explicit-input-kind-required");
  for (const field of ["archive", "manifest", "snapshot", "work", "evidence"] as const) {
    const path = values[field];
    if (!path || resolve(path) !== path || realpathSync(path) !== path) throw new Error("explicit-existing-real-paths-required");
  }
  const archive = values.archive!;
  const manifest = values.manifest!;
  const snapshot = values.snapshot!;
  const work = values.work!;
  const evidence = values.evidence!;
  separatePaths([snapshot, work, evidence]);
  if (basename(snapshot) === ".openmausbot" || !lstatSync(snapshot).isDirectory() || !lstatSync(work).isDirectory() || !lstatSync(evidence).isDirectory()
    || readdirSync(work).length || readdirSync(evidence).length) throw new Error("offline-snapshot-and-empty-output-directories-required");
  if (!lstatSync(archive).isFile() || lstatSync(archive).size !== MIGRATION_CANDIDATE.size || !lstatSync(manifest).isFile() || lstatSync(manifest).size > 64_000) throw new Error("invalid-artifact-files");
  if (process.platform !== "linux" || process.arch !== "x64" || Number(process.versions.node.split(".")[0]) < 24) return { status: "BLOCKED", reason: "linux-x64-node24-required" };
  for (const executable of ["/usr/bin/bwrap", "/usr/bin/strace"]) {
    if (!existsSync(executable)) return { status: "BLOCKED", reason: "isolation-tools-unavailable" };
  }
  chmodSync(work, 0o700);
  chmodSync(evidence, 0o700);
  const unpacked = join(work, "artifact");
  mkdirSync(unpacked, { mode: 0o700 });
  unpackMigrationCandidate(archive, manifest, unpacked);
  const runtime = join(work, "fixture");
  mkdirSync(runtime, { mode: 0o700 });
  const transformations = prepareMigrationCopy(snapshot, runtime);
  const bots = JSON.parse(readFileSync(join(runtime, "data/bots.json"), "utf8"));
  const models = [...new Set<string>(bots.flatMap((bot: { modelSelection: { model: string }; tasks?: { modelSelection?: { model: string } }[] }) =>
    [bot.modelSelection.model, ...(bot.tasks ?? []).flatMap((task) => task.modelSelection ? [task.modelSelection.model] : [])]))];
  writeFileSync(join(runtime, "fixture-models.json"), JSON.stringify(models), { mode: 0o600 });
  mkdirSync(join(runtime, "run"), { mode: 0o700 });
  const harness = join(work, "harness");
  mkdirSync(harness, { mode: 0o700 });
  mkdirSync(join(harness, "bin"), { mode: 0o700 });
  copyFileSync(join(HERE, "lazurio-migration-worker.mjs"), join(harness, "worker.mjs"));
  for (const engine of ["codex", "claude"]) {
    copyFileSync(join(HERE, "lazurio-migration-engine-guard.mjs"), join(harness, `guard-${engine}`));
    chmodSync(join(harness, `guard-${engine}`), 0o500);
    copyFileSync(join(harness, `guard-${engine}`), join(harness, "bin", engine));
    chmodSync(join(harness, "bin", engine), 0o500);
  }
  const args = migrationIsolationArgs(runtime, join(unpacked, "package"), harness, realpathSync(process.execPath), observe, readlinkSync("/proc/self/ns/net"));
  // strace records connect addresses only, never argv, read/write buffers or model text.
  const trace = join(evidence, "connections.log");
  const child = spawn("/usr/bin/strace", ["-f", "-qq", "-e", "trace=connect", "-o", trace, "/usr/bin/bwrap", ...args], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: runtime }, cwd: runtime, detached: true, stdio: "ignore",
  });
  let cancelled = false;
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
  };
  const cancel = () => { cancelled = true; terminate(); };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timeout = setTimeout(cancel, observe * 2 + 120_000);
  let code: number | null;
  try {
    code = await new Promise<number | null>((done) => { child.once("error", () => done(null)); child.once("close", done); });
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    terminate();
    if (existsSync(trace)) chmodSync(trace, 0o600);
  }
  const workerResult = join(runtime, "result.json");
  const worker = existsSync(workerResult) ? JSON.parse(readFileSync(workerResult, "utf8")) : { status: "BLOCKED", reason: "isolation-or-worker-failed" };
  const network = existsSync(trace) ? readFileSync(trace, "utf8") : "";
  const external = network.split("\n").filter((line) => /AF_INET6?\b/.test(line)
    && !(/127\.0\.0\.1/.test(line) && /htons\(1997[12]\)/.test(line)));
  const report = { schema: "lazurio.migration-acceptance.v1", candidate: MIGRATION_CANDIDATE, at: new Date().toISOString(), inputKind: values["input-kind"], transformations,
    ...worker, status: cancelled && code !== 0 ? "BLOCKED" : external.length ? "FAIL" : worker.status,
    unexpectedConnectAttempts: external.length, checks: { artifact: "PASS", privateInputNotExported: true },
  };
  writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}
