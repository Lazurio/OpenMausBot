// Run with `pnpm exec electron scripts/smoke-approval-modes.cjs`.
// Lazurio overlay (DEV-6673): the runner of the isolated approval UI smokes, a
// disposable home and fake Claude/Codex/Grok CLIs; never the live app. The
// private Electron grant protocol it also exercised upstream is removed with
// Custom: every level, Full included, is set over the server's HTTP API.
const { app, utilityProcess } = require("electron");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const root = resolve(__dirname, "..");
const home = mkdtempSync(join(tmpdir(), "omb-approval-smoke-"));
app.setPath("userData", join(home, "electron"));
let child;
let logs = "";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function until(check) {
  const deadline = Date.now() + 30_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Fixture timed out. ${logs.slice(-2000)}`);
}

app.whenReady().then(async () => {
  const port = await freePort();
  let webhookPort = await freePort();
  while (webhookPort === port) webhookPort = await freePort();
  const codexDump = join(home, "codex.json");
  const grokDump = join(home, "grok.json");
  const grokRpc = join(home, "grok-rpc.json");
  const peerDump = join(home, "grok-peer.json");
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), "{}", { mode: 0o600 });
  const grokFixture = (mode, toolCall) => ({
    driver: "grokAgent", config: { cli: join(root, "server/testing/fake-acp-cli.ts") },
    environment: {
      FAKE_ACP_MODE: mode, FAKE_ACP_AUTH_METHOD: "cached_token",
      FAKE_ACP_MODELS: "grok-4.6,grok-4.5", FAKE_ACP_DUMP: grokDump, FAKE_ACP_RPC_DUMP: grokRpc,
      ...(toolCall ? { FAKE_ACP_PERMISSION_TOOL_CALL: JSON.stringify(toolCall) } : {}),
    },
  });
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    claude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } },
    codex: { driver: "codex", config: { cli: join(root, "server/testing/fake-codex-app-server.ts") }, environment: { FAKE_CODEX_MODE: "approval", FAKE_CODEX_DUMP: codexDump } },
    "grok-peer": { ...grokFixture(), environment: { FAKE_ACP_AUTH_METHOD: "cached_token", FAKE_ACP_MODELS: "grok-4.6,grok-4.5", FAKE_ACP_DUMP: peerDump } },
    "grok-reads": grokFixture("safe-agent-reads"),
    "grok-delete": grokFixture("permission", { kind: "delete", title: "Delete the project", rawInput: { path: "/fixture/project" } }),
    "grok-credential": grokFixture("permission", { kind: "other", title: "agents__request_credential", rawInput: { credential_id: "ttsKey" } }),
    "grok-spoof": grokFixture("permission", { kind: "execute", title: "agents__list_bots", rawInput: { command: "cat ~/.ssh/id_ed25519" } }),
    "grok-question": grokFixture("question"),
  } }));
  const dump = join(home, "claude-argv.json");
  const testCapabilityKey = randomUUID();
  child = utilityProcess.fork(join(root, "server/index.ts"), [], {
    cwd: root,
    execArgv: ["--experimental-strip-types"],
    env: {
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: home, PATH: "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(webhookPort),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: testCapabilityKey,
      FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dump,
      FAKE_ACP_MODE: "permission", FAKE_ACP_AUTH_METHOD: "oauth-personal",
      FAKE_ACP_MODELS: "gemini-3.8-flash-high,gemini-3.8-flash-low", FAKE_ACP_MODES: "default,yolo",
    },
    stdio: "pipe",
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const api = async (path, method = "GET", body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  await until(() => api("/api/health").catch(() => null));
  const skillUi = () => require("./testing/skill-approval-ui-smoke.cjs")({ root, home, url: `http://127.0.0.1:${port}`, api, until,
    capability: (botId, threadId) => api("/api/testing/internal-capability", "POST", { botId, threadId, skillAuthoring: true }, { "x-openmausbot-test-capability": testCapabilityKey }),
  });
  const sidebarUi = () => require("./testing/sidebar-attention-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until });
  if (!process.argv.includes("--sidebar-attention-only")) await skillUi();
  if (!process.argv.includes("--skill-ui-only")) await sidebarUi();
  console.log("Approval UI smoke passed.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (child?.pid) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  rmSync(home, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
