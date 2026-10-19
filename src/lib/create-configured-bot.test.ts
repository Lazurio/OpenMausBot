import { afterEach, describe, expect, it, vi } from "vitest";
import { api, persistBotUpdate, type Bot } from "@/state/store";
import { BotCreationDraft, EMPTY_BOT_DEFAULTS } from "./bot-creation-draft";
import { createConfiguredBot } from "./create-configured-bot";

afterEach(() => vi.unstubAllGlobals());

describe("configured bot creation", () => {
  function fixture(mode: "ask" | "auto" | "full", fail = 0, selection?: Bot["modelSelection"]) {
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn());
    draft.patch({ name: "Fixture", approvalMode: mode, notifications: false });
    let bot = { ...draft.bot, id: "created", threadId: "initial", approvalMode: "ask" } as Bot;
    if (selection) bot.modelSelection = selection;
    const events: string[] = [];
    const bodies: unknown[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      events.push(`${init?.method} ${path}`);
      const body = JSON.parse(String(init?.body ?? "{}"));
      bodies.push(body);
      if (init?.method === "PATCH") bot = { ...bot, ...body };
      return { bot };
    }) as unknown as typeof api;
    // The nth PATCH fails, as a refused level would.
    let patches = 0;
    const failing = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && ++patches === fail) throw new Error("Level refused");
      return request(path, init);
    }) as unknown as typeof api;
    return { draft, events, bodies, request: fail ? failing : request };
  }

  it("sets the chosen audience in the first creation request", async () => {
    const f = fixture("ask");
    await createConfiguredBot(f.draft, f.request, persistBotUpdate, "admins");
    expect(f.events[0]).toBe("POST /api/bots");
    expect(f.bodies[0]).toMatchObject({ visibility: "admins", useDefaults: false });
  });

  it("names who a new team bot reports to in the creation request, and nobody anywhere else", async () => {
    const team = fixture("ask");
    await createConfiguredBot(team.draft, team.request, persistBotUpdate, undefined, "bob@acme.test");
    expect(team.bodies[0]).toMatchObject({ reportsTo: "bob@acme.test" });
    const solo = fixture("ask");
    await createConfiguredBot(solo.draft, solo.request, persistBotUpdate);
    expect(solo.bodies[0]).not.toHaveProperty("reportsTo");
  });

  it("applies tool restrictions atomically before a new bot is published", async () => {
    const f = fixture("ask");
    f.draft.patch({ toolScope: { allow: [], deny: ["mcp:mail:send"] } });
    expect(f.bodies[0]).toMatchObject({ settings: { toolScope: { allow: [], deny: ["mcp:mail:send"] } } });
    expect(f.bodies[1]).not.toHaveProperty("toolScope");
  });

  it("keeps the server-completed workspace effort when applying draft settings", async () => {
    const selection = { instanceId: "claude", model: "sonnet", effort: "high" as const };
    const f = fixture("ask", 0, selection);
    f.draft.setModel({ instanceId: selection.instanceId, model: selection.model });
    const result = await createConfiguredBot(f.draft, f.request, persistBotUpdate);
    expect(f.bodies[0]).toMatchObject({ modelSelection: { instanceId: "claude", model: "sonnet" }, requireAvailableModel: true });
    expect(f.bodies[1]).not.toHaveProperty("modelSelection");
    expect(result.bot.modelSelection).toEqual(selection);
  });

  it("asks for no AI when none is set up, so the server makes the bot without one", async () => {
    const f = fixture("ask");
    f.draft.setModel({ instanceId: "", model: "" });
    await createConfiguredBot(f.draft, f.request, persistBotUpdate);
    expect(f.bodies[0]).not.toHaveProperty("modelSelection");
    expect(f.bodies[0]).not.toHaveProperty("requireAvailableModel");
    expect(f.events).not.toContain("DELETE /api/bots/created");
  });

  // Lazurio overlay (DEV-6673): every level goes over the API; the desktop grant and Custom are removed.
  for (const mode of ["ask", "auto", "full"] as const) {
    it(`commits ${mode} settings without reapplying the template`, async () => {
      const f = fixture(mode);
      const result = await createConfiguredBot(f.draft, f.request, persistBotUpdate);
      expect(f.bodies[0]).toMatchObject({ useDefaults: false, name: "Fixture" });
      expect(result.bot).toMatchObject({ approvalMode: mode, notifications: false });
      expect(result.warnings).toEqual([]);
      expect(f.events).not.toContain("DELETE /api/bots/created");
    });
  }

  it("applies Full to the bot and its first thread over the API", async () => {
    const f = fixture("full");
    const result = await createConfiguredBot(f.draft, f.request, persistBotUpdate);
    expect(result.bot).toMatchObject({ approvalMode: "full" });
    expect(f.events).toEqual(["POST /api/bots", "PATCH /api/bots/created", "PATCH /api/bots/created/tasks/initial"]);
    expect(f.bodies[1]).toMatchObject({ approvalMode: "full" });
    expect(f.bodies[2]).toEqual({ approvalMode: "full" });
    for (const body of f.bodies) expect(body).not.toHaveProperty("confirmFullAccess");
  });

  for (const fail of [1, 2]) {
    it(`rolls back when the level write ${fail} fails`, async () => {
      const f = fixture("full", fail);
      await expect(createConfiguredBot(f.draft, f.request, persistBotUpdate)).rejects.toThrow("Level refused");
      expect(f.events.at(-1)).toBe("DELETE /api/bots/created");
    });
  }
});
