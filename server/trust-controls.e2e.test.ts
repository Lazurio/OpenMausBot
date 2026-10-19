import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { SessionRegistry } from "./sessions.ts";
import { waitForExit } from "./testing/cleanup.ts";

const key = "isolated-trust-capability";
let fixture: VerificationServer;
let child: ChildProcess;
let admin: string;
let member: string;
const evidence: unknown[] = [];
const api = async (method: string, path: string, body?: unknown, token = admin) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  const result = { status: response.status, body: await response.json() as any };
  evidence.push({ method, path, result });
  return result;
};
// Below Full access, so a bot's team facts land at Ask.
const bot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await api("PATCH", `/api/bots/${created.body.bot.id}`, { approvalMode: "ask" })).status).toBe(200);
  return created.body.bot;
};
const mint = async (botId: string, threadId: string, kind = "agents") => {
  const response = await fetch(fixture.info.url + "/api/testing/internal-capability", {
    method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": key },
    body: JSON.stringify({ botId, threadId, kind }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as any).token as string;
};
const cards = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).body.messages as any[];
beforeAll(async () => {
  fixture = await launchVerificationServer();
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const configFile = join(fixture.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.signIn = { admins: ["admin@fixture.test"], members: ["member@fixture.test"] };
  writeFileSync(configFile, JSON.stringify(config));
  const sessions = new SessionRegistry({ file: join(fixture.info.dataDir, "sessions.json"),
    emailScopes: email => email === "admin@fixture.test" ? ["admin", "client"] : ["client"] });
  admin = sessions.issue({ label: "isolated admin", email: "admin@fixture.test", scopes: ["admin", "client"] }).token;
  member = sessions.issue({ label: "isolated member", email: "member@fixture.test", scopes: ["client"] }).token;
  sessions.close();
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...verificationServerEnvironment({}, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: key },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(fixture.info.url + "/api/health")).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("isolated trust server did not start");
}, 40_000);

afterAll(async () => {
  const evidencePath = fixture.info.logPath + ".trust-controls.json";
  writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence }, null, 2));
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture.close();
  console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath, fixtureRemoved: !existsSync(fixture.info.dataDir) }));
});

it("keeps activity, shared memory and policy changes admin-only", async () => {
  const b = await bot("Trust authority");
  expect((await api("GET", `/api/bots/${b.id}/activity`)).status).toBe(200);
  expect((await api("GET", `/api/bots/${b.id}/activity`, undefined, member)).status).toBe(403);
  expect((await api("GET", "/api/team-memory?section=", undefined, member)).status).toBe(403);
  expect((await api("POST", "/api/team-memory?section=", { kind: "term", name: "Denied", detail: "not admin" }, member)).status).toBe(403);
  expect((await api("PATCH", "/api/team-memory/fixture?section=", { detail: "not admin" }, member)).status).toBe(403);
  expect((await api("DELETE", "/api/team-memory/fixture?section=", undefined, member)).status).toBe(403);
  expect((await api("PATCH", `/api/bots/${b.id}`, { fallback: [] }, member)).status).toBe(403);
  expect((await api("PATCH", `/api/bots/${b.id}`, { fallback: [{ instanceId: "claude", model: " " }] })).status).toBe(400);
});

it("applies a bot's team fact at Ask with an Undo only an admin may use, and still refuses restricted memory", async () => {
  const b = await bot("Team facts");
  const token = await mint(b.id, b.threadId);
  const propose = (detail: string) => api("POST", "/api/internal/team-memory",
    { fromBotId: b.id, fromThreadId: b.threadId, kind: "person", name: "Alex", detail }, token);
  const remembered = async () => (await api("GET", "/api/team-memory?section=")).body.entries
    .filter((entry: any) => entry.name === "Alex" && entry.status === "accepted").map((entry: any) => entry.detail);
  const first = await propose("original");
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body).toMatchObject({ status: "applied", state: "applied" });
  expect(await remembered()).toEqual(["original"]);
  expect((await cards(b.threadId)).find((row: any) => row.card?.requestId === first.body.requestId).card)
    .toMatchObject({ title: "Remembered for the team", answered: "allow", autoApplied: true, options: [] });
  const replacement = await propose("replacement");
  expect(replacement.body.state).toBe("applied");
  expect(await remembered()).toEqual(["replacement"]);
  expect((await api("POST", `/api/threads/${b.threadId}/undo`, { requestId: replacement.body.requestId }, member)).status).toBe(403);
  expect((await api("POST", `/api/threads/${b.threadId}/undo`, { requestId: replacement.body.requestId })).body).toMatchObject({ ok: true, undone: true });
  expect(await remembered()).toEqual(["original"]);
  await api("PATCH", `/api/bots/${b.id}`, { visibility: "admins" });
  expect((await propose("private")).status).toBe(403);
  const publicBot = await bot("Public room participant");
  await api("PATCH", `/api/bots/${b.id}`, { visibility: null });
  const room = await api("POST", "/api/groups", { name: "Restricted room", memberIds: [publicBot.id, b.id] });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  const roomThread = room.body.group.threadId;
  await api("PATCH", `/api/bots/${b.id}`, { visibility: "admins" });
  const roomToken = await mint(publicBot.id, roomThread);
  expect((await api("POST", "/api/internal/team-memory", { fromBotId: publicBot.id, fromThreadId: roomThread,
    kind: "term", name: "Private room term", detail: "cannot share with sibling bots" }, roomToken)).status).toBe(403);
  expect((await api("POST", "/api/team-memory?section=", { kind: "term", name: "Human", detail: "approved by admin" })).status).toBe(201);
});

it("puts a bot's fact into every teammate's prompt at once, and Undo takes it back out", async () => {
  const b = await bot("Team context");
  const token = await mint(b.id, b.threadId);
  const name = "Payroll drive";
  const detail = "APPLIED_PLACE_7Q: the shared payroll folder";
  const proposed = await api("POST", "/api/internal/team-memory", { fromBotId: b.id, fromThreadId: b.threadId, kind: "place", name, detail }, token);
  expect(proposed.body).toMatchObject({ status: "applied", state: "applied" });
  expect(JSON.stringify((await api("GET", `/api/bots/${b.id}/system-prompt`)).body)).toContain(detail);
  expect((await api("POST", `/api/threads/${b.threadId}/undo`, { requestId: proposed.body.requestId })).body).toMatchObject({ ok: true, undone: true });
  expect(JSON.stringify((await api("GET", `/api/bots/${b.id}/system-prompt`)).body)).not.toContain(detail);
  expect((await api("GET", "/api/team-memory?section=")).body.entries.some((entry: any) => entry.name === name)).toBe(false);
  expect((await cards(b.threadId)).find((row: any) => row.card?.requestId === proposed.body.requestId).card).toMatchObject({ undone: true });
  expect((await api("POST", `/api/threads/${b.threadId}/undo`, { requestId: proposed.body.requestId })).body).toMatchObject({ alreadyUndone: true });
});

it("preserves an engine referenced by a fallback chain before delete", async () => {
  const endpoint = await api("POST", "/api/instances/openai-compat", { displayName: "Fallback fixture endpoint", url: "http://127.0.0.1:9/v1", key: "fixture-only", models: ["fixture-model"] });
  expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);
  const instanceId = endpoint.body.instanceId;
  const b = await bot("Referenced fallback");
  expect((await api("PATCH", `/api/bots/${b.id}`, { fallback: [{ instanceId, model: "fixture-model" }] })).status).toBe(200);
  expect((await api("DELETE", `/api/instances/${instanceId}`)).status).toBe(409);
  await api("PATCH", `/api/bots/${b.id}`, { fallback: [] });
  expect((await api("DELETE", `/api/instances/${instanceId}`)).status).toBe(200);
});
