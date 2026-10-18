import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./store";

afterEach(() => { vi.unstubAllGlobals(); });

describe("api() background polls", () => {
  it("marks background polls, and leaves every other request as before", async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await api("/api/team-map", { background: true });
    await api("/api/threads");
    await api("/api/upload", { method: "PUT", headers: { "x-omb-sha256": "abc" } });
    const sent = fetch.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(sent[0].get("x-omb-background")).toBe("1");
    expect(sent[0].get("content-type")).toBe("application/json");
    expect(sent[1].get("x-omb-background")).toBeNull();
    expect(sent[1].get("content-type")).toBe("application/json");
    expect(sent[2].get("content-type")).toBeNull();
    expect(sent[2].get("x-omb-sha256")).toBe("abc");
  });
});
