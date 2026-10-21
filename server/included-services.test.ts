import { describe, expect, it } from "vitest";

import { jevEndpoint } from "./decider/jev.ts";
import { deciderCredential, voiceCredential } from "./included-services.ts";

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
