// OMB_HEADLESS_FULL_ACCESS: an operator-only opt-in at server start that lets
// the loopback owner set a bot to Full access through the HTTP API. Unset,
// the server refuses that exactly as upstream does; set, only entering Full
// is unlocked, never Custom and never leaving Custom.
import { describe, expect, it } from "vitest";

import { APPROVAL_MODES } from "../shared/approval-mode.ts";
import { headlessFullAccessFromEnv, headlessFullAccessPermits } from "./headless-full-access.ts";
import type { RequestAuth } from "./request-auth.ts";

const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

describe("headlessFullAccessFromEnv", () => {
  it("is off when unset, empty, 0 or false", () => {
    for (const value of [undefined, "", " ", "0", "false", "FALSE"]) {
      expect(headlessFullAccessFromEnv({ OMB_HEADLESS_FULL_ACCESS: value }), String(value)).toBe(false);
    }
  });

  it("is on for 1 or true", () => {
    for (const value of ["1", "true", " TRUE "]) {
      expect(headlessFullAccessFromEnv({ OMB_HEADLESS_FULL_ACCESS: value }), value).toBe(true);
    }
  });

  it("refuses any other value by name, so the server does not start on it", () => {
    for (const value of ["yes", "on", "2", "full"]) {
      expect(() => headlessFullAccessFromEnv({ OMB_HEADLESS_FULL_ACCESS: value }), value)
        .toThrow(/^OMB_HEADLESS_FULL_ACCESS must be 1 /);
    }
  });

  it("stays off in the desktop app, which has its own private confirmation", () => {
    expect(headlessFullAccessFromEnv({ OMB_HEADLESS_FULL_ACCESS: "1", OMB_DESKTOP_PARENT: "1" })).toBe(false);
  });
});

describe("headlessFullAccessPermits", () => {
  const permits = (input: Partial<Parameters<typeof headlessFullAccessPermits>[0]>) =>
    headlessFullAccessPermits({ enabled: true, auth: owner, current: "ask", requested: "full", ...input });

  it("lets the loopback owner raise a bot to Full from Ask, Edits or Auto", () => {
    for (const current of ["ask", "edits", "auto"] as const) expect(permits({ current }), current).toBe(true);
  });

  it("unlocks nothing without the opt-in", () => {
    for (const current of APPROVAL_MODES) {
      for (const requested of APPROVAL_MODES) {
        expect(permits({ enabled: false, current, requested }), `${current} -> ${requested}`).toBe(false);
      }
    }
  });

  it("never unlocks Custom, nor leaving it", () => {
    for (const current of APPROVAL_MODES) {
      expect(permits({ current, requested: "custom" }), `${current} -> custom`).toBe(false);
    }
    for (const requested of APPROVAL_MODES) {
      expect(permits({ current: "custom", requested }), `custom -> ${requested}`).toBe(false);
    }
  });

  it("is only for the owner on loopback, not a paired session or a service-trust loopback", () => {
    expect(permits({ auth: { kind: "loopback", scopes: ["client"], trust: "service" } })).toBe(false);
    expect(permits({
      auth: { kind: "session", via: "bearer", scopes: ["admin", "client"], session: {} as never },
    })).toBe(false);
  });
});
