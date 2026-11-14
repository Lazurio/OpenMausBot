import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RoutineManager, nextOccurrence } from "./routines.ts";

it("an event wait has no default cutoff and escalation lowers its existing cadence across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "mausbot-wait-routine-"));
  try {
    const now = Date.UTC(2026, 0, 1);
    const options = { file: join(dir, "routines.json"), now: () => now, botState: () => "ready" as const, createTask: () => ({ threadId: "thread" }), startTurn: async () => {} };
    const manager = new RoutineManager(options);
    const routine = manager.create({ botId: "bot", name: "Wait for review", prompt: "Check the exact head; escalate after two hours and reduce the cadence; pause on verdict.", schedule: { type: "interval", everyMinutes: 5, anchorAt: now } });
    expect(routine.schedule).not.toHaveProperty("endsAt");
    manager.update(routine.id, { schedule: { type: "interval", everyMinutes: 60, anchorAt: now } });
    const restored = new RoutineManager(options).listRoutines().find((row) => row.id === routine.id)!;
    expect(restored).toMatchObject({ enabled: true, schedule: { everyMinutes: 60 } });
    expect(restored.schedule).not.toHaveProperty("endsAt");
    expect(nextOccurrence(restored.schedule, now + 30 * 24 * 60 * 60_000)).toBe(now + (30 * 24 + 1) * 60 * 60_000);
    manager.update(routine.id, { enabled: false });
    expect(manager.listRoutines().find((row) => row.id === routine.id)?.enabled).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
