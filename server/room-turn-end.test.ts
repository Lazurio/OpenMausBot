import { describe, expect, it } from "vitest";

import { roomTurnEnd } from "./room-turn-end.ts";

describe("how a room member's turn ends", () => {
  const ok = { ok: true };
  const broke = { ok: false, stopReason: "exit_before_result" };

  it("settles on an ordinary end, and fails a team step with the engine's reason", () => {
    expect(roomTurnEnd(ok, true)).toEqual({ outcome: "settled" });
    expect(roomTurnEnd(broke, false)).toEqual({ outcome: "settled" });
    expect(roomTurnEnd(broke, true)).toEqual({ outcome: "provider_failed", stopReason: "exit_before_result" });
    expect(roomTurnEnd({ ok: false }, true)).toEqual({ outcome: "provider_failed", stopReason: null });
  });
});
