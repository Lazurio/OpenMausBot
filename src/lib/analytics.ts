// Lazurio overlay (DEV-6673 M3, issue #35): no product analytics. Upstream sends
// usage events and the e-mail a person types into the welcome tour to its own
// PostHog project; an Environment's data never goes to upstream or a third party,
// so Lazurio's distribution ships neither the client nor its key. The functions
// stay as no-ops so upstream's call sites stay unchanged; nothing is collected,
// stored or sent.

export function analyticsChoiceKnown(): boolean {
  return true;
}

export function analyticsEnabled(): boolean {
  return false;
}

export function setAnalyticsEnabled(_enabled: boolean): void {}

export function initAnalytics(): Promise<void> {
  return Promise.resolve();
}

export function track(_event: string, _props?: Record<string, unknown>): void {}

export function identifyEmail(_email: string, _options: { submitted?: boolean } = {}): void {}

// Upstream's welcome gate marker, kept local: older browsers that passed the
// welcome tour before it lost its e-mail step still count as done.
const GATE_KEY = "omb-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
