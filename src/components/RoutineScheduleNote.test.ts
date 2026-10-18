import { describe, expect, it } from "vitest";
import { schedulePlace } from "./RoutineScheduleNote";

describe("where a routine runs, said where it is scheduled", () => {
  it("a Cloud home, another server, or this computer", () => {
    expect(schedulePlace({ cloudHome: true, local: false })).toEqual({ kind: "cloud" });
    expect(schedulePlace({ cloudHome: false, local: false })).toEqual({ kind: "server" });
    expect(schedulePlace({ cloudHome: false, local: true })).toEqual({ kind: "local" });
  });
});
