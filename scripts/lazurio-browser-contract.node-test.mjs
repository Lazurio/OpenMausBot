// Lazurio overlay (DEV-6673, task 2026-10-05-510; LazurioPlatform decision
// F50 points 4 and 5): the vendored Environment browser contract in
// lazurio/browser-contract/ is exactly the attested release's bytes, and its
// executable vectors pass against it in this fork's toolchain. The runner
// follows the vectors' README (lazurio/browser-contract/vectors/README.md);
// the bot-specific cases (session names `bot-<id>`) are in
// server/lazurio-environment-browser.test.ts.
// Run with: node --test scripts/lazurio-browser-contract.node-test.mjs
import * as NodeAssert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import * as NodeTest from "node:test";
import { fileURLToPath } from "node:url";

import { CONTRACT_MAJOR, PLATFORM, PROVENANCE_SCHEMA } from "./lazurio-vendor-browser-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = join(ROOT, "lazurio", "browser-contract");
const VECTORS = join(VENDORED, "vectors", "v1");
const pure = await import(join(VENDORED, "pure.js"));
const node = await import(join(VENDORED, "node.js"));
const exported = { ...pure, ...node };

function filesBelow(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [relative(VENDORED, path)];
  });
}

NodeTest.test("lazurio/browser-contract is exactly the attested release's contract files", () => {
  const provenance = JSON.parse(readFileSync(join(VENDORED, "provenance.json"), "utf8"));
  NodeAssert.equal(provenance.schema, PROVENANCE_SCHEMA);
  NodeAssert.deepEqual(provenance.repository, { name: PLATFORM.repository, id: PLATFORM.repositoryId, ownerId: PLATFORM.ownerId });
  NodeAssert.equal(provenance.browserContract, CONTRACT_MAJOR);
  NodeAssert.match(provenance.tag, /^v\d+\.\d+\.\d+(-rc\.\d+)?$/);
  NodeAssert.equal(provenance.version, provenance.tag.slice(1));
  NodeAssert.match(provenance.sourceCommit, /^[0-9a-f]{40}$/);
  NodeAssert.equal(provenance.attestation.sourceRef, `refs/tags/${provenance.tag}`);
  const present = filesBelow(VENDORED).filter((path) => path !== "provenance.json").sort();
  NodeAssert.deepEqual(present, Object.keys(provenance.files).sort(), "nothing added to or missing from the vendored copy");
  for (const path of present) {
    const digest = createHash("sha256").update(readFileSync(join(VENDORED, path))).digest("hex");
    NodeAssert.equal(digest, provenance.files[path], `${path} was edited by hand; vendor a release with scripts/lazurio-vendor-browser-contract.mjs`);
  }
  // The MIT licence of the contract and the Platform's NOTICE naming the exception travel with the files.
  NodeAssert.match(readFileSync(join(VENDORED, "LICENSE"), "utf8"), /^MIT License/);
  NodeAssert.match(readFileSync(join(VENDORED, "NOTICE"), "utf8"), /MIT License instead/);
});

const vectorFiles = readdirSync(VECTORS).filter((name) => name.endsWith(".json")).sort()
  .map((file) => ({ file, ...JSON.parse(readFileSync(join(VECTORS, file), "utf8")) }));

NodeTest.test("every vector file is v1 of its contract, and every export has a case", () => {
  NodeAssert.ok(vectorFiles.length > 0);
  const called = new Set();
  for (const file of vectorFiles) {
    NodeAssert.equal(file.schema, "lazurio.browser-vectors.v1", file.file);
    NodeAssert.equal(`${file.contract}.json`, file.file);
    for (const entry of file.cases) {
      called.add(entry.call);
      NodeAssert.ok(entry.call in exported, `${file.file}: ${entry.call} is no export`);
    }
  }
  NodeAssert.deepEqual(Object.keys(exported).filter((name) => !called.has(name)), [], "an export without a case");
});

// ---- The runner (vectors/README.md) ------------------------------------------

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const targetId = (n) => n.toString(16).toUpperCase().padStart(32, "0");

/** What a case's markers stand for, in `args` and in a file's text. */
function decode(value, context) {
  if (typeof value === "string") {
    if (value === "$alive") return (pid) => context.alive.includes(pid);
    if (value === "$read") return (path) => readFile(join(context.dir, path), "utf8");
    if (value === "$pid") return process.pid;
    if (value === "$changed") return () => { context.changes += 1; };
    return value.startsWith("$dir") ? context.dir + value.slice(4) : value;
  }
  if (Array.isArray(value)) return value.map((item) => decode(item, context));
  if (!isRecord(value)) return value;
  if ("$" in value) {
    if (value.$ === "undefined") return undefined;
    throw new Error(`no value stands for ${value.$}`);
  }
  if ("$map" in value) return new Map(Object.entries(value.$map).map(([key, item]) => [key, decode(item, context)]));
  if ("$json" in value) return JSON.stringify(decode(value.$json, context));
  if ("$repeat" in value) return String(value.$repeat).repeat(Number(value.times));
  if ("$ids" in value) return Array.from({ length: Number(value.$ids) }, (_, n) => targetId(n + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, context)]));
}

/** Projects the result onto what the case names: objects by the members it names (v1 only grows), lists and Maps element by element, `$json` by value. */
function project(actual, expected, context) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [actual, decode(expected, context)];
    const length = Math.max(actual.length, expected.length);
    const pairs = Array.from({ length }, (_, at) => project(actual[at], expected[at], context));
    return [pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])];
  }
  if (!isRecord(expected) || "$" in expected || "$repeat" in expected || "$ids" in expected) return [actual, decode(expected, context)];
  if ("$json" in expected) {
    if (typeof actual !== "string") return [actual, decode(expected, context)];
    try {
      return project(JSON.parse(actual), expected.$json, context);
    } catch {
      return [actual, decode(expected, context)];
    }
  }
  if ("$map" in expected) {
    if (!(actual instanceof Map)) return [actual, decode(expected, context)];
    const keys = [...new Set([...actual.keys(), ...Object.keys(expected.$map)])];
    const pairs = keys.map((key) => [key, project(actual.get(key), expected.$map[key], context)]);
    return [new Map(pairs.map(([key, pair]) => [key, pair[0]])), new Map(pairs.map(([key, pair]) => [key, pair[1]]))];
  }
  if (!isRecord(actual)) return [actual, decode(expected, context)];
  const seen = {};
  const wanted = {};
  for (const [key, value] of Object.entries(expected)) [seen[key], wanted[key]] = project(actual[key], value, context);
  return [seen, wanted];
}

/** Plain data for the comparison: frozen and null-prototype objects compare as the plain objects they are. */
function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, plain(item)]));
  if (isRecord(value) && typeof value !== "function") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}

function matches(actual, expected, context, message) {
  const [seen, wanted] = project(actual, expected, context);
  NodeAssert.deepStrictEqual(plain(seen), plain(wanted), message);
}

const throws = (expected) => isRecord(expected) && expected.$ === "throws";

async function layOut(context, layout, locked) {
  const unreadable = [];
  for (const [path, entry] of Object.entries(layout)) {
    const target = join(context.dir, path);
    if (path.endsWith("/")) {
      await mkdir(target, { recursive: true });
      if (isRecord(entry) && entry.unreadable === true) unreadable.push(target);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    if (isRecord(entry) && entry.unreadable === true) {
      await writeFile(target, String(entry.text ?? ""));
      unreadable.push(target);
    } else {
      await writeFile(target, String(decode(entry, context)));
    }
  }
  // Modes after every file, the files before the directories that hold them.
  for (const path of unreadable.sort().reverse()) {
    await chmod(path, 0o000);
    locked.push(path);
  }
}

async function entriesOf(root, below = "") {
  const found = {};
  for (const name of (await readdir(join(root, below))).sort()) {
    const path = below + name;
    const info = await lstat(join(root, path));
    const mode = (info.mode & 0o777).toString(8);
    if (info.isDirectory()) {
      found[`${path}/`] = { mode };
      Object.assign(found, await entriesOf(root, `${path}/`));
    } else {
      found[path] = { text: await readFile(join(root, path), "utf8"), mode };
    }
  }
  return found;
}

async function listen(context, daemon, heard, locked, after) {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      heard.push(buffer.slice(0, end));
      buffer = "";
      if (daemon.reply === null) {
        socket.end();
        return;
      }
      socket.write(`${daemon.reply}\n`);
      after.push((async () => {
        for (const file of daemon.removes ?? []) await rm(join(context.dir, file), { force: true });
        if (daemon.locks === true) {
          locked.push(context.dir);
          await chmod(context.dir, 0o000);
        }
      })());
    });
  });
  await new Promise((resolve) => server.listen(join(context.dir, daemon.socket), resolve));
  if (daemon.unreadable === true) {
    const path = join(context.dir, daemon.socket);
    await chmod(path, 0o000);
    locked.push(path);
  }
  return server;
}

async function writeUntil(path, ready) {
  const deadline = Date.now() + 5_000;
  for (let n = 0; !ready(); n++) {
    if (Date.now() > deadline) throw new Error(`no change seen for ${path}`);
    await writeFile(path, `{"n":${n}}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function runSteps(context, steps, result) {
  const watch = isRecord(result) ? result : null;
  try {
    for (const step of steps) {
      if (step.directory !== undefined) {
        for (const name of await readdir(context.dir)) await rm(join(context.dir, name), { recursive: true, force: true });
        await layOut(context, step.directory, []);
      }
      if (typeof result === "function") matches(await result(), step.expect, context);
      if (step.mkdir !== undefined) await mkdir(join(context.dir, step.mkdir), { recursive: true });
      if (step.retry === true && typeof watch?.retry === "function") watch.retry();
      if (step.write !== undefined) {
        const before = context.changes;
        await writeUntil(join(context.dir, step.write), () => step.changed !== true || context.changes > before);
      }
    }
  } finally {
    if (typeof watch?.stop === "function") watch.stop();
  }
}

async function runNodeCase(entry, call) {
  // A short directory: a Unix socket's path is limited to 104 bytes on macOS.
  const context = { dir: await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "lbc-")), alive: entry.alive ?? [], changes: 0 };
  const locked = [];
  const heard = [];
  const after = [];
  let server;
  try {
    await layOut(context, entry.directory ?? {}, locked);
    if (entry.daemon !== undefined) server = await listen(context, entry.daemon, heard, locked, after);
    const args = decode(entry.args ?? [], context);
    if (throws(entry.expect)) {
      await NodeAssert.rejects(async () => call(...args));
      return;
    }
    const result = await call(...args);
    if (entry.steps === undefined) matches(result, entry.expect, context);
    else await runSteps(context, entry.steps, result);
    if (entry.heard !== undefined) NodeAssert.deepStrictEqual(heard, entry.heard);
    if (entry.after !== undefined) {
      const found = await entriesOf(context.dir);
      NodeAssert.deepStrictEqual(Object.keys(found).sort(), Object.keys(entry.after).sort());
      for (const [path, wanted] of Object.entries(entry.after)) {
        if (wanted.text !== undefined) NodeAssert.equal(found[path]?.text, wanted.text, path);
        if (wanted.json !== undefined) matches(found[path]?.text, { $json: wanted.json }, context, path);
        if (wanted.mode !== undefined) NodeAssert.equal(found[path]?.mode, wanted.mode, path);
      }
    }
  } finally {
    await Promise.allSettled(after);
    for (const path of locked.reverse()) await chmod(path, 0o700).catch(() => undefined);
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(context.dir, { recursive: true, force: true });
  }
}

const noContext = () => ({ dir: "", alive: [], changes: 0 });
// Mode-000 cases assume a runner that is not root, which reads such files anyway.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

for (const file of vectorFiles) {
  NodeTest.describe(`${file.contract} (${file.file})`, () => {
    for (const entry of file.cases) {
      const skip = (process.platform === "win32" && entry.daemon !== undefined) || (asRoot && JSON.stringify(entry).includes("\"unreadable\":true"));
      NodeTest.test(`${entry.call}: ${entry.name}`, { skip, timeout: 30_000 }, async () => {
        const target = exported[entry.call];
        if (typeof target !== "function") {
          NodeAssert.equal(entry.args, undefined, "a value export takes no arguments");
          matches(target, entry.expect, noContext());
          return;
        }
        if (entry.call in node) {
          await runNodeCase(entry, target);
          return;
        }
        const context = noContext();
        const args = decode(entry.args ?? [], context);
        if (throws(entry.expect)) {
          NodeAssert.throws(() => target(...args));
          return;
        }
        matches(target(...args), entry.expect, context);
      });
    }
  });
}
