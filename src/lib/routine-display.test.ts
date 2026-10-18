import { describe, expect, it } from "vitest";

import { routineRunsOn } from "./routine-display";

describe("where a routine runs", () => {
  it("on the Cloud, every routine runs on schedule even when the person's computer is off", () => {
    expect(routineRunsOn({ roomGoal: false, cloudHome: true })).toEqual({
      label: "The Cloud", hint: "Runs on schedule, even when your computer is off.",
    });
    expect(routineRunsOn({ roomGoal: true, cloudHome: true })).toEqual({
      label: "The Cloud, with the whole group", hint: "Runs on schedule, even when your computer is off.",
    });
  });

  it("on a desktop, a routine starts while OpenMausBot is open there", () => {
    expect(routineRunsOn({ roomGoal: false, cloudHome: false })).toEqual({
      label: "This computer", hint: "Starts while OpenMausBot is open here.",
    });
    expect(routineRunsOn({ roomGoal: true, cloudHome: false }).label).toBe("This computer, with the whole group");
  });
});
