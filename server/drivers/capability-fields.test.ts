import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const created: ProviderInstance[] = [];
const keep = async (promise: Promise<ProviderInstance>): Promise<ProviderInstance> => {
  const instance = await promise;
  created.push(instance);
  return instance;
};

describe("typed capability fields", () => {
  beforeEach(() => {
    ensureDirs();
  });

  afterEach(async () => {
    for (const instance of created.splice(0)) await instance.dispose();
  });

  it("keeps the chat runtime's tools locked to its tools setting", async () => {
    const mounted = await keep(OpenAICompatDriver.create({
      instanceId: "caps-compat", displayName: "Caps Compat", environment: {}, enabled: true,
      config: OpenAICompatDriver.defaultConfig(),
    }));
    expect(mounted.adapter.capabilities.dataMcp).toBe(true);
    const bare = await keep(OpenAICompatDriver.create({
      instanceId: "caps-compat-bare", displayName: "Caps Compat Bare", environment: {}, enabled: true,
      config: { ...OpenAICompatDriver.defaultConfig(), tools: false },
    }));
    expect(bare.adapter.capabilities.dataMcp).toBe(false);
  });

  it("registers no driver that runs a turn somewhere other than its own engine, or with computer tools of MausBot's own", async () => {
    expect(BUILT_IN_DRIVERS.map(driver => driver.driverKind)).not.toContain("boxAgent");
    for (const driver of BUILT_IN_DRIVERS) {
      const instance = await keep(driver.create({
        instanceId: `caps-fleet-${driver.driverKind}`, displayName: "Caps Fleet", environment: {}, enabled: true,
        config: driver.driverKind === "customAcp" ? { cli: "echo" } : {},
      }));
      expect(instance.adapter.capabilities, driver.driverKind).not.toHaveProperty("remoteAgent");
      expect(instance.adapter.capabilities, driver.driverKind).not.toHaveProperty("computerMcp");
      expect(instance.adapter.capabilities, driver.driverKind).not.toHaveProperty("localComputerMcp");
    }
  });
});
