import { describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { instanceConfigs, persistableInstanceConfigs, type AppConfig } from "./config.ts";

describe("the Antigravity engine is not offered", () => {
  it("is in no built-in driver list and no default fleet", () => {
    expect(BUILT_IN_DRIVERS.map(driver => driver.driverKind)).not.toContain("antigravityAgent");
    const fleet = instanceConfigs({});
    expect(fleet).not.toHaveProperty("antigravity");
    expect(Object.values(fleet).map(entry => entry.driver)).not.toContain("antigravityAgent");
  });

  it("drops a saved fleet's entries for it, so the next save leaves them off disk", () => {
    const cfg: AppConfig = {
      instances: {
        claude: { driver: "claudeAgent" },
        antigravity: { driver: "antigravityAgent", config: { cli: "agy" } },
        "antigravity-work": { driver: "antigravityAgent", displayName: "Work" },
      },
    };
    for (const map of [instanceConfigs(cfg), persistableInstanceConfigs(cfg)]) {
      expect(Object.keys(map)).toContain("claude");
      expect(map).not.toHaveProperty("antigravity");
      expect(map).not.toHaveProperty("antigravity-work");
    }
    expect(cfg.instances).toHaveProperty("antigravity");
  });

  it("keeps an id the person reused for another engine", () => {
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" }, antigravity: { driver: "grokAgent" } } }))
      .toHaveProperty("antigravity.driver", "grokAgent");
  });
});
