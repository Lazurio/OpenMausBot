// Codex resolves its own effective account (keyring included): reading auth.json directly can label an
// API-key or keyring login with an old file's email. Only the protocol's display email leaves here.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { userHome } from "../env-path.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { codexEnvironmentProvider, type CodexEnvironmentProvider } from "./lazurio-codex-environment.ts";

// config/read answers with the whole effective configuration, MCP servers included.
const MAX_OUTPUT = 256 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CodexAccount {
  email: string | null;
  /** Lazurio: the provider of the Environment's Codex configuration, which needs no sign-in. */
  environment: CodexEnvironmentProvider | null;
}

const UNKNOWN: CodexAccount = { email: null, environment: null };

export function codexHome(env: Record<string, string | undefined>): string | null {
  if (env.CODEX_HOME) return isAbsolute(env.CODEX_HOME) ? resolve(env.CODEX_HOME) : null;
  const home = userHome(env);
  return isAbsolute(home) ? join(home, ".codex") : null;
}

/** One app-server reads the account (`account/read`) and, for Lazurio, the effective configuration
 * (`config/read`). Unsupported CLIs and uncertain answers stay unnamed and unconfigured; never fall back
 * to a possibly inactive credential file. */
export async function readCodexAccount(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs = 3_000,
): Promise<CodexAccount> {
  const cwd = env.HOME || env.USERPROFILE || homedir();
  if (!isAbsolute(cwd) || !codexHome(env)) return UNKNOWN;
  return new Promise((resolveAccount) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(cli, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolveAccount(UNKNOWN);
      return;
    }
    let finishing = false;
    let buffer = "";
    let outputBytes = 0;
    let initialized = false;
    const answers = new Map<number, { result?: unknown }>();
    const finish = async (account: CodexAccount) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      let stopped = await killCliTree(child, 1_000);
      if (!stopped && child.pid) {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch {}
        }
        stopped = await killCliTree(child, 1_000);
      }
      resolveAccount(stopped ? account : UNKNOWN);
    };
    const timer = setTimeout(() => { void finish(UNKNOWN); }, timeoutMs);
    timer.unref();
    const send = (message: unknown) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { void finish(UNKNOWN); }
    };
    child.stdin.on("error", () => { void finish(UNKNOWN); });
    child.stderr.resume(); // Do not retain or log raw CLI errors or credentials.
    child.on("error", () => { void finish(UNKNOWN); });
    child.on("close", () => { void finish(UNKNOWN); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (finishing) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT) { void finish(UNKNOWN); return; }
      buffer += chunk;
      let newline: number;
      while (!finishing && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { void finish(UNKNOWN); return; }
        if (!initialized && message?.id === 1) {
          if (message.error || !message.result) { void finish(UNKNOWN); return; }
          initialized = true;
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "config/read", params: { includeLayers: false } });
          send({ id: 3, method: "account/read", params: { refreshToken: false } });
        } else if (initialized && (message?.id === 2 || message?.id === 3)) {
          answers.set(message.id, message.error ? {} : { result: message.result });
          if (answers.size < 2) continue;
          const read = answers.get(3)?.result as { account?: { type?: unknown; email?: unknown } | null } | undefined;
          const email = read?.account?.type === "chatgpt" ? read.account.email : null;
          void finish({
            email: typeof email === "string" && email.length <= 254 && EMAIL.test(email) && !/[\p{Cc}\p{Cf}]/u.test(email) ? email : null,
            environment: codexEnvironmentProvider(answers.get(2)?.result, read),
          });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "openmausbot", version: "1" } } });
  });
}
