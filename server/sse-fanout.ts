export interface SseFanoutClient {
  res: {
    write(chunk: string): boolean;
    end(): void;
    writableLength: number;
  };
}

/** Past this, cut the client loose; its EventSource reconnects and replays via Last-Event-ID. */
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type SseFanoutOutcome = "sent" | "disconnected";

/** Every event is durable: it is written, or the client is disconnected to replay it. */
export function deliverSseFrame(client: SseFanoutClient, frame: string): SseFanoutOutcome {
  if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    try {
      client.res.end();
    } catch {
    }
    return "disconnected";
  }
  try {
    client.res.write(frame);
    return "sent";
  } catch {
    return "disconnected";
  }
}
