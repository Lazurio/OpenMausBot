import { createServer, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverSseFrame, openSseHeartbeat, SSE_MAX_BUFFERED_BYTES, type SseFanoutClient } from "./sse-fanout.ts";

function fakeClient(resOverrides: Partial<SseFanoutClient["res"]> = {}): SseFanoutClient {
  return {
    close: () => {},
    res: {
      writableLength: 0,
      write: () => true,
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

  it("treats a throwing write() as a dead connection", () => {
    const client = fakeClient({
      write: () => {
        throw new Error("socket hang up");
      },
    });
    expect(deliverSseFrame(client, "message-1")).toBe("disconnected");
  });
});

describe("openSseHeartbeat", () => {
  const opened: { close(): void }[] = [];
  afterEach(() => {
    for (const each of opened.splice(0)) each.close();
  });

  /** A response whose client never reads, so ending it leaves bytes queued and the request never sees "close". */
  async function stalledStream() {
    const server = createServer();
    const response = new Promise<ServerResponse>((resolve) => server.once("request", (_req, res) => resolve(res)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const socket: Socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
    opened.push({ close: () => { socket.destroy(); server.closeAllConnections(); server.close(); } });
    socket.pause();
    socket.write("GET /api/events HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n");
    const res = await response;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${"x".repeat(16 * 1024 * 1024)}\n\n`);
    const errors: Error[] = [];
    const writesAfterEnd: string[] = [];
    const write = res.write.bind(res) as (chunk: string) => boolean;
    res.write = ((chunk: string) => {
      if (res.writableEnded) writesAfterEnd.push(chunk);
      return write(chunk);
    }) as typeof res.write;
    return { res, errors, writesAfterEnd, recordErrors: () => res.on("error", (error) => errors.push(error)) };
  }

  it("stops and leaves before ending the response when the session stops being live, with the socket still open", async () => {
    const stream = await stalledStream();
    let live = true;
    const onClose = vi.fn(() => expect(stream.res.writableEnded).toBe(false));
    openSseHeartbeat(stream.res, { everyMs: 10, live: () => live, onClose });
    stream.recordErrors();
    await sleep(35);
    live = false;
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    await sleep(60);
    expect(stream.res.writableEnded).toBe(true);
    expect(stream.res.writableFinished).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(stream.writesAfterEnd).toEqual([]);
    expect(stream.errors).toEqual([]);
  });

  it("never writes after another path ended the response while its socket stayed open", async () => {
    const stream = await stalledStream();
    const onClose = vi.fn();
    openSseHeartbeat(stream.res, { everyMs: 10, live: () => true, onClose });
    stream.recordErrors();
    await sleep(25);
    stream.res.end();
    await sleep(60);
    expect(stream.res.writableFinished).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(stream.writesAfterEnd).toEqual([]);
    expect(stream.errors).toEqual([]);
  });

  it("keeps the process up when a write on the response fails", async () => {
    const stream = await stalledStream();
    const onClose = vi.fn();
    const close = openSseHeartbeat(stream.res, { everyMs: 1000, live: () => true, onClose });
    stream.res.end();
    stream.res.write("late frame\n\n");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ends a client past the buffer bound only after it left the fanout and its heartbeat stopped", async () => {
    const stream = await stalledStream();
    const fanout = new Set<SseFanoutClient>();
    let liveChecks = 0;
    const onClose = vi.fn(() => fanout.delete(client));
    const atEnd: { inFanout: boolean; closes: number; liveChecks: number }[] = [];
    const end = stream.res.end.bind(stream.res) as () => ServerResponse;
    stream.res.end = (() => {
      atEnd.push({ inFanout: fanout.has(client), closes: onClose.mock.calls.length, liveChecks });
      return end();
    }) as typeof stream.res.end;
    const client: SseFanoutClient = {
      res: stream.res,
      close: openSseHeartbeat(stream.res, { everyMs: 10, live: () => ++liveChecks > 0, onClose }),
    };
    fanout.add(client);
    stream.recordErrors();
    await vi.waitFor(() => expect(liveChecks).toBeGreaterThan(1));
    // How much of a stalled socket's queue stays in writableLength is up to the OS (Windows hands all 16 MiB to the kernel), so the response reports past the bound.
    Object.defineProperty(stream.res, "writableLength", { value: SSE_MAX_BUFFERED_BYTES + 1 });

    if (deliverSseFrame(client, "data: durable\n\n") === "disconnected") client.close();

    expect(atEnd).toEqual([{ inFanout: false, closes: 1, liveChecks }]);
    const checksAtEnd = liveChecks;
    client.close();
    client.close();
    await sleep(60);
    expect(atEnd).toHaveLength(1);
    expect(onClose).toHaveBeenCalledOnce();
    expect(liveChecks).toBe(checksAtEnd);
    expect(stream.res.writableFinished).toBe(false);
    expect(stream.writesAfterEnd).toEqual([]);
    expect(stream.errors).toEqual([]);
  });
});
