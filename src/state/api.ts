// The renderer's JSON request helper.

/** Background requests (polls nobody asked for just now) carry this header. */
export const BACKGROUND_HEADER = "x-omb-background";

export class ApiError extends Error {
  readonly status: number;
  readonly body?: Record<string, unknown>;
  constructor(message: string, status: number, body?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** `background`: a poll nobody asked for just now. */
export async function api<T = any>(path: string, init?: RequestInit & { timeoutMs?: number; background?: boolean }): Promise<T> {
  const { timeoutMs, signal, background, headers, ...rest } = init ?? {};
  const sent = new Headers(headers ?? { "content-type": "application/json" });
  if (background) sent.set(BACKGROUND_HEADER, "1");
  const res = await fetch(path, {
    ...rest,
    headers: sent,
    signal: timeoutMs === undefined
      ? signal
      : signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = body?.error;
    const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, body);
  }
  return body;
}
