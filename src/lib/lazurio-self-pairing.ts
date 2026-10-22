// Lazurio overlay (pair straight in): the Environment pairs every browser its gateway's admission lets in, as it does
// for Lazurio's T3 Code. The gateway sends /.lazurio/* on this origin to the Launchpad, which gives a page's own script
// fetch a one-time pairing code; a plain OpenMausBot answers that path with its page, so nothing pairs there.
import { pairedDestination } from "./phone-pairing";
import { defaultDeviceLabel, isConnected, pairWithCode, readSessionState, takePairingCodeFromLocation } from "./session";

export const SELF_PAIRING_PATH = "/.lazurio/mausbot/pairing";

const PAIRING_CODE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

/** Only the Launchpad's exact answer counts; anything else (404, the app's own page, an error) is no code. */
export async function fetchSelfPairingCode(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(SELF_PAIRING_PATH, { credentials: "same-origin" });
    if (res.status !== 200) return null;
    const body = Object(await res.json()) as { kind?: unknown; code?: unknown };
    return body.kind === "mausbot-pairing" && typeof body.code === "string" && PAIRING_CODE.test(body.code) ? body.code : null;
  } catch {
    return null;
  }
}

/** Pairs this browser with a code the Environment gives it; never shows or logs the code. */
export async function selfPair(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const code = await fetchSelfPairingCode(fetchImpl);
  if (!code) return false;
  return (await pairWithCode({ code, label: defaultDeviceLabel() }, fetchImpl)).ok;
}

/**
 * /pair without a browser sign-in: a connected browser, or one the Environment pairs itself, opens the app at once on
 * the page it would reach after pairing. The link's code leaves the address bar either way and is used only by the
 * pairing page.
 */
export async function enterFromPairLink(fetchImpl: typeof fetch = fetch): Promise<{ app: true } | { app: false; initialCode: string | null }> {
  const initialCode = takePairingCodeFromLocation();
  const session = await readSessionState(fetchImpl);
  if (isConnected(session) || (session.kind === "unauthenticated" && await selfPair(fetchImpl))) {
    return { app: true };
  }
  return { app: false, initialCode };
}