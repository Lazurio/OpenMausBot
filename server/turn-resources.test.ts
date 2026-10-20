import { describe, expect, it } from "vitest";
import { TurnResources } from "./turn-resources.ts";

const a = { threadId: "a", generation: "1" };
const b = { threadId: "b", generation: "2" };

describe("thread resource ownership", () => {
  it("allows independent resources but holds the same device across calls", () => {
    const leases = new TurnResources();
    expect(leases.claim("computer:phone", a)).toBe(true);
    expect(leases.claim("computer:phone", a)).toBe(true);
    expect(leases.claim("computer:phone", b)).toBe(false);
    expect(leases.claim("other", b)).toBe(true);
    leases.release(a);
    expect(leases.claim("computer:phone", b)).toBe(true);
    leases.release(a);
    expect(leases.claim("computer:phone", a)).toBe(false);
  });

  it("does not release a replacement generation", () => {
    const leases = new TurnResources();
    const next = { ...a, generation: "next" };
    expect(leases.claim("computer:phone", a)).toBe(true);
    expect(leases.claim("computer:phone", next)).toBe(false);
    leases.release(a);
    expect(leases.claim("computer:phone", next)).toBe(true);
    leases.release(a);
    expect(leases.claim("computer:phone", b)).toBe(false);
  });
});
