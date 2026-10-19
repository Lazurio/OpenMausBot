// The agent-browser the UI tests drive MausBot's own web UI with: developer test tooling, not a
// bot's browser.
//
// Lazurio overlay (DEV-6673, task 2026-10-18-205; root decision 0191 points 34 and 41–43): this is
// upstream's code from server/browser-engine.ts, server/browser-engine-release.ts and
// server/browser/egress/gate.ts, moved here and trimmed to what `control-omb ui` and the UI e2e
// tests use. Lazurio removes the server's own browser engine (a bot works in the Environment
// browser through Lazurio's agent-browser, server/lazurio-environment-browser.ts), so nothing in
// server/ downloads, resolves or closes an agent-browser any more; the test harness keeps its
// pinned binary and its Chrome for Testing here. Trimmed: the packaged desktop bundle lookup and
// the process-tree fallback of a close (a close now waits until agent-browser no longer lists the
// session).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const ENGINE_DIR = "tools/agent-browser";
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

// Digests computed from the official GitHub assets on 2026-09-08, except the versioned Windows
// vendor build; update pins only through a reviewed native end-to-end run.
const AGENT_BROWSER_VERSION = "0.37.0";

interface AgentBrowserReleaseAsset {
  /** `<platform>-<arch>`; Linux adds `-musl` on Alpine-style systems. */
  target: string;
  asset: string;
  sha256: string;
  bytes: number;
  /** A reviewed platform-specific vendor revision; other assets use the upstream version. */
  version?: string;
  /** Exact release URL for a reviewed vendor build, never a mutable latest URL. */
  url?: string;
}

const RELEASES = new Map<string, AgentBrowserReleaseAsset>([
  [
    "darwin-arm64",
    { target: "darwin-arm64", asset: "agent-browser-darwin-arm64", sha256: "da5a2b4ef7be8ba279b1258c542c33877f480b1951d0d94de607fc1528edd380", bytes: 12429360 },
  ],
  [
    "darwin-x64",
    { target: "darwin-x64", asset: "agent-browser-darwin-x64", sha256: "f402c96350ffd2adc68d0e5e4d83aa49cf7735fef29882a8866be36cc2fc67e9", bytes: 13588296 },
  ],
  [
    "linux-arm64",
    { target: "linux-arm64", asset: "agent-browser-linux-arm64", sha256: "0315a8c4f7bf167cc5fd5eeaea79009b0e6b5d2ae8b3057bf6f96be978483426", bytes: 12507840 },
  ],
  [
    "linux-musl-arm64",
    { target: "linux-musl-arm64", asset: "agent-browser-linux-musl-arm64", sha256: "db67c0e84e0668c052c2cbdca325c57f896e309c3723755dcdd65b700f8a2b52", bytes: 12369352 },
  ],
  [
    "linux-musl-x64",
    { target: "linux-musl-x64", asset: "agent-browser-linux-musl-x64", sha256: "5cff3bc7b2486867aba2901f92c9ce6029bd2a37951630d9feec1c5b3fee402e", bytes: 14092888 },
  ],
  [
    "linux-x64",
    { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: "78e0c5a14a7fa1f3d1ae2acdbdcc94a047b435b998a8c505fcc49d7fa4935a49", bytes: 14253776 },
  ],
  [
    "win32-x64",
    {
      // Upstream 0.37.0 still lacks vercel-labs/agent-browser#1781's Windows cold-start fix.
      // Retain the native-verified revision until its replacement is tested.
      target: "win32-x64", version: "0.36.0-omb.1",
      asset: "agent-browser-win32-x64-0.36.0-omb.1.exe",
      url: "https://github.com/milind-soni/OpenMausBot/releases/download/browser-engine-v0.36.0-omb.1/agent-browser-win32-x64-0.36.0-omb.1.exe",
      sha256: "33bee834f6a6072ec8688b0914726e0262874d758f69f27e8baf7eaac6b5ed15", bytes: 13806080,
    },
  ],
]);

function releaseUrl(asset: AgentBrowserReleaseAsset): string {
  return asset.url ?? `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${asset.asset}`;
}

function releaseVersion(asset: AgentBrowserReleaseAsset | null): string {
  return asset?.version ?? AGENT_BROWSER_VERSION;
}

/** The asset for this machine, or null where Vercel publishes none. */
function releaseAsset(platform: NodeJS.Platform, arch: string, musl = false): AgentBrowserReleaseAsset | null {
  const key = platform === "linux" && musl ? `linux-musl-${arch}` : `${platform}-${arch}`;
  return RELEASES.get(key) ?? null;
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "agent-browser.exe" : "agent-browser";
}

/** Alpine-style systems need the musl build. */
function isMusl(platform: NodeJS.Platform): boolean {
  return platform === "linux" && (existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1"));
}

function pinnedBinaryPath(dataDir: string, platform: NodeJS.Platform, arch: string): string {
  return join(dataDir, ENGINE_DIR, releaseVersion(releaseAsset(platform, arch)), executableName(platform));
}

function onPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const pathValue = platform === "win32"
    ? Object.entries(env).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
    : env.PATH;
  for (const part of (pathValue ?? "").split(delimiter)) {
    const dir = part.trim().replace(/^"|"$/gu, "");
    if (!dir) continue;
    const candidate = resolve(dir, executableName(platform));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** OMB_UI_AGENT_BROWSER_PATH, then the pinned binary under the tools directory, then PATH. */
export function resolveAgentBrowserBinary(options: { dataDir: string; env?: NodeJS.ProcessEnv }): string | null {
  const env = options.env ?? process.env;
  const override = env.OMB_UI_AGENT_BROWSER_PATH?.trim();
  if (override) return existsSync(resolve(override)) ? resolve(override) : null;
  const pinned = pinnedBinaryPath(options.dataDir, process.platform, process.arch);
  if (existsSync(pinned)) return pinned;
  return onPath(env, process.platform);
}

/** Downloads the pinned release into the tools directory; verifies size and SHA-256 before the file gets its final name. */
export async function installAgentBrowserBinary(options: { dataDir: string; log?: (line: string) => void }): Promise<string> {
  const platform = process.platform;
  const asset = releaseAsset(platform, process.arch, isMusl(platform));
  if (!asset) throw new Error(`agent-browser publishes no build for ${platform}-${process.arch}.`);
  const destination = pinnedBinaryPath(options.dataDir, platform, process.arch);
  const directory = join(destination, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  options.log?.(`downloading agent-browser ${releaseVersion(asset)} (${Math.round(asset.bytes / 1024 / 1024)} MB, digest pinned)`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  let body: Buffer;
  try {
    const response = await fetch(releaseUrl(asset), { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`the agent-browser download failed (HTTP ${response.status})`);
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared !== asset.bytes) throw new Error("the agent-browser download did not match its pinned size; nothing was installed");
    // Stream, never buffer: a body past the pinned size is cut off mid-flight.
    const chunks: Uint8Array[] = [];
    let received = 0;
    if (response.body) {
      try {
        for await (const chunk of response.body) {
          chunks.push(chunk);
          received += chunk.byteLength;
          if (received > asset.bytes) { controller.abort(); break; }
        }
      } catch (error) {
        if (received <= asset.bytes) throw error;
      }
      body = Buffer.concat(chunks);
    } else {
      body = Buffer.from(await response.arrayBuffer());
      if (body.length > asset.bytes) controller.abort();
    }
  } finally {
    clearTimeout(timer);
  }
  if (body.length !== asset.bytes) throw new Error("the agent-browser download did not match its pinned size; nothing was installed");
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== asset.sha256) throw new Error("the agent-browser download failed its SHA-256 check; nothing was installed");
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".part")) continue;
      try { unlinkSync(join(directory, name)); } catch {}
    }
  } catch {}
  const staging = `${destination}.${randomBytes(6).toString("hex")}.part`;
  writeFileSync(staging, body, { mode: 0o755 });
  if (platform !== "win32") chmodSync(staging, 0o755);
  renameSync(staging, destination);
  return destination;
}

/** `agent-browser install` fetches Chrome for Testing when no Chrome, Chromium or Brave is found. */
export function ensureChrome(binaryPath: string, options: { env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {}): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(binaryPath, ["install"], { env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const record = (chunk: Buffer) => {
      output += String(chunk);
      if (output.length > 262_144) output = output.slice(-262_144);
    };
    child.stdout?.on("data", record);
    child.stderr?.on("data", record);
    let timedOut = false;
    let exited = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5_000);
      killTimer.unref?.();
      fail(new Error("agent-browser install timed out"));
    }, DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (error) => { exited = true; clearTimeout(timer); fail(error); });
    child.on("exit", (code) => {
      exited = true;
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        options.log?.("agent-browser: Chrome is ready");
        done();
      } else {
        fail(new Error(`agent-browser install exited ${code ?? "by signal"}: ${output.trim().split("\n").slice(-3).join(" ")}`));
      }
    });
  });
}

/** Chrome's flags that keep a test profile out of the OS keychain or password store. */
export function credentialStoreFlags(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? ["--use-mock-keychain"] : platform === "linux" ? ["--password-store=basic"] : [];
}

/** Session identity without launch flags: agent-browser prepends a launch even to `close` when they are set. */
function controlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("AGENT_BROWSER_")
    || ["AGENT_BROWSER_SESSION", "AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_NAMESPACE"].includes(key)));
}

function runBrowserCommand(binaryPath: string, env: NodeJS.ProcessEnv, args: string[], deadline: number, capture = false): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    let settled = false;
    let output = "";
    const finish = (ok: boolean) => { if (!settled) { settled = true; done({ ok, output }); } };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(binaryPath, args, { env, stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore", windowsHide: true }); }
    catch { return finish(false); }
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5_000);
      killTimer.unref?.();
      finish(false);
    }, Math.max(1, deadline - Date.now()));
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
      if (output.length > 262_144) { clearTimeout(timer); child.kill(); finish(false); }
    });
    child.on("error", () => { exited = true; clearTimeout(timer); clearTimeout(killTimer); finish(false); });
    // exit can precede the last piped stdout chunk; close follows stdio.
    child.on("close", (code) => { exited = true; clearTimeout(timer); clearTimeout(killTimer); finish(code === 0); });
  });
}

async function runningSessions(binaryPath: string, env: NodeJS.ProcessEnv, deadline: number): Promise<string[] | null> {
  const status = await runBrowserCommand(binaryPath, env, ["session", "list", "--json"], deadline, true);
  if (!status.ok) return null;
  try {
    const result = JSON.parse(status.output);
    const sessions: unknown = result?.data?.sessions;
    if (result?.success !== true || !Array.isArray(sessions) || !sessions.every((name) => typeof name === "string")) return null;
    return sessions;
  } catch { return null; }
}

/** Closes one daemon and its Chrome without the CLI's implicit launch; true once agent-browser no longer lists the session. */
export async function closeBrowserSession(binaryPath: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<boolean> {
  const session = env.AGENT_BROWSER_SESSION;
  if (!session || !/^[A-Za-z0-9_.-]{1,96}$/.test(session)) return false;
  const control = controlEnv(env);
  const deadline = Date.now() + timeoutMs;
  // `close` to a stopped session starts a daemon only to stop it again.
  const running = await runningSessions(binaryPath, control, deadline);
  if (!running) return false;
  if (!running.includes(session)) return true;
  if (!(await runBrowserCommand(binaryPath, control, ["close"], deadline)).ok) return false;
  // Native close answers before the daemon exits.
  while (Date.now() < deadline) {
    const sessions = await runningSessions(binaryPath, control, deadline);
    if (!sessions) return false;
    if (!sessions.includes(session)) return true;
    await new Promise((done) => setTimeout(done, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  return false;
}
