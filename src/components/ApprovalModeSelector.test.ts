import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ApprovalModeSelector,
  approvalModeOptions,
  approvalModeOptionsFor,
} from "./ApprovalModeSelector";

describe("approval mode selector", () => {
  it("lists the approval levels with their plain-language copy", () => {
    expect(approvalModeOptions().map(({ mode, label, description }) => ({ mode, label, description }))).toEqual([
      {
        mode: "ask",
        label: "Ask for approval",
        description: "Requests approval for commands and file changes",
      },
      {
        mode: "edits",
        label: "Auto-accept edits",
        description: "Approves file edits automatically; other actions can still require approval",
      },
      {
        mode: "auto",
        label: "Approve for me",
        description: "Uses the provider's automatic review to approve routine actions and ask about others. Web search is allowed without asking.",
      },
      {
        mode: "full",
        label: "Full access",
        description: "Full computer access (elevated risk)",
      },
    ]);
  });

  // Lazurio overlay (DEV-6673): the four levels of Lazurio's T3 Code; upstream's Custom (config.toml) is removed.
  it("offers provider-supported Full access, and no Custom level", () => {
    expect(approvalModeOptionsFor("codex").map((option) => option.mode)).toEqual([
      "ask",
      "auto",
      "full",
    ]);
    expect(approvalModeOptionsFor("claudeAgent").map((option) => option.mode)).toEqual([
      "ask",
      "edits",
      "auto",
      "full",
    ]);
  });

  it.each(["cursorAgent", "opencodeGo"])("offers Full access for %s, and no Edits level it cannot map", (kind) => {
    expect(approvalModeOptionsFor(kind).map((option) => option.mode)).toEqual(["ask", "auto", "full"]);
  });

  it("offers Grok its native acceptEdits as Auto-accept edits", () => {
    expect(approvalModeOptionsFor("grokAgent").map((option) => option.mode)).toEqual(["ask", "edits", "auto", "full"]);
  });

  it("offers Antigravity Auto as the explicit full-access grant, not native review", () => {
    const options = approvalModeOptionsFor("antigravityAgent");
    expect(options.map(({ mode, label }) => ({ mode, label }))).toEqual([
      { mode: "ask", label: "Ask for approval" },
      { mode: "edits", label: "Auto-accept edits" },
      { mode: "full", label: "Auto (full access)" },
    ]);
    expect(options[2].chip).toBe("Auto");
    expect(options[2].description).toContain("Automatically approve tool requests");
  });

  it("shows the effective Antigravity mode without upgrading saved Auto settings", () => {
    const render = (mode: "ask" | "auto" | "full" | undefined, autoApprove = false) => renderToStaticMarkup(createElement(ApprovalModeSelector, {
      approvalMode: mode, autoApprove,
      providerName: "Antigravity", driverKind: "antigravityAgent", onSelect: () => {},
    }));
    for (const html of [render("ask"), render("auto"), render(undefined, true)]) {
      expect(html).toContain('aria-label="Ask for approval for Antigravity"');
      expect(html).not.toContain('aria-label="Auto (full access)');
    }
    expect(render("full")).toContain('aria-label="Auto (full access) for Antigravity"');
  });

  it("explains Auto fallbacks and offers Full, the default level, on every provider", () => {
    expect(approvalModeOptionsFor("grokAgent").find((option) => option.mode === "auto")?.description).toContain("automatic review to approve routine actions");
    expect(approvalModeOptionsFor("customAgent").find((option) => option.mode === "auto")?.description).toContain("behaves like Ask");
    expect(approvalModeOptionsFor("customAgent").map((option) => option.mode)).toEqual(["ask", "auto", "full"]);
  });

  it("keeps the composer trigger icon-only and the settings trigger labeled", () => {
    const compact = renderToStaticMarkup(createElement(ApprovalModeSelector, {
      approvalMode: "full", providerName: "Grok", driverKind: "grokAgent", onSelect: () => {},
    }));
    expect(compact).toContain('aria-label="Full access for Grok"');
    expect(compact).toContain('title="Full access"');
    expect(compact).not.toMatch(/<span class="truncate">Full access<\/span>/);
    const settings = renderToStaticMarkup(createElement(ApprovalModeSelector, {
      approvalMode: "full", providerName: "Grok", driverKind: "grokAgent", onSelect: () => {}, wide: true,
    }));
    expect(settings).toMatch(/<span class="truncate">Full access<\/span>/);
  });
});
