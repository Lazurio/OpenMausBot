import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexConfigMcp, codexConfigMcpServerNames, mcpServerNamesInToml } from "./codex-mcp-names.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

describe("mcpServerNamesInToml", () => {
  it("collects bare, quoted and sub-table headers and ignores everything else", () => {
    const toml = `
model = "gpt-5"
[mcp_servers.fibery]
url = "https://mcp-eu-svc.fibery.io/mcp"
  [ mcp_servers.google_ads-http ]
url = "https://example.test/mcp"
[mcp_servers."with space"]
command = "npx"
[mcp_servers.'single']
command = "npx"
[mcp_servers.nested.env]
TOKEN = "x"
[projects."/tmp/mcp_servers.decoy"]
trust_level = "trusted"
# [mcp_servers.commented]
`;
    expect([...mcpServerNamesInToml(toml)].sort()).toEqual(["fibery", "google_ads-http", "nested", "single", "with space"]);
  });

  it("returns nothing for a config without servers", () => {
    expect(mcpServerNamesInToml('model = "gpt-5"\n').size).toBe(0);
  });
});

describe("codexConfigMcpServerNames", () => {
  it("reads config.toml from CODEX_HOME, falling back to ~/.codex, and tolerates a missing file", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-codex-names-"));
    dirs.push(home);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.home_one]\nurl = "https://a.test"\n');
    const codexHome = join(home, "elsewhere");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.explicit]\nurl = "https://b.test"\n');
    expect([...codexConfigMcpServerNames({ HOME: home })]).toEqual(["home_one"]);
    expect([...codexConfigMcpServerNames({ HOME: home, CODEX_HOME: codexHome })]).toEqual(["explicit"]);
    expect(codexConfigMcpServerNames({ HOME: home, CODEX_HOME: join(home, "missing") }).size).toBe(0);
  });
});

describe("codexConfigMcp", () => {
  const configFor = (toml: string) => {
    const home = mkdtempSync(join(tmpdir(), "omb-codex-runs-"));
    dirs.push(home);
    writeFileSync(join(home, "config.toml"), toml);
    return codexConfigMcp({ CODEX_HOME: home });
  };

  it("reads every server config.toml declares with its table, and no table from a file it cannot parse", () => {
    const config = configFor([
      "[mcp_servers.sentry]", 'command = "npx"', 'args = ["-y", "@sentry/mcp-server"]', "[mcp_servers.sentry.env]", 'SENTRY_TOKEN = "t"',
      "[mcp_servers.figma]", 'url = "https://mcp.figma.com/mcp"',
    ].join("\n"));
    expect([...config.names].sort()).toEqual(["figma", "sentry"]);
    expect(config.tables.sentry).toMatchObject({ command: "npx", args: ["-y", "@sentry/mcp-server"], env: { SENTRY_TOKEN: "t" } });
    expect(config.tables.figma).toMatchObject({ url: "https://mcp.figma.com/mcp" });
    const broken = configFor("[mcp_servers.sentry\ncommand = 1");
    expect(broken.tables).toEqual({});
  });
});
