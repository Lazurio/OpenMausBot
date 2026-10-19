// Run with `pnpm exec electron scripts/smoke-approval-modes.cjs`.
// Exercises the real private Electron utility-process grant protocol using
const { app, utilityProcess } = require("electron");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { createTrustedApprovalModeCoordinator } = require("../electron/approval-trusted-mode.cjs");

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
  if (process.argv.includes("--model-ui-only")) {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/config.toml"), 'model_provider = "fixture"\nmodel = "fixture-local"\n[model_providers.fixture]\nname = "Fixture local"\n');
  }
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
    claude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") },
      ...(process.argv.includes("--model-ui-only") ? { environment: { FAKE_CLAUDE_VERSION: "2.1.284" } } : {}) },
    codex: { driver: "codex", config: { cli: join(root, "server/testing/fake-codex-app-server.ts") }, environment: { FAKE_CODEX_MODE: "approval", FAKE_CODEX_DUMP: codexDump } },
    "grok-peer": { ...grokFixture(), environment: { FAKE_ACP_AUTH_METHOD: "cached_token", FAKE_ACP_MODELS: "grok-4.6,grok-4.5", FAKE_ACP_DUMP: peerDump } },
    "grok-reads": grokFixture("safe-agent-reads"),
    "grok-delete": grokFixture("permission", { kind: "delete", title: "Delete the project", rawInput: { path: "/fixture/project" } }),
    "grok-credential": grokFixture("permission", { kind: "other", title: "agents__request_credential", rawInput: { credential_id: "ttsKey" } }),
    "grok-spoof": grokFixture("permission", { kind: "execute", title: "agents__list_bots", rawInput: { command: "cat ~/.ssh/id_ed25519" } }),
    "grok-question": grokFixture("question"),
    ...(process.argv.includes("--model-ui-only") ? {
      "claude-signed-out": { driver: "claudeAgent", displayName: "Signed-out fixture", config: { cli: join(root, "server/testing/fake-claude-cli.ts") }, environment: { FAKE_CLAUDE_AUTH: "out" } },
      "missing-codex": { driver: "codex", displayName: "Missing provider fixture", config: { cli: join(home, "not-installed") } },
    } : {}),
  } }));
  const dump = join(home, "claude-argv.json");
  const testCapabilityKey = randomUUID();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
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
  child.on("message", (message) => coordinator.receive(child, message));
  child.on("exit", () => coordinator.rejectProcess(child));
  const api = async (path, method = "GET", body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  await until(() => api("/api/health").catch(() => null));
  const verifyUi = () => require("./testing/approval-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until,
    grant: (botId, mode, options) => coordinator.request(child, botId, mode, options),
  });
  if (process.argv.includes("--skill-ui-only")) {
    await require("./testing/skill-approval-ui-smoke.cjs")({ root, home, url: `http://127.0.0.1:${port}`, api, until,
      capability: (botId, threadId) => api("/api/testing/internal-capability", "POST", { botId, threadId, skillAuthoring: true }, { "x-openmausbot-test-capability": testCapabilityKey }),
    });
    return;
  }
  if (process.argv.includes("--sidebar-attention-only")) {
    await require("./testing/sidebar-attention-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until });
    return;
  }
  if (process.argv.includes("--ui-only")) { await verifyUi(); return; }
  if (process.argv.includes("--model-ui-only")) {
    await require("./testing/model-switch-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until,
      grant: (botId, mode, options) => coordinator.request(child, botId, mode, options),
    });
    return;
  }
  // One explicit grant covers old, archived and future threads, even if their
  // provider differs. Use the real private bridge, not fixture state edits.
  const whole = (await api("/api/bots", "POST", { name: "All threads fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  const untouched = (await api("/api/bots", "POST", { name: "Unrelated bot" })).body.bot;
  await coordinator.request(child, whole.id, "ask");
  const threads = [];
    const task = (await api(`/api/bots/${whole.id}/tasks`, "POST", { title: `Existing ${instanceId} conversation` })).body.task;
    assert.equal((await api(`/api/bots/${whole.id}/tasks/${task.threadId}`, "PATCH", { modelSelection: { instanceId, model } })).status, 200);
    threads.push(task.threadId);
  }
  assert.equal((await api(`/api/bots/${whole.id}/tasks/${threads[0]}`, "PATCH", { archivedAt: Date.now() })).status, 200);
  const allGranted = await coordinator.request(child, whole.id, "full", { allThreads: true });
  assert.equal(allGranted.approvalMode, "full");
  assert.ok(allGranted.tasks.every(task => task.approvalMode === "full"));
  const future = (await api(`/api/bots/${whole.id}/tasks`, "POST", { title: "Future thread" })).body.task;
  assert.equal(future.approvalMode, "full");
  assert.equal((await api("/api/bots?messages=0")).body.bots.find(bot => bot.id === untouched.id).approvalMode, untouched.approvalMode);
  const persisted = JSON.parse(readFileSync(join(home, "bots.json"), "utf8")).find(bot => bot.id === whole.id);
  assert.ok(persisted.tasks.every(task => task.approvalMode === "full"));
  assert.equal(persisted.approvalGrant, undefined);
  const revoked = await coordinator.request(child, whole.id, "ask", { allThreads: true });
  assert.equal(revoked.approvalMode, "ask");
  assert.ok(revoked.tasks.every(task => task.approvalMode === "ask"));
  // Auto and Edits reach every thread the same way, in one write.
  const autoEverywhere = await coordinator.request(child, whole.id, "auto", { allThreads: true });
  assert.equal(autoEverywhere.approvalMode, "auto");
  assert.ok(autoEverywhere.tasks.every(task => task.approvalMode === "auto"));
  assert.ok((await coordinator.request(child, whole.id, "ask", { allThreads: true })).tasks.every(task => task.approvalMode === "ask"));
  console.log(JSON.stringify({ allThreads: true, mixedProviders: true, archivedIncluded: true, futureInherits: true, unrelatedBotUnchanged: true, persisted: true }));
  if (process.argv.includes("--all-threads-only")) { await verifyUi(); return; }
  const created = await api("/api/bots", "POST", { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
  assert.equal(created.status, 201);
  const id = created.body.bot.id;
  // Full needs no private channel: the API applies it at once. Custom keeps
  // the private channel (checked below).
  assert.equal((await api(`/api/bots/${id}`, "PATCH", { approvalMode: "full" })).status, 200);
  assert.equal((await api(`/api/bots/${id}`, "PATCH", { approvalMode: "ask" })).status, 200);
  for (const [mode, native] of [["full", "bypassPermissions"], ["auto", "auto"], ["edits", "acceptEdits"], ["ask", "default"]]) {
    await coordinator.request(child, id, mode);
    await until(async () => (await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === id)?.approvalMode === mode);
    assert.equal((await api(`/api/bots/${id}/messages`, "POST", { text: `Verify ${mode}` })).status, 202);
    await until(async () => !(await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === id)?.busy);
    const argv = JSON.parse(readFileSync(dump, "utf8")).argv;
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], native);
    if (mode !== "full") assert.ok(argv.includes("--resume"));
    console.log(JSON.stringify({ mode, native, privateGrant: true, turnSettled: true }));
  }
  await assert.rejects(coordinator.request(child, id, "custom"), /only for Codex/);
  // Existing conversations retain their snapshot when the bot default
  // changes. Only an explicit private desktop grant may upgrade one thread.
    const scoped = (await api("/api/bots", "POST", { name: "Existing thread", modelSelection: { instanceId, model } })).body.bot;
    await coordinator.request(child, scoped.id, "ask");
    const old = (await api(`/api/bots/${scoped.id}/tasks`, "POST", { title: "Existing Ask thread" })).body.task;
    const other = (await api(`/api/bots/${scoped.id}/tasks`, "POST", { title: "Leave this thread alone" })).body.task;
    assert.ok(old?.threadId && other?.threadId);
    await assert.rejects(coordinator.request(child, scoped.id, "full", { threadId: old.threadId }), /bot settings/);
    await coordinator.request(child, scoped.id, "full");
    const readScoped = async () => (await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === scoped.id);
    await until(async () => (await readScoped()).approvalMode === "full");
    if (instanceId === "claude") {
      assert.equal((await api(`/api/bots/${scoped.id}/tasks/${other.threadId}`, "PATCH", { approvalMode: "edits" })).status, 200);
      await api(`/api/bots/${scoped.id}/tasks/${other.threadId}`, "PATCH", { approvalMode: "ask", modelSelection: { instanceId: "codex", model: "gpt-6-astra" } });
      await assert.rejects(coordinator.request(child, scoped.id, "full", { threadId: other.threadId }), /bot's provider/);
      assert.equal((await api(`/api/bots/${scoped.id}/tasks/${other.threadId}`, "PATCH", { approvalMode: "edits" })).status, 400);
    }
    assert.equal((await readScoped()).tasks.find((task) => task.threadId === old.threadId).approvalMode, "ask");
    // Any client may give one thread Full over the API; the private grant
    // below must still work on the same thread once it is back on Ask.
    assert.equal((await api(`/api/bots/${scoped.id}/tasks/${old.threadId}`, "PATCH", { approvalMode: "full" })).status, 200);
    assert.equal((await api(`/api/bots/${scoped.id}/tasks/${old.threadId}`, "PATCH", { approvalMode: "ask" })).status, 200);
    if (instanceId === "codex") {
      assert.equal((await api(`/api/bots/${scoped.id}`, "PATCH", { approvalMode: "custom" })).status, 403);
      assert.equal((await api(`/api/bots/${scoped.id}/tasks/${old.threadId}`, "PATCH", { approvalMode: "custom" })).status, 403);
    }
    await coordinator.request(child, scoped.id, "full", { threadId: old.threadId });
    await until(async () => (await readScoped()).tasks.find((task) => task.threadId === old.threadId).approvalMode === "full");
    assert.equal((await readScoped()).tasks.find((task) => task.threadId === other.threadId).approvalMode, "ask");
    await assert.rejects(coordinator.request(child, scoped.id, "full", { threadId: "missing-thread" }), /bot settings/);
    const sent = await api(`/api/bots/${scoped.id}/messages`, "POST", { text: "Verify existing thread Full", threadId: old.threadId });
    assert.equal(sent.status, 202);
    await until(async () => !(await readScoped()).tasks.find((task) => task.threadId === old.threadId).busy);
    const seen = JSON.parse(readFileSync(source, "utf8"));
    if (instanceId === "claude") assert.equal(seen.argv[seen.argv.indexOf("--permission-mode") + 1], "bypassPermissions");
    if (instanceId === "grok-reads") assert.equal(seen.argv[seen.argv.indexOf("--permission-mode") + 1], "bypassPermissions");
    if (instanceId === "codex") assert.equal(seen.calls.find((call) => call.method === "turn/start").params.approvalPolicy, "never");
    console.log(JSON.stringify({ provider: instanceId, existingThread: "full", otherThread: "ask", privateGrant: true, turnSettled: true }));
  }
  const pendingCard = (bot) => bot.messages.find((message) => message.card?.requestId && !message.card.answered && !message.card.dismissed)?.card;
  // Composer grants are independent: an Ask default is not a prerequisite
  // trip through settings, and a thread may use a different provider.
  const direct = (await api("/api/bots", "POST", { name: "Composer scoped access", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await coordinator.request(child, direct.id, "ask");
  const selected = (await api(`/api/bots/${direct.id}/tasks`, "POST", { title: "Select Full here" })).body.task;
  const sibling = (await api(`/api/bots/${direct.id}/tasks`, "POST", { title: "Keep Ask here" })).body.task;
  const committed = await coordinator.request(child, direct.id, "full", { threadId: selected.threadId, threadOnly: true });
  assert.equal(committed.approvalMode, "ask");
  assert.equal(committed.tasks.find(task => task.threadId === selected.threadId).approvalMode, "full");
  assert.equal(committed.tasks.find(task => task.threadId === sibling.threadId).approvalMode, "ask");
  await assert.rejects(coordinator.request(child, direct.id, "full", { threadId: "missing", threadOnly: true }), /existing thread/);
  await coordinator.request(child, direct.id, "ask", { threadId: selected.threadId, threadOnly: true });
  await api(`/api/bots/${direct.id}/tasks/${selected.threadId}`, "PATCH", { modelSelection: { instanceId: "codex", model: "gpt-6-astra" } });
  const custom = await coordinator.request(child, direct.id, "custom", { threadId: selected.threadId, threadOnly: true });
  assert.equal(custom.approvalMode, "ask");
  assert.equal(custom.tasks.find(task => task.threadId === selected.threadId).approvalMode, "custom");
  const downgraded = await coordinator.request(child, direct.id, "ask", { threadId: selected.threadId, threadOnly: true });
  assert.equal(downgraded.tasks.find(task => task.threadId === selected.threadId).approvalMode, "ask");
  assert.equal(downgraded.approvalMode, "ask");
  console.log(JSON.stringify({ composerGrant: true, defaultRemainsAsk: true, customOnDifferentThreadProvider: true, committedReply: true }));
  const parallel = (await api("/api/bots", "POST", { name: "Parallel permission fixture", modelSelection: { instanceId: "grok-delete", model: "grok-4.6" } })).body.bot;
  await coordinator.request(child, parallel.id, "ask");
  const working = (await api(`/api/bots/${parallel.id}/tasks`, "POST", { title: "Already running" })).body.task;
  const idle = (await api(`/api/bots/${parallel.id}/tasks`, "POST", { title: "Configure independently" })).body.task;
  assert.equal((await api(`/api/bots/${parallel.id}/tasks/${working.threadId}`, "POST")).status, 200);
  assert.equal((await api(`/api/bots/${parallel.id}/messages`, "POST", { text: "Hold for fixture approval", threadId: working.threadId })).status, 202);
  const held = await until(async () => pendingCard((await api("/api/bots")).body.bots.find(bot => bot.id === parallel.id)));
  const separate = await coordinator.request(child, parallel.id, "full", { threadId: idle.threadId, threadOnly: true });
  assert.equal(separate.tasks.find(task => task.threadId === working.threadId).busy, true);
  assert.equal(separate.tasks.find(task => task.threadId === working.threadId).approvalMode, "ask");
  assert.equal(separate.tasks.find(task => task.threadId === idle.threadId).approvalMode, "full");
  // A level picked while the bot works is saved at once; the card already open stays for the person to answer.
  const whileWorking = await coordinator.request(child, parallel.id, "full", { threadId: working.threadId, threadOnly: true });
  assert.equal(whileWorking.tasks.find(task => task.threadId === working.threadId).busy, true);
  assert.equal(whileWorking.tasks.find(task => task.threadId === working.threadId).approvalMode, "full");
  assert.equal(pendingCard((await api("/api/bots")).body.bots.find(bot => bot.id === parallel.id))?.requestId, held.requestId);
  await api(`/api/bots/${parallel.id}/respond`, "POST", { requestId: held.requestId, behavior: "deny" });
  await until(async () => !(await api("/api/bots?messages=0")).body.bots.find(bot => bot.id === parallel.id).busy);
  console.log(JSON.stringify({ composerGrantWhileSiblingBusy: true, siblingNotInterrupted: true, composerGrantWhileBusy: true, openCardKept: true }));
  // The fake reviewer only approves the two known reads under native Auto.
  // Their actual MCP calls reach this real isolated server. This verifies the
  // routing contract, not the availability/quality of Grok's hosted reviewer.
  for (const model of ["grok-4.6", "grok-4.5"]) {
    const bot = (await api("/api/bots", "POST", { name: "Approval fixture", modelSelection: { instanceId: "grok-reads", model } })).body.bot;
    for (const [turn, mode] of ["auto", "auto", "ask"].entries()) {
      await coordinator.request(child, bot.id, mode);
      const before = (await api("/api/bots")).body.bots.find((candidate) => candidate.id === bot.id).messages.length;
      assert.equal((await api(`/api/bots/${bot.id}/messages`, "POST", { text: `Approval fixture ${model} ${mode}` })).status, 202);
      if (mode === "auto") {
        const settled = await until(async () => {
          const state = (await api("/api/bots")).body.bots.find((candidate) => candidate.id === bot.id);
          assert.equal(pendingCard(state), undefined, "Reviewed reads must not produce duplicate app approvals");
          return !state.busy && state;
        });
        const text = settled.messages.slice(before).map((message) => message.text ?? "").join("\n");
        // Anchored to line starts: session_search's result quotes earlier
        // reads mid-line.
        assert.match(text, /^list_bots:/m);
        assert.match(text, /^session_search:/m);
        assert.equal((text.match(/^list_bots:/gm) ?? []).length, 2, "Repeated reads complete without another prompt");
      } else {
        const card = await until(async () => pendingCard((await api("/api/bots")).body.bots.find((candidate) => candidate.id === bot.id)));
        assert.equal((await api(`/api/bots/${bot.id}/respond`, "POST", { requestId: card.requestId, behavior: "deny" })).status, 200);
        await until(async () => !(await api("/api/bots?messages=0")).body.bots.find((candidate) => candidate.id === bot.id)?.busy);
      }
      const argv = JSON.parse(readFileSync(grokDump, "utf8")).argv;
      assert.equal(argv[argv.indexOf("--permission-mode") + 1], mode === "auto" ? "auto" : "default");
      assert.equal(argv[argv.indexOf("-m") + 1], model);
      // The same level keeps the live session; a new level gives the
      // integrations new credentials, so the conversation is loaded again.
      const methods = JSON.parse(readFileSync(grokRpc, "utf8"));
      assert.ok(methods.includes(turn < 2 ? "session/new" : "session/load"));
      if (turn < 2) assert.ok(!methods.includes("session/load"));
      console.log(JSON.stringify({ provider: "grok", model, mode, resumed: turn === 2, reviewedReads: mode === "auto", realAgentsMcp: true }));
    }
  }
  for (const instanceId of ["grok-delete", "grok-credential", "grok-spoof", "grok-question"]) {
    const bot = (await api("/api/bots", "POST", { modelSelection: { instanceId, model: "grok-4.6" } })).body.bot;
    await coordinator.request(child, bot.id, "auto");
    assert.equal((await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Verify this action still needs a person" })).status, 202);
    const card = await until(async () => pendingCard((await api("/api/bots")).body.bots.find((candidate) => candidate.id === bot.id)));
    if (instanceId === "grok-question") assert.deepEqual(card.options, ["Blue", "Green"]);
    else assert.equal(card.held, "The provider requires your approval for this action.");
    assert.equal((await api(`/api/bots/${bot.id}/respond`, "POST", { requestId: card.requestId, behavior: "deny" })).status, 200);
    await until(async () => !(await api("/api/bots?messages=0")).body.bots.find((candidate) => candidate.id === bot.id)?.busy);
    console.log(JSON.stringify({ provider: "grok", case: instanceId, mode: "auto", remainedInteractive: true }));
  }
  // The test-only capability drives the real peer dispatch route without
  // introducing another fake-agent workflow or weakening production auth.
  await coordinator.request(child, peerTarget.id, "ask");
  const peerThread = (await api(`/api/bots/${peerTarget.id}/tasks`, "POST", { title: "Unrelated selected conversation" })).body.task;
  await coordinator.request(child, peerTarget.id, "full");
  await coordinator.request(child, peerTarget.id, "full", { threadId: peerThread.threadId });
  assert.equal((await api(`/api/bots/${id}`, "PATCH", { approvePeerComms: false })).status, 200);
  const capability = await api("/api/testing/internal-capability", "POST", { botId: id, threadId: created.body.bot.threadId }, { "x-openmausbot-test-capability": testCapabilityKey });
  assert.equal(capability.status, 201);
  const peerResponse = await api("/api/internal/coordinate-bots", "POST", { botIds: [peerTarget.id], message: "Peer-initiated permission fixture", consult: true }, { authorization: `Bearer ${capability.body.token}` });
  assert.equal(peerResponse.status, 200);
  // Coordination opens its own work thread without selecting it in the UI.
  const peerWorkThreadId = peerResponse.body.receipts[0].threadId;
  assert.ok(peerWorkThreadId);
  assert.notEqual(peerWorkThreadId, peerThread.threadId);
  const peerDecisions = await until(async () => {
    const rows = (await api("/api/decisions")).body.decisions.filter((row) => row.botId === peerTarget.id && row.threadId === peerWorkThreadId);
    return rows.some((row) => row.source === "full-access") && rows;
  });
  await until(async () => (await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === peerTarget.id)
    .tasks.find((task) => task.threadId === peerWorkThreadId)?.busy === false);
  assert.ok(!pendingCard((await api(`/api/threads/${peerWorkThreadId}/messages`)).body));
  assert.ok(!peerDecisions.some((row) => row.decision === "card-shown"));

  // Revoking the receiving thread's grant must restore prompts on the resumed
  // delegated session, even when the sender itself has Full access.
  await coordinator.request(child, id, "full");
  await coordinator.request(child, peerTarget.id, "ask");
  assert.equal((await api(`/api/bots/${peerTarget.id}/tasks/${peerWorkThreadId}`, "PATCH", { approvalMode: "ask" })).status, 200);
  const revokedPeer = (await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === peerTarget.id);
  assert.equal(revokedPeer.tasks.find((task) => task.threadId === peerWorkThreadId).approvalMode, "ask");
  assert.equal(revokedPeer.tasks.find((task) => task.threadId === peerThread.threadId).approvalMode, "full");
  const askPeerResponse = await api("/api/internal/coordinate-bots", "POST", { botIds: [peerTarget.id], message: "Ask target must not inherit sender Full", consult: true }, { authorization: `Bearer ${capability.body.token}` });
  assert.equal(askPeerResponse.status, 200);
  assert.equal(askPeerResponse.body.receipts[0].threadId, peerWorkThreadId);
  const peerCard = await until(async () => pendingCard((await api(`/api/threads/${peerWorkThreadId}/messages`)).body));
  const askDecision = (await api("/api/decisions")).body.decisions.find((row) => row.threadId === peerWorkThreadId && row.requestId === peerCard.requestId);
  assert.equal(askDecision.decision, "card-shown");
  assert.notEqual(askDecision.source, "full-access");
  assert.equal((await api(`/api/threads/${peerWorkThreadId}/respond`, "POST", { requestId: peerCard.requestId, behavior: "allow" })).status, 200);
  await until(async () => (await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === peerTarget.id)
    .tasks.find((task) => task.threadId === peerWorkThreadId)?.busy === false);

  // Custom is downgraded for delegated turns. Both the provider dispatch and
  // the residual approval fold must use that same effective Auto mode.
  const customTarget = (await api("/api/bots", "POST", { modelSelection: { instanceId: "codex", model: "gpt-fake-default" } })).body.bot;
  await coordinator.request(child, customTarget.id, "custom");
  const customResponse = await api("/api/internal/coordinate-bots", "POST", { botIds: [customTarget.id], message: "Delegated Custom uses the native Auto reviewer", consult: true }, { authorization: `Bearer ${capability.body.token}` });
  assert.equal(customResponse.status, 200);
  const customThreadId = customResponse.body.receipts[0].threadId;
  assert.ok(customThreadId);
  assert.notEqual(customThreadId, customTarget.threadId);
  const customCard = await until(async () => pendingCard((await api(`/api/threads/${customThreadId}/messages`)).body));
  assert.equal(customCard.held, "The provider requires your approval for this action.");
  assert.equal((await api(`/api/threads/${customThreadId}/respond`, "POST", { requestId: customCard.requestId, behavior: "allow" })).status, 200);
  await until(async () => (await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === customTarget.id)
    .tasks.find((task) => task.threadId === customThreadId)?.busy === false);
  const customCalls = JSON.parse(readFileSync(codexDump, "utf8")).calls;
  assert.equal(customCalls.find((call) => call.method === "turn/start")?.params.approvalsReviewer, "auto_review");
  console.log(JSON.stringify({ provider: "codex", mode: "custom", peerInitiated: true, effectiveMode: "auto", nativeApprovalShown: true }));
  if (process.argv.includes("--ui")) {
    await verifyUi();
    await require("./testing/sidebar-attention-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until });
  }
  console.log("Approval smoke passed; HTTP elevation rejected, private grant and resumed mode transitions verified.");
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
