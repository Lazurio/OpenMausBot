// Lazurio overlay: OMB_DEFAULT_BOT_CWD, the working folder every new bot
// starts in when its creation names none. In a Lazurio Environment that is
// the Lazurio Folder, so bots read its AGENTS.md and work in its worktrees.
// Unset or blank changes nothing: a new bot works in its private task
// workspace, as upstream. Every creation path goes through the Store
// (createBot: New bot, the first bot on an empty server and imports;
// applyTeamSetup: a Chief's create_bot and reviewed team setup), which asks
// newBotCwd() here. See LAZURIO.md and docs/self-hosting.md.
import { validateBotCwd } from "./bot-cwd.ts";

/** The configured default, checked exactly like a bot's own folder. Throws
 * on an unusable value, so the server stops at start rather than failing
 * later creations; null when unset or blank. */
export function defaultBotCwdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.OMB_DEFAULT_BOT_CWD;
  if (raw === undefined || !raw.trim()) return null;
  const checked = validateBotCwd(raw);
  if (!checked.ok) throw new Error(`OMB_DEFAULT_BOT_CWD: ${checked.error}`);
  return checked.cwd;
}

/** The folder field of a new bot whose creation asked for `requested`:
 * undefined (named no folder) gives the server default, if any; "" (an
 * explicit empty or null folder) keeps the private task workspace; a path
 * stays that path. */
export function newBotCwd(requested: string | undefined, env: NodeJS.ProcessEnv = process.env): { cwd?: string } {
  const cwd = requested ?? defaultBotCwdFromEnv(env);
  return cwd ? { cwd } : {};
}

/** At server start (the Store's constructor): an unusable value stops the
 * server with the reason, a usable one is logged once. */
export function announceDefaultBotCwd(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log): void {
  const cwd = defaultBotCwdFromEnv(env);
  if (cwd) log(`[bots] new bots start in ${cwd} (OMB_DEFAULT_BOT_CWD)`);
}
