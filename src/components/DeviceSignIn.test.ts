import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/state/store";

afterEach(() => vi.unstubAllGlobals());

const waiting: DeviceSignInStatus = {
  phase: "waiting",
  flowId: "fixture-flow",
  authorizationUrl: "https://auth.openai.com/codex/device",
  userCode: "ABCD-12345",
  expiresAt: "2030-01-01T12:00:00.000Z",
};

  it.each([401, 403, 404, 410])("stops an obsolete flow after HTTP %i instead of retrying forever", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This flow no longer exists" }), { status })));
    const cause = await api("/fixture/auth/status").catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(ApiError);
    expect(cause.status).toBe(status);
    expect(deviceFlowUnavailable(cause)).toBe(true);
  });

  it("keeps transient network/provider failures retryable", () => {
    expect(deviceFlowUnavailable(new Error("Network interrupted"))).toBe(false);
    expect(deviceFlowUnavailable(new ApiError("Temporarily busy", 503))).toBe(false);
    expect(deviceFlowUnavailable(new ApiError("Rate limited", 429))).toBe(false);
  });
});

describe("ChatGPT plan browser sign-in", () => {
  const authorizationUrl = "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=fixture&code_challenge=fixture";

  it("uses the official browser flow without a device code or terminal command", () => {
    expect(chatgptPlanLink(authorizationUrl)).toBe(authorizationUrl);
    const html = renderBrowser({ ...waiting, authorizationUrl, userCode: undefined });
    expect(html).toContain("Continue with ChatGPT");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Waiting for you");
    expect(html).not.toContain("Copy sign-in code");
    expect(html).not.toContain("codex login");
  });

  it.each([
    "http://auth.openai.com/api/accounts/authorize",
    "https://auth.openai.com.evil.test/api/accounts/authorize",
    "https://user@auth.openai.com/api/accounts/authorize",
    "https://auth.openai.com/api/accounts/authorize#secret",
    "https://auth.openai.com/codex/device",
    "https://auth.openai.com/api/accounts/authorize/",
    "javascript:alert(1)",
  ])("does not expose an unexpected browser sign-in URL: %s", (url) => {
    expect(chatgptPlanLink(url)).toBeNull();
    const html = renderBrowser({ ...waiting, authorizationUrl: url });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("href=");
  });

  it("has browser-specific cancellation and expiry text", () => {
    expect(renderBrowser({ ...waiting, phase: "cancelled" })).not.toContain("new code");
    expect(renderBrowser({ ...waiting, phase: "expired" })).not.toContain("code expired");
  });
});
