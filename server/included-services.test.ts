import { describe, expect, it } from "vitest";

import { jevEndpoint } from "./decider/jev.ts";
import { applyIncludedXMessage, boatCredential, deciderCredential, researchCredential, trialCreditCredential, voiceCredential, xCredential, xResearchStatus } from "./included-services.ts";

const RELAY_VOICE = "https://cloud.example.test/api/cloud/services/voice/v1";
// A Jev base URL: the relay's one route is <this>/v1/systemone.
const RELAY_DECIDER = "https://cloud.example.test/api/cloud/services/decider";
const cloud = {
  OMB_CLOUD_VOICE_URL: RELAY_VOICE,
  OMB_CLOUD_VOICE_TOKEN: "omb_voice_included",
  OMB_CLOUD_DECIDER_URL: RELAY_DECIDER,
  OMB_CLOUD_DECIDER_TOKEN: "omb_decide_included",
};


describe("ElevenLabs credential", () => {
  it("is the person's own key, sent only to ElevenLabs", () => {
    expect(voiceCredential("sk-own", {})).toEqual({ token: "sk-own", api: "https://api.elevenlabs.io/v1" });
    expect(voiceCredential("sk-own", { OMB_ELEVENLABS_API: "http://127.0.0.1:9/v1" })).toEqual({ token: "sk-own", api: "http://127.0.0.1:9/v1" });
  });

  it("is nothing without an own key, whatever the environment holds", () => {
    expect(voiceCredential(undefined, { OMB_CLOUD_VOICE_URL: "https://relay.example.test/v1", OMB_CLOUD_VOICE_TOKEN: "omb_voice_included" })).toBeNull();
  });
});

describe("Jev credential", () => {
  // `api` is a Jev base URL: the backend adds /v1/systemone.
  const endpoint = (credential: ReturnType<typeof deciderCredential>) => String(jevEndpoint(credential?.api));

  it("uses the person's own key, sent only to Jev or their own base URL", () => {
    const own = deciderCredential(" tsk_own ", undefined);
    expect(own).toEqual({ token: "tsk_own", api: "https://api.typesafe.ai" });
    expect(endpoint(own)).toBe("https://api.typesafe.ai/v1/systemone");
    const local = deciderCredential("tsk_own", "http://127.0.0.1:9");
    expect(local).toEqual({ token: "tsk_own", api: "http://127.0.0.1:9" });
    expect(endpoint(local)).toBe("http://127.0.0.1:9/v1/systemone");
  });

  it("is nothing without an own key", () => {
    for (const own of [undefined, "", "   "]) expect(deciderCredential(own, undefined)).toBeNull();
  });
});
  });
});

describe("X research credential", () => {
  const RELAY_X = "https://cloud.example.test/api/cloud/services/x";
  const desktopToken = `omb_xd_${"a".repeat(43)}`;
  afterEach(() => { applyIncludedXMessage({ type: "openmausbot:included-x", access: null }); });

  it("is a Cloud home's included token, sent only to the relay, and there is no own-key path", () => {
    expect(xCredential({ OMB_CLOUD_X_URL: `${RELAY_X}/`, OMB_CLOUD_X_TOKEN: "omb_x_included" })).toEqual({ token: "omb_x_included", api: RELAY_X, included: true });
    expect(xCredential({})).toBeNull();
    expect(xCredential({ OMB_CLOUD_X_URL: RELAY_X })).toBeNull();
  });

  it("takes a signed-in desktop's token from its main process, and drops it when told", () => {
    expect(applyIncludedXMessage({ type: "openmausbot:included-x", access: { url: RELAY_X, token: desktopToken } })).toBe(true);
    expect(xCredential({})).toEqual({ token: desktopToken, api: RELAY_X, included: true });
    expect(applyIncludedXMessage({ type: "openmausbot:included-x", access: null })).toBe(true);
    expect(xCredential({})).toBeNull();
  });

  it("ignores other messages and refuses a malformed one without changing what it holds", () => {
    applyIncludedXMessage({ type: "openmausbot:included-x", access: { url: RELAY_X, token: desktopToken } });
    expect(applyIncludedXMessage({ type: "openmausbot:managed-composio", access: null })).toBe(false);
    for (const access of [{ url: "http://cloud.example.test/api/cloud/services/x", token: desktopToken }, { url: RELAY_X, token: "" }, { url: "not a url", token: desktopToken },
      { url: RELAY_X, token: "x".repeat(300) }, "nope"]) {
      expect(() => applyIncludedXMessage({ type: "openmausbot:included-x", access }), JSON.stringify(access)).toThrow();
    }
    expect(xCredential({})?.token).toBe(desktopToken);
  });

  it("lets a loopback relay through for development and tests only over http", () => {
    applyIncludedXMessage({ type: "openmausbot:included-x", access: { url: "http://127.0.0.1:4300/api/cloud/services/x", token: desktopToken } });
    expect(xCredential({})?.api).toBe("http://127.0.0.1:4300/api/cloud/services/x");
  });
});

describe("X research status for the app's Settings", () => {
  const RELAY_X = "https://cloud.example.test/api/cloud/services/x";
  afterEach(() => { applyIncludedXMessage({ type: "openmausbot:included-x", access: null }); });

  it("is included with a credential, not offered once the Admin said no, and plain not-included otherwise", () => {
    expect(xResearchStatus({})).toEqual({ included: false });
    applyIncludedXMessage({ type: "openmausbot:included-x", access: null, offered: false });
    expect(xResearchStatus({})).toEqual({ included: false, unavailable: true });
    applyIncludedXMessage({ type: "openmausbot:included-x", access: { url: RELAY_X, token: `omb_xd_${"b".repeat(43)}` } });
    expect(xResearchStatus({})).toEqual({ included: true });
    applyIncludedXMessage({ type: "openmausbot:included-x", access: null });
    expect(xResearchStatus({})).toEqual({ included: false });
    expect(xResearchStatus({ OMB_CLOUD_X_URL: RELAY_X, OMB_CLOUD_X_TOKEN: "omb_x_home" })).toEqual({ included: true });
  });
});

describe("research credential", () => {
  const RELAY_X = "https://cloud.example.test/api/cloud/services/x";
  const plan = { OMB_CLOUD_X_URL: RELAY_X, OMB_CLOUD_X_TOKEN: "omb_x_home" };

  it("is the person's own treg key, sent straight to treg, and it wins over the plan's relay credential", () => {
    expect(researchCredential(" treg_own ", {})).toEqual({ token: "treg_own", api: "https://treg.to", included: false });
    expect(researchCredential("treg_own", plan)).toEqual({ token: "treg_own", api: "https://treg.to", included: false });
  });

  it("is the plan's relay credential without an own key, and nothing with neither", () => {
    expect(researchCredential(undefined, plan)).toEqual({ token: "omb_x_home", api: RELAY_X, included: true });
    expect(researchCredential("  ", plan)).toEqual({ token: "omb_x_home", api: RELAY_X, included: true });
    expect(researchCredential(undefined, {})).toBeNull();
  });

  it("sends an own key only to treg over https, or to a loopback stand-in", () => {
    expect(researchCredential("k", { OMB_TREG_URL: "http://127.0.0.1:4300/" })?.api).toBe("http://127.0.0.1:4300");
    for (const url of ["http://evil.example.test", "ftp://treg.to", "not a url"]) expect(researchCredential("k", { OMB_TREG_URL: url })?.api, url).toBe("https://treg.to");
  });
});

