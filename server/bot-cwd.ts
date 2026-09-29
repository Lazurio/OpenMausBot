// A bot's working folder — where its shell tools run. Validated here, once,
// so a bad path is refused at PATCH time with a reason the settings panel
// can show, rather than surfacing later as a driver spawn failure.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type CwdValidation = { ok: true; cwd: string | null } | { ok: false; error: string };

export function validateBotCwd(input: unknown): CwdValidation {
  if (input === null) return { ok: true, cwd: null };
  if (typeof input !== "string") return { ok: false, error: "working folder must be a path" };
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, cwd: null };
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  if (!isAbsolute(expanded)) return { ok: false, error: "working folder must be an absolute path" };
  const cwd = resolve(expanded);
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return { ok: false, error: `that folder doesn't exist: ${cwd}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `that path is not a folder: ${cwd}` };
  return { ok: true, cwd };
}

/** OMB_DEFAULT_BOT_CWD: the working folder every new bot starts in when its
 * creation names none. Unset or blank keeps each new bot in its private task
 * workspace. The value is checked exactly like a bot's own folder, and an
 * unusable one stops the server at start rather than failing later turns. */
export function defaultBotCwdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.OMB_DEFAULT_BOT_CWD;
  if (raw === undefined || !raw.trim()) return null;
  const checked = validateBotCwd(raw);
  if (!checked.ok) throw new Error(`OMB_DEFAULT_BOT_CWD: ${checked.error}`);
  return checked.cwd;
}
