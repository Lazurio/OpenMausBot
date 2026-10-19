import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeSignInCommand } from "./claude-sign-in.ts";
import { CLAUDE_AUTH_ENV_KEYS } from "./drivers/claude.ts";

describe("the computer's Claude sign-in command", () => {
  it("leaves the default CLI keychain namespace unset and quotes PowerShell values", () => {
    expect(claudeSignInCommand("claude", { HOME: "/home/fixture" }, "linux")).not.toContain("export CLAUDE_CONFIG_DIR=");
    expect(() => claudeSignInCommand("claude", { CLAUDE_CONFIG_DIR: "relative/path" }, "linux")).toThrow(/absolute/);
    const win = claudeSignInCommand("claude", { CLAUDE_CONFIG_DIR: join(process.cwd(), "O'Neil", "Work $ login") }, "win32");
    expect(win).toContain(`$env:CLAUDE_CONFIG_DIR = '${join(process.cwd(), "O''Neil", "Work $ login")}'`);
    expect(win).toContain("finally");
    expect(win).toContain("'auth' 'login'");
  });

  it.skipIf(process.platform === "win32")("signs in where the bots read, with exact arguments, no credential inheritance or shell expansion", () => {
    const directory = join(process.cwd(), "login with ' quotes $(echo WRONG) $HOME");
    const script = "console.log(JSON.stringify({argv:process.argv.slice(1),dir:process.env.CLAUDE_CONFIG_DIR,token:process.env.CLAUDE_CODE_OAUTH_TOKEN,home:process.env.HOME}))";
    const cli = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const env = { ...process.env, CLAUDE_CONFIG_DIR: directory, ...Object.fromEntries(CLAUDE_AUTH_ENV_KEYS.map(key => [key, "fixture-secret"])) };
    const output = execFileSync("/bin/sh", ["-c", claudeSignInCommand(cli, env)], { encoding: "utf8", env });
    expect(JSON.parse(output)).toEqual({ argv: ["auth", "login"], dir: directory, home: process.env.HOME });
  });
});
