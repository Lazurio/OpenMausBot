import { describe, expect, it } from "vitest";

import { transitionComputerControlLease } from "../lib/computer-control";

const snap = (held: boolean) => ({ held, helpReason: null });

describe("computer control transition", () => {
  it("takes and releases the server lease", async () => {
    const calls: string[] = [];
    await transitionComputerControlLease({
      action: "take",
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(true); },
    });
    await transitionComputerControlLease({
      action: "release",
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(false); },
    });
    expect(calls).toEqual(["server:take", "server:release"]);
  });

  it("fails when the server did not release", async () => {
    await expect(transitionComputerControlLease({
      action: "release",
      requestControl: async () => snap(true),
    })).rejects.toThrow(/could not release/i);
  });

  it("fails when the server did not confirm a take", async () => {
    await expect(transitionComputerControlLease({
      action: "take",
      requestControl: async () => snap(false),
    })).rejects.toThrow(/could not confirm/i);
  });
});
