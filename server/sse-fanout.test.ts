import { describe, expect, it } from "vitest";

import { deliverSseFrame, SSE_MAX_BUFFERED_BYTES, type SseFanoutClient } from "./sse-fanout.ts";

function fakeClient(resOverrides: Partial<SseFanoutClient["res"]> = {}): SseFanoutClient {
  return {
    res: {
      writableLength: 0,
      write: () => true,
      end: () => {},
      ...resOverrides,
    },
  };
}

describe("deliverSseFrame", () => {
  it("sends every frame, even while write() reports a full buffer", () => {
    const written: string[] = [];
    const client = fakeClient({
      write: (chunk: string) => {
        written.push(chunk);
        return false;
      },
    });
    expect(deliverSseFrame(client, "message-1")).toBe("sent");
    expect(deliverSseFrame(client, "message-2")).toBe("sent");
    expect(written).toEqual(["message-1", "message-2"]);
  });

  it("disconnects a client once buffered bytes exceed the bound", () => {
    let ended = false;
    const client = fakeClient({
      writableLength: SSE_MAX_BUFFERED_BYTES + 1,
      end: () => {
        ended = true;
      },
    });
    expect(deliverSseFrame(client, "message-1")).toBe("disconnected");
    expect(ended).toBe(true);
  });

  it("treats a throwing write() as a dead connection", () => {
    const client = fakeClient({
      write: () => {
        throw new Error("socket hang up");
      },
    });
    expect(deliverSseFrame(client, "message-1")).toBe("disconnected");
  });
});
