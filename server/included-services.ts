// The person's own key for a service, resolved per request; it goes only to its provider's base URL.
// Lazurio overlay (DEV-6673 M3): MausBot Cloud's included relays (voice, decision model, trial AI credit) are removed.
import { JEV_DEFAULT_BASE_URL } from "./decider/jev.ts";

export const ELEVENLABS_API_DEFAULT = "https://api.elevenlabs.io/v1";

export interface ServiceCredential {
  token: string;
  /** The only base URL this token is ever sent to. */
  api: string;
}

function own(token: string | undefined, api: string): ServiceCredential | null {
  return token ? { token, api } : null;
}

export const elevenLabsProviderApi = (env: NodeJS.ProcessEnv = process.env): string =>
  env.OMB_ELEVENLABS_API || ELEVENLABS_API_DEFAULT;

export function voiceCredential(token: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return own(token, elevenLabsProviderApi(env));
}

export function deciderCredential(token: string | undefined, ownBaseUrl: string | undefined): ServiceCredential | null {
  return own(token?.trim(), ownBaseUrl?.trim() || JEV_DEFAULT_BASE_URL);
}
