import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { SERVER_ROOT, SPAWNED_PROXIES } from "./proxy-paths.ts";

describe("spawned proxy runtime path", () => {
  it("resolves an existing TypeScript entry in development", () => {
    expect(SPAWNED_PROXIES.permission).toBe(join(SERVER_ROOT, "permission-proxy.ts"));
    expect(existsSync(SPAWNED_PROXIES.permission)).toBe(true);
  });

  it("is included in the server bundle entry points", () => {
    const script = readFileSync(join(SERVER_ROOT, "../scripts/bundle-server.mjs"), "utf8");
    const entryPoints = script.match(/const ENTRY_POINTS = \[([\s\S]*?)\];/)?.[1];
    expect(entryPoints).toMatch(/["']permission-proxy\.ts["']/);
  });

  it("resolves the bundled JavaScript sibling without a source tree", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "omb-proxy-paths-")));
    try {
      await build({
        entryPoints: ["proxy-paths.ts", "permission-proxy.ts"].map((entry) => join(SERVER_ROOT, entry)),
        bundle: true,
        platform: "node",
        target: "node20",
        format: "esm",
        outdir: directory,
        logLevel: "silent",
      });
      const manifest = pathToFileURL(join(directory, "proxy-paths.js")).href;
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", [
        `import { SERVER_ROOT, SPAWNED_PROXIES } from ${JSON.stringify(manifest)};`,
        "console.log(JSON.stringify({ root: SERVER_ROOT, permission: SPAWNED_PROXIES.permission }));",
      ].join("\n")], { encoding: "utf8", timeout: 10_000 });
      const packaged = JSON.parse(output);

      expect(packaged.root).toBe(directory);
      expect(packaged.permission).toBe(join(directory, "permission-proxy.js"));
      expect(existsSync(packaged.permission)).toBe(true);
      expect(existsSync(join(directory, "permission-proxy.ts"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("harness MCP proxy runtime path", () => {
  it("ships the one proxy the built-in browser, Data and HighLevel tools share", () => {
    expect(SPAWNED_PROXIES.harnessMcp).toBe(join(SERVER_ROOT, "harness-mcp-proxy.ts"));
    expect(existsSync(SPAWNED_PROXIES.harnessMcp)).toBe(true);
    const script = readFileSync(join(SERVER_ROOT, "../scripts/bundle-server.mjs"), "utf8");
    const entryPoints = script.match(/const ENTRY_POINTS = \[([\s\S]*?)\];/)?.[1];
    expect(entryPoints).toMatch(/["']harness-mcp-proxy\.ts["']/);
    expect(entryPoints).not.toMatch(/["']browser-proxy\.ts["']/);
  });
});
