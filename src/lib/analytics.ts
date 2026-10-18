// The phc_ token is a write-only public key, safe to ship in the client.
// posthog-js loads on demand: a static import would put ~240 kB into the startup bundle.
import type { CaptureResult, PostHog } from "posthog-js";
import { DESKTOP_PORTS } from "../../electron/desktop-ports.mjs";
import { appVersion } from "@/lib/app-links";

const TOKEN = "phc_m2hP39w8y2gLPvHgDvSXAu6xcZ3agjf4ruL56rGcMZEe";

// Read before init(): an opted-out install must never call posthog.init(), so no request leaves the machine.
const OPT_OUT_KEY = "omb-analytics-opt-out";
// The desktop app's own page is served on whichever of its ports was free, and each port has its own storage.
const desktopSwitch = () => globalThis.window?.ogb?.desktopAnalytics;

/** False on the desktop app's own page while the app keeps no switch and the page is not on its first port, whose
 * storage may hold an opt-out saved before the app kept the switch. */
export function analyticsChoiceKnown(): boolean {
  const desktop = desktopSwitch();
  return !desktop?.set || desktop.enabled() !== null || globalThis.location?.port === String(DESKTOP_PORTS[0]);
}

let client: PostHog | undefined;
let loading: Promise<void> | undefined;
let pending: Array<(ph: PostHog) => void> = [];

// Outranks storage, so a rejected write cannot lose an opt-out.
let choice: boolean | undefined;

export function analyticsEnabled(): boolean {
  if (choice !== undefined) return choice;
  const desktop = desktopSwitch()?.enabled();
  if (typeof desktop === "boolean") return desktop;
  try {
    return localStorage.getItem(OPT_OUT_KEY) !== "1";
  } catch {
    return true;
  }
}

export type OptAction = "init" | "opt-in" | "opt-out" | "none";
export function optAction(enabled: boolean, running: boolean): OptAction {
  if (!enabled) return running ? "opt-out" : "none";
  return running ? "opt-in" : "init";
}

export function setAnalyticsEnabled(enabled: boolean) {
  choice = enabled;
  void desktopSwitch()?.set?.(enabled).catch(() => {});
  try {
    localStorage.setItem(OPT_OUT_KEY, enabled ? "0" : "1");
  } catch {
  }
  if (!enabled) pending = [];
  switch (optAction(enabled, client !== undefined)) {
    case "opt-out":
      client?.opt_out_capturing();
      break;
    case "opt-in":
      client?.opt_in_capturing({ captureEventName: false });
      break;
    case "init":
      void initAnalytics();
      break;
    case "none":
      break;
  }
}

function keepStoredOptOut() {
  const desktop = desktopSwitch();
  if (!desktop?.set || desktop.enabled() !== null) return;
  try {
    if (localStorage.getItem(OPT_OUT_KEY) !== "1") return;
  } catch {
    return;
  }
  void desktop.set(false).catch(() => {});
}

export function initAnalytics(): Promise<void> {
  return Promise.resolve();
}


}

export function analyticsSurface(): "local" | "server" {
  return globalThis.window?.ogb?.environments ? "local" : "server";
}

function whenReady(call: (ph: PostHog) => void) {
  if (!analyticsEnabled()) return;
  if (client) call(client);
  else if (loading) pending.push(call);
}

export function identifyEmail(_email: string): void {}

const GATE_KEY = "omb-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
