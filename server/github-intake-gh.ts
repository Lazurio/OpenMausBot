// Lazurio MausBot GitHub intake: the signed-in GitHub CLI of this server's
// user, the intake's only way to GitHub. No token of its own.
import { spawn } from "node:child_process";

const GH_TIMEOUT_MS = 60_000;

export type GhResult =
  | { ok: true; stdout: string }
  | { ok: false; code: number | null; stderr: string; missing?: boolean };
export type GhRunner = (args: string[]) => Promise<GhResult>;

/** The signed-in GitHub CLI of this server's user. No token of our own. */
export function spawnGh(bin = "gh"): GhRunner {
  return (args) => new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: GhResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", CLICOLOR: "0" },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, stderr: `gh ${args[0]} timed out after ${GH_TIMEOUT_MS / 1_000} s` });
    }, GH_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < 16_384) stderr += chunk; });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ ok: false, code: null, stderr: error.message, missing: error.code === "ENOENT" });
    });
    child.on("close", (code) => finish(code === 0 ? { ok: true, stdout } : { ok: false, code, stderr: stderr.trim() }));
  });
}

export type GhFailure = "missing" | "signed_out" | "rate_limited" | "not_found" | "failed";

export class GhError extends Error {
  readonly kind: GhFailure;
  constructor(kind: GhFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function classify(result: Extract<GhResult, { ok: false }>): GhFailure {
  if (result.missing) return "missing";
  const text = result.stderr.toLowerCase();
  if (text.includes("rate limit") || text.includes("http 429") || text.includes("abuse detection")) return "rate_limited";
  if (text.includes("gh auth login") || text.includes("http 401") || text.includes("not logged in") || text.includes("bad credentials")) return "signed_out";
  if (text.includes("http 404")) return "not_found";
  return "failed";
}
