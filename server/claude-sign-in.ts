import { CLAUDE_AUTH_ENV_KEYS, resolveClaudeConfigDir } from "./drivers/claude.ts";
import { resolveCli } from "./procs.ts";

/** This computer's own `claude auth login`, in the configuration directory the bots read, as a command to copy.
 * Everything is quoted as data, wrapper arguments included; the subshell restores the caller's environment. */
export function claudeSignInCommand(cli: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const directory = environment.CLAUDE_CONFIG_DIR?.trim() ? resolveClaudeConfigDir(undefined, environment) : "";
  const resolved = resolveCli(cli, ["auth", "login"]);
  const keys = [...CLAUDE_AUTH_ENV_KEYS, "CLAUDE_CONFIG_DIR"];
  if (platform === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return `& { $ombKeys = ${keys.map(quote).join(",")}; $ombSaved = @{}; foreach ($k in $ombKeys) { $ombSaved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $null, 'Process') }; try { ${directory ? `$env:CLAUDE_CONFIG_DIR = ${quote(directory)}; ` : ""}& ${[resolved.command, ...resolved.args].map(quote).join(" ")} } finally { foreach ($k in $ombKeys) { [Environment]::SetEnvironmentVariable($k, $ombSaved[$k], 'Process') } } }`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  return `(unset ${keys.join(" ")}; ${directory ? `export CLAUDE_CONFIG_DIR=${quote(directory)}; ` : ""}${[resolved.command, ...resolved.args].map(quote).join(" ")})`;
}
