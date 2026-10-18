// Whether an engine can use a computer is one typed fact: it has computer tools (computerMcp).
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PiDriver } from "./pi.ts";

const created: ProviderInstance[] = [];
const hasComputerTools = (instance: ProviderInstance) => instance.adapter.capabilities.computerMcp === true;
const keep = async (promise: Promise<ProviderInstance>): Promise<ProviderInstance> => {
  const instance = await promise;
  created.push(instance);
  return instance;
};

describe("typed capability fields for computer tools", () => {
  beforeEach(() => {
    ensureDirs();
  });

  afterEach(async () => {
    for (const instance of created.splice(0)) await instance.dispose();
  });

  it("keeps the chat runtime's computer tools locked to its tools setting", async () => {
    const mounted = await keep(OpenAICompatDriver.create({
      instanceId: "caps-compat", displayName: "Caps Compat", environment: {}, enabled: true,
      config: OpenAICompatDriver.defaultConfig(),
    }));
    expect(mounted.adapter.capabilities.computerMcp).toBe(true);
    expect(mounted.adapter.capabilities.dataMcp).toBe(true);
    expect(hasComputerTools(mounted)).toBe(true);
    const bare = await keep(OpenAICompatDriver.create({
      instanceId: "caps-compat-bare", displayName: "Caps Compat Bare", environment: {}, enabled: true,
      config: { ...OpenAICompatDriver.defaultConfig(), tools: false },
    }));
    expect(bare.adapter.capabilities.computerMcp).toBe(false);
    expect(bare.adapter.capabilities.dataMcp).toBe(false);
    expect(hasComputerTools(bare)).toBe(false);
  });

  it("gives host-harness drivers computer tools on their own engine", async () => {
    const claude = await keep(ClaudeDriver.create({
      instanceId: "caps-claude", displayName: "Caps Claude", environment: {}, enabled: true,
      config: ClaudeDriver.defaultConfig(),
    }));
    expect(hasComputerTools(claude)).toBe(true);
    const codex = await keep(CodexDriver.create({
      instanceId: "caps-codex", displayName: "Caps Codex", environment: {}, enabled: true,
      config: CodexDriver.defaultConfig(),
    }));
    expect(hasComputerTools(codex)).toBe(true);
    const pi = await keep(PiDriver.create({
      instanceId: "caps-pi", displayName: "Caps Pi", environment: {}, enabled: true,
      config: PiDriver.defaultConfig(),
    }));
    expect(hasComputerTools(pi)).toBe(true);
  });

  it("registers no driver that runs a turn somewhere other than its own engine", async () => {
    expect(BUILT_IN_DRIVERS.map(driver => driver.driverKind)).not.toContain("boxAgent");
    for (const driver of BUILT_IN_DRIVERS) {
      const instance = await keep(driver.create({
        instanceId: `caps-fleet-${driver.driverKind}`, displayName: "Caps Fleet", environment: {}, enabled: true,
        config: driver.driverKind === "customAcp" ? { cli: "echo" } : {},
      }));
      expect(instance.adapter.capabilities, driver.driverKind).not.toHaveProperty("remoteAgent");
    }
  });
});
