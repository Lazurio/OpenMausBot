import { describe, expect, it } from "vitest";

import { buildBotOverview, setupSteps, soulLead, type OverviewFacts } from "./bot-overview.ts";

function baseFacts(overrides: Partial<OverviewFacts> = {}): OverviewFacts {
  return {
    bot: {
      name: "Kiwi",
      title: "Tracker",
      description: "Files bugs.",
      soul: "",
      cwd: undefined,
      autoApprove: false,
      peers: [],
      chiefOfStaff: undefined,
    },
    routines: [],
    runs: [],
    webhooks: [],
    skills: [],
    engine: null,
    sectionPeers: 0,
    timeZone: "UTC",
    recent: [],
    ...overrides,
  };
}

const WONT_ORDER = [
  "Command approvals use Ask mode; saved permissions and provider rules still apply.",
  "Cannot initiate contact with other bots.",
  "Won't act on a schedule.",
  "Profile proposal cards require your approval.",
];

describe("buildBotOverview", () => {
  it("describes additional departments only for an authorized Chief", () => {
    const facts = baseFacts({ bot: { ...baseFacts().bot, chiefOfStaff: true, managedSections: ["Engineering", "Research"], peers: undefined }, engine: { agentsMcp: true }, sectionPeers: 3 });
    expect(buildBotOverview(facts).reaches).toContain("Also in charge of these departments: Engineering, Research.");
    facts.bot.chiefOfStaff = false;
    expect(buildBotOverview(facts).reaches.join(" ")).not.toContain("Engineering");
  });

  it("says a bot can talk to every other bot unless a peers list narrows it", () => {
    const open = baseFacts({ bot: { ...baseFacts().bot, peers: undefined }, engine: { agentsMcp: true }, sectionPeers: 3 });
    expect(buildBotOverview(open).reaches).toContain("Can talk to all 3 other bots, in any department.");
    expect(buildBotOverview({ ...open, sectionPeers: 1 }).reaches).toContain("Can talk to the other bot.");
    const listed = baseFacts({ bot: { ...baseFacts().bot, peers: ["a", "b"] }, engine: { agentsMcp: true }, sectionPeers: 2 });
    expect(buildBotOverview(listed).reaches).toContain("Talks only to the bots chosen for it.");
    expect(buildBotOverview(listed).reaches.join(" ")).not.toContain("department");
  });
  it("yields all five wont lines in order and no does lines for a bot on Ask", () => {
    const overview = buildBotOverview(baseFacts({ bot: { ...baseFacts().bot, approvalMode: "ask" } }));
    expect(overview.wont).toEqual(WONT_ORDER);
    expect(overview.does).toEqual([]);
  });

  it("describes a fresh bot at the default level, Full access", () => {
    expect(buildBotOverview(baseFacts()).wont).toEqual(WONT_ORDER.slice(1, -1));
  });

  it("drops the first wont line when autoApprove is on", () => {
    const overview = buildBotOverview(baseFacts({ bot: { ...baseFacts().bot, autoApprove: true } }));
    expect(overview.wont).toEqual(WONT_ORDER.slice(1));
  });

  it("uses the effective approval level rather than the legacy Auto bit", () => {
    const bot = { ...baseFacts().bot, approvalMode: "full" as const, autoApprove: false };
    expect(buildBotOverview(baseFacts({ bot })).wont).not.toContain(WONT_ORDER[0]);
  });

  // Lazurio overlay (DEV-6673): no bot asks a person before contacting another bot, at any level.
  it("never promises peer approvals, and promises profile proposal cards only under supervision", () => {
    const bot = { ...baseFacts().bot, peers: undefined, approvalMode: "full" as const, autoApprove: false };
    const full = buildBotOverview(baseFacts({ bot })).wont;
    expect(full).not.toContain("Asks before contacting other bots.");
    expect(full).not.toContain("Profile proposal cards require your approval.");
    for (const approvalMode of ["ask", "edits"] as const) {
      const reviewed = buildBotOverview(baseFacts({ bot: { ...bot, approvalMode, autoApprove: true } })).wont;
      expect(reviewed).not.toContain("Asks before contacting other bots.");
      expect(reviewed).toContain("Profile proposal cards require your approval.");
    }
    expect(buildBotOverview(baseFacts({ bot: { ...bot, peers: [] } })).wont)
      .toContain("Cannot initiate contact with other bots.");
  });

  it("renders an enabled interval routine with its last completed run", () => {
    const facts = baseFacts({
      routines: [
        {
          id: "r1",
          name: "Triage Discord",
          enabled: true,
          schedule: { type: "interval", everyMinutes: 5, anchorAt: 1_000 },
          nextRunAt: 2_000,
        },
      ],
      runs: [
        { routineId: "r1", status: "completed", finishedAt: 1_500, scheduledFor: 1_000 },
      ],
    });
    const overview = buildBotOverview(facts);
    expect(overview.does).toHaveLength(1);
    expect(overview.does[0]).toMatch(/^Every 5 minutes: Triage Discord\./);
    expect(overview.does[0]).not.toContain("UTC");
    expect(overview.does[0]).not.toContain("anchored");
    expect(overview.does[0]).toContain("Last run completed at");
    expect(overview.does[0]).toContain("Next run");
    expect(overview.wont).not.toContain("Won't act on a schedule.");
  });

  it("renders a paused routine as Paused: name", () => {
    const facts = baseFacts({
      routines: [
        {
          id: "r2",
          name: "Nightly Backup",
          enabled: false,
          schedule: { type: "daily", time: "09:00", weekdays: [1] },
          nextRunAt: null,
        },
      ],
    });
    const overview = buildBotOverview(facts);
    expect(overview.does).toEqual(["Paused: Nightly Backup."]);
    expect(overview.wont).toContain("Won't act on a schedule.");
  });

  it("renders enabled skills and webhooks as their own does lines", () => {
    const facts = baseFacts({
      skills: [
        { name: "triage", description: "Triage incoming bug reports", enabled: true },
        { name: "disabled-skill", description: "Should not appear", enabled: false },
      ],
      webhooks: [
        { name: "Linear", enabled: true },
        { name: "Disabled hook", enabled: false },
      ],
    });
    const overview = buildBotOverview(facts);
    expect(overview.does).toEqual([
      "Knows how to triage incoming bug reports.",
      "Listens for “Linear” webhooks.",
    ]);
  });

  it("writes daily and once schedules as prose", () => {
    const overview = buildBotOverview(baseFacts({
      routines: [
        { id: "a", name: "Standup", enabled: true, schedule: { type: "daily", time: "09:30", weekdays: [1, 2, 3, 4, 5] }, nextRunAt: null },
        { id: "b", name: "Digest", enabled: true, schedule: { type: "daily", time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, nextRunAt: null },
        { id: "c", name: "Review", enabled: true, schedule: { type: "daily", time: "08:00", weekdays: [3] }, nextRunAt: null },
        { id: "d", name: "Launch", enabled: true, schedule: { type: "once", at: Date.UTC(2026, 8, 5, 12) }, nextRunAt: null },
        { id: "e", name: "Hourly", enabled: true, schedule: { type: "interval", everyMinutes: 60 }, nextRunAt: null },
      ],
    }));
    expect(overview.does).toEqual([
      "Every weekday at 9:30 AM: Standup.",
      "Every day at 6:00 PM: Digest.",
      "Weekly on Wednesday at 8:00 AM: Review.",
      "Once on September 5 at 12:00 PM: Launch.",
      "Every hour: Hourly.",
    ]);
  });

  it("stays reachable by default when peers are unset, and names no computer preference", () => {
    const facts = baseFacts({
      bot: { ...baseFacts().bot, peers: undefined },
    });
    const overview = buildBotOverview(facts);
    expect(overview.reaches.some((line) => line.startsWith("Computer preference"))).toBe(false);
    expect(overview.wont).not.toContain("Won't contact other bots without asking.");
  });
});

describe("soulLead", () => {
  it("cuts at the first blank line", () => {
    expect(soulLead("First paragraph.\n\nSecond paragraph.")).toBe("First paragraph.");
  });

  it("cuts at 240 characters", () => {
    const long = "A".repeat(300);
    const result = soulLead(long);
    expect(result).toBe(`${"A".repeat(240)}…`);
  });

  it("returns an empty string for an unset soul", () => {
    expect(soulLead(undefined)).toBe("");
  });
});

describe("setupSteps", () => {
  it("lists optional setup ideas without inspecting conversation history", () => {
    const steps = setupSteps(baseFacts({ bot: { ...baseFacts().bot, name: "New bot", title: "", description: "" } }));
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ["identity", false],
      ["soul", false],
      ["folder", false],
      ["schedule", false],
    ]);
    expect(steps.every((step) => step.section)).toBe(true);
  });

  it("marks steps done from the same facts the sentences use", () => {
    const facts = baseFacts({
      bot: { ...baseFacts().bot, name: "Kiwi", title: "Tracker", soul: "Be brief.", cwd: "/work" },
      routines: [{ id: "r1", name: "Digest", enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, nextRunAt: null }],
    });
    expect(setupSteps(facts).every((step) => step.done)).toBe(true);
    expect(buildBotOverview(facts).setup).toEqual(setupSteps(facts));
  });

  it("does not count a paused routine as done", () => {
    const facts = baseFacts({
      routines: [{ id: "r1", name: "Digest", enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] }, nextRunAt: null }],
    });
    const byId = Object.fromEntries(setupSteps(facts).map((step) => [step.id, step.done]));
    expect(byId.schedule).toBe(false);
  });
});
