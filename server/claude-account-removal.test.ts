import { describe, expect, it } from "vitest";

import { instanceConfigs, persistableInstanceConfigs, type AppConfig } from "./config.ts";

const saved = (): AppConfig => ({ instances: {
  claude: { driver: "claudeAgent", displayName: "Personal", config: { cli: "/opt/claude", configDir: "/home/me/.claude-personal" } },
  "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c": { driver: "claudeAgent", displayName: "Work", config: { configDir: "/data/providers/claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c" } },
  claudeWork: { driver: "claudeAgent", displayName: "Work folder", config: { configDir: "~/.claude-work" } },
  spare: { driver: "claudeAgent", displayName: "Spare", environment: { FIXTURE: "1" } },
  claudeApi: { driver: "claudeAgent", config: { requireApiKey: true } },
  codex: { driver: "codex", config: { configDir: "/kept/for/another/driver" } },
} });

describe("a saved config with added Claude accounts", () => {
  it("loads without them: bots use the computer's one Claude login", () => {
    for (const map of [instanceConfigs(saved()), persistableInstanceConfigs(saved())]) {
      expect(map).not.toHaveProperty("claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c");
      expect(map).not.toHaveProperty("claudeWork");
      expect(map.claude).toMatchObject({ driver: "claudeAgent", displayName: "Personal", config: { cli: "/opt/claude" } });
      expect(map.claude.config).not.toHaveProperty("configDir");
      expect(map.spare).toMatchObject({ driver: "claudeAgent", displayName: "Spare" });
      expect(map.claudeApi).toMatchObject({ driver: "claudeAgent" });
      expect(map.codex.config).toEqual({ configDir: "/kept/for/another/driver" });
    }
  });

  it("leaves the saved entries themselves alone until the next save", () => {
    const cfg = saved();
    instanceConfigs(cfg);
    persistableInstanceConfigs(cfg);
    expect(cfg.instances?.claude.config).toHaveProperty("configDir");
  });
});
