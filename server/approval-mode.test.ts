import { describe, expect, it } from "vitest";

import {
  APPROVAL_MODES,
  DEFAULT_APPROVAL_MODE,
  approvalModeFor,
  supportsApprovalMode,
  modelSwitchNeedsAsk,
  hasNativeAutoReview,
  isApprovalMode,
} from "../shared/approval-mode.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { createApprovalModeSupport } from "./harness-capabilities.ts";

describe("approval modes", () => {
  it("carries Full silently to any engine that runs it", () => {
    for (const driver of ["codex", "claudeAgent", "grokAgent", "antigravityAgent", "piAgent", "customAcp"]) {
      expect(modelSwitchNeedsAsk("ask", "codex", driver)).toBe(false);
      expect(modelSwitchNeedsAsk("auto", "codex", driver)).toBe(false);
      expect(modelSwitchNeedsAsk("full", "codex", driver)).toBe(false);
    }
    expect(modelSwitchNeedsAsk("full", "codex", "claudeAgent")).toBe(false);
    expect(modelSwitchNeedsAsk("full", "claudeAgent", "openai-compat")).toBe(false);
    expect(modelSwitchNeedsAsk("edits", "claudeAgent", "codex")).toBe(true);
    expect(modelSwitchNeedsAsk("edits", "claudeAgent", "grokAgent")).toBe(false);
    expect(modelSwitchNeedsAsk("full", "claudeAgent", "claudeAgent")).toBe(false);
    expect(modelSwitchNeedsAsk("full", "codex", undefined)).toBe(false);
  });
  it("only exposes implemented provider capabilities", () => {
    for (const driver of ["codex", "claudeAgent", "antigravityAgent", "cursorAgent", "grokAgent", "opencodeGo", "qwenAgent", "geminiAgent"]) {
      expect(supportsApprovalMode(driver, "full")).toBe(true);
      // Qwen's `--approval-mode auto` is an LLM classifier; Gemini has no reviewer
      expect(hasNativeAutoReview(driver)).toBe(["codex", "claudeAgent", "cursorAgent", "grokAgent", "qwenAgent"].includes(driver));
      expect(supportsApprovalMode(driver, "edits")).toBe(["claudeAgent", "grokAgent", "antigravityAgent", "qwenAgent", "geminiAgent"].includes(driver));
    }
    expect(supportsApprovalMode(undefined, "full")).toBe(true);
    expect(supportsApprovalMode(undefined, "edits")).toBe(false);
  });

  it("runs Full access, the default level, on every engine", () => {
    for (const { driverKind } of BUILT_IN_DRIVERS) expect(supportsApprovalMode(driverKind, "full"), driverKind).toBe(true);
  });

  // No permissive mode of their own: the harness answers the permission
  // requests they leave, so Full runs there too.
  it.each([
    "kimiAgent", "droidAgent", "hermesAgent", "customAcp",
    "piAgent", "unknown",
  ])("runs Full on %s without claiming native Auto or Edits", (driver) => {
    expect(supportsApprovalMode(driver, "ask")).toBe(true);
    expect(supportsApprovalMode(driver, "auto")).toBe(true);
    expect(supportsApprovalMode(driver, "edits")).toBe(false);
    expect(supportsApprovalMode(driver, "full")).toBe(true);
    expect(hasNativeAutoReview(driver)).toBe(false);
  });

  // The chat-completions family has no provider reviewer, so Auto behaves like Ask, but Full is implemented in the harness
  // (createOpenAIChatRuntime answers its own gate), so it is offered.
  it.each(["grok", "openai-compat", "minimax", "groq", "meta"])("offers harness-implemented Full on %s, but never native Auto", (driver) => {
    expect(supportsApprovalMode(driver, "ask")).toBe(true);
    expect(supportsApprovalMode(driver, "auto")).toBe(true);
    expect(supportsApprovalMode(driver, "full")).toBe(true);
    expect(supportsApprovalMode(driver, "edits")).toBe(false);
    expect(hasNativeAutoReview(driver)).toBe(false);
  });
  // Lazurio overlay (DEV-6673): the four runtime modes of Lazurio's T3 Code; upstream's Custom is removed.
  it("recognizes only the four durable values", () => {
    expect(APPROVAL_MODES).toEqual(["ask", "edits", "auto", "full"]);
    for (const mode of APPROVAL_MODES) expect(isApprovalMode(mode)).toBe(true);
    for (const value of [undefined, null, true, "automatic", "bypass", "custom"]) {
      expect(isApprovalMode(value)).toBe(false);
    }
  });

  it("migrates the legacy Auto bit to safe Auto, never Full access", () => {
    expect(approvalModeFor({ autoApprove: true })).toBe("auto");
  });

  it("starts a bot or conversation nobody has set a level on at Full access", () => {
    expect(DEFAULT_APPROVAL_MODE).toBe("full");
    expect(approvalModeFor({})).toBe("full");
    // Every bot made over HTTP stores the legacy bit off beside no level.
    expect(approvalModeFor({ autoApprove: false })).toBe("full");
    expect(approvalModeFor({ approvalMode: "ask", autoApprove: false })).toBe("ask");
  });

  it("prefers a valid explicit mode and fails closed around corrupt values", () => {
    expect(approvalModeFor({ approvalMode: "full", autoApprove: false })).toBe("full");
    expect(approvalModeFor({ approvalMode: "custom", autoApprove: true })).toBe("auto");
    expect(approvalModeFor({ approvalMode: "custom", autoApprove: false })).toBe("ask");
    expect(approvalModeFor({ approvalMode: "unknown", autoApprove: true })).toBe("auto");
    expect(approvalModeFor({ approvalMode: "unknown", autoApprove: false })).toBe("ask");
  });
});

describe("approval support bound to a registry", () => {
  const registry = {
    cliTarget: (instanceId: string) =>
      instanceId === "codex-fixture" ? { driverKind: "codex" }
        : instanceId === "pi-fixture" ? { driverKind: "piAgent" }
        : null,
  };
  const supports = createApprovalModeSupport(registry);

  it("resolves model selections through the registry", () => {
    const codex = { instanceId: "codex-fixture", model: "fixture" };
    const pi = { instanceId: "pi-fixture", model: "fixture" };
    expect(supports(codex, "full")).toBe(true);
    expect(supports(pi, "ask")).toBe(true);
    expect(supports(pi, "auto")).toBe(true);
    expect(supports(pi, "full")).toBe(true);
  });

  it("answers an unknown instance like an unknown driver", () => {
    const ghost = { instanceId: "ghost", model: "fixture" };
    expect(supports(ghost, "ask")).toBe(true);
    expect(supports(ghost, "edits")).toBe(false);
    expect(supports(ghost, "full")).toBe(true);
    expect(supports(undefined, "ask")).toBe(true);
    expect(supports(undefined, "full")).toBe(true);
  });

  it("passes already-resolved driver views to the table unchanged", () => {
    expect(supports({ driverKind: "codex" }, "edits")).toBe(false);
    expect(supports({ driverKind: "piAgent" }, "full")).toBe(true);
    expect(supports({ driverKind: undefined }, "ask")).toBe(true);
    expect(supports({ driverKind: undefined }, "full")).toBe(true);
  });

  it("agrees with the pure table across every mode", () => {
    for (const driverKind of ["codex", "claudeAgent", "piAgent", undefined] as const) {
      for (const mode of APPROVAL_MODES) {
        expect(supports({ driverKind }, mode)).toBe(supportsApprovalMode(driverKind, mode));
      }
    }
  });
});
