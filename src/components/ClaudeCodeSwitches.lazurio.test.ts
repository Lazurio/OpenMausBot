import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const catalog = (locale: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../locales/${locale}.json`, import.meta.url)), "utf8")) as Record<string, string>;

it("says the skills switch covers skills only, and that the Environment's MCP servers reach every Claude bot", () => {
  for (const locale of ["en", "es", "pt-br"]) {
    const description = catalog(locale)["mcp.claudeSkills.desc"];
    expect(description, locale).toMatch(/MCP/);
    expect(description, locale).not.toMatch(/MCP servers and CLAUDE\.md stay out|servidores MCP y CLAUDE\.md quedan fuera|servidores MCP e CLAUDE\.md ficam de fora/);
  }
  expect(catalog("en")["mcp.claudeSkills.desc"]).toContain("reach every Claude bot whether this is on or off");
});
