import { describe, expect, it } from "vitest";

import {
  expandSetupTurnText,
  parseSetupCommand,
  setupModeActive,
  setupSystemPrompt,
} from "./setup-mode.ts";

describe("parseSetupCommand", () => {
  it("recognises /setup with and without a request", () => {
    expect(parseSetupCommand("/setup")).toEqual({ request: "" });
    expect(parseSetupCommand("  /SETUP watch Discord and file bugs into Linear  ")).toEqual({
      request: "watch Discord and file bugs into Linear",
    });
    expect(parseSetupCommand("/setup\nevery 5 minutes")).toEqual({ request: "every 5 minutes" });
  });

  it("ignores ordinary chat that only mentions the word", () => {
    expect(parseSetupCommand("please setup a routine")).toBeNull();
    expect(parseSetupCommand("use /setup later")).toBeNull();
    expect(parseSetupCommand("/setupx")).toBeNull();
    expect(parseSetupCommand("")).toBeNull();
  });
});

describe("expandSetupTurnText", () => {
  it("turns a bare /setup into a request to set up, and keeps a described job", () => {
    expect(expandSetupTurnText("/setup")).toBe(
      "Set yourself up. Ask me what you need to know, then propose your configuration.",
    );
    expect(expandSetupTurnText("/setup watch Discord")).toBe("Set yourself up for this job: watch Discord");
    expect(expandSetupTurnText("hello")).toBe("hello");
  });
});

describe("setupModeActive", () => {
  it("does not turn an ordinary request into onboarding for a blank bot", () => {
    for (const text of ["hello", "Summarize this report", "Run the daily check", "A teammate asked you to review this diff"]) {
      expect(setupModeActive({ soul: "", description: "", text })).toBe(false);
      expect(setupModeActive({ soul: "  \n", description: undefined, text })).toBe(false);
      expect(setupModeActive({ text })).toBe(false);
    }
  });

  it("requires /setup whether or not the profile has been filled in", () => {
    expect(setupModeActive({ text: "/setup" })).toBe(true);
    expect(setupModeActive({ soul: "Be brief.", description: "", text: "hello" })).toBe(false);
    expect(setupModeActive({ soul: "", description: "Files bugs.", text: "hello" })).toBe(false);
    expect(setupModeActive({ soul: "Be brief.", description: "Files bugs.", text: "/setup" })).toBe(true);
    expect(setupModeActive({ soul: "Be brief.", description: "", text: "/setup change my job" })).toBe(true);
  });
});

describe("setupSystemPrompt", () => {
  it("is empty when not active, regardless of the skills option", () => {
    expect(setupSystemPrompt(false, {})).toBe("");
    expect(setupSystemPrompt(false, { skills: true })).toBe("");
  });

  it("is the skill_manage-naming block when active with skills on", () => {
    const prompt = setupSystemPrompt(true, { skills: true });
    expect(prompt.startsWith("\n\n")).toBe(true);
    for (const tool of ["propose_profile", "create_trigger", "skill_manage", "request_credential"]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toContain("at most four questions");
    expect(prompt).toContain("Ask for missing choices, not an extra yes");
  });

  it("never mentions skill_manage when active with skills off (or unspecified)", () => {
    for (const prompt of [setupSystemPrompt(true, {}), setupSystemPrompt(true, { skills: false })]) {
      expect(prompt).not.toContain("skill_manage");
      expect(prompt).toContain("propose_profile");
      expect(prompt).toContain("create_trigger");
      expect(prompt).toContain("request_credential");
      expect(prompt).toContain("describe procedures plainly in your standing instructions");
    }
  });
});

describe("setupSystemPrompt working-folder clause and result ordering", () => {
  it("names the current folder and tells the bot to offer to keep it", () => {
    const text = setupSystemPrompt(true, { skills: true, cwd: "/Users/me/Projects/site" });
    expect(text).toContain("today that is /Users/me/Projects/site; offer to keep it");
    expect(text).toContain("propose_profile for your identity, standing rules");
    expect(text).toContain("and the working folder (cwd)");
  });

  it("says there is no folder yet when the bot works in its private workspace", () => {
    const text = setupSystemPrompt(true, { skills: false });
    expect(text).toContain("today it has none and works in a private workspace");
    expect(text).not.toContain("skill_manage");
  });

  it("explains the requested changes before tools and follows applied versus pending outcomes", () => {
    const text = setupSystemPrompt(true, {});
    expect(text).toContain("First send one message describing the changes you are about to request, then make the tool calls");
    expect(text).toContain("if applied, continue without another confirmation");
    expect(text).toContain("if pending, end the turn and wait");
    expect(text).toContain("Do not repeat the list or claim success from the permission mode alone");
    expect(text).toContain("A credential request still needs the user's secure entry");
    expect(text).toContain("Full Access does not supply answers, credentials, or broader permissions for another bot");
    expect(text).not.toContain("each of which the user must confirm");
    expect(text).not.toContain("propose it paused");
  });
});

describe("setupSystemPrompt for a Chief of Staff", () => {
  it("tells a Chief to stay the Chief and add the job to what it already does", () => {
    const chief = setupSystemPrompt(true, { chief: true });
    expect(chief).toContain("You are also the Chief of Staff, and setting yourself up does not change that");
    expect(chief).toContain("add this job to your standing instructions instead of replacing them");
    for (const prompt of [setupSystemPrompt(true, {}), setupSystemPrompt(true, { chief: false })]) {
      expect(prompt).not.toContain("Chief of Staff");
    }
    expect(setupSystemPrompt(false, { chief: true })).toBe("");
  });
});

describe("setupSystemPrompt apps and sign-in", () => {
  const text = setupSystemPrompt(true, {});

  it("names no connected-app tool", () => {
    expect(text).not.toMatch(/COMPOSIO_/);
    expect(text).not.toContain("Connected apps");
    expect(text).not.toContain("skill_manage");
  });

  it("keeps the by-hand ending for what truly needs it", () => {
    expect(text).not.toContain("point them to the Access section");
    expect(text).not.toContain("(OAuth)");
    expect(text).toContain(
      "Finish by saying exactly what remains for the user to do by hand, such as creating a third-party application or bot token, or deciding a pending review.",
    );
  });

  it("sends a website sign-in to request_sign_in, never a password in chat, and Google accounts to a tool signed in on this computer", () => {
    expect(text).toContain("For a website, call request_sign_in at its sign-in page so the user signs in themselves");
    expect(text).toContain("never ask for a password or code in chat");
    expect(text).toContain("For Gmail and other Google accounts use a tool already signed in on this computer: Google blocks sign-in in your browser.");
  });
});
