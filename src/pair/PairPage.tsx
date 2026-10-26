import { useEffect, useState } from "react";
import { DesktopWorkspaceSwitcher } from "../components/DesktopWorkspaceSwitcher";

import {
  defaultDeviceLabel,
  isConnected,
  newAttemptId,
  pairWithCode,
  readSessionState,
  reasonWorthShowing,
  type EnvironmentDescriptor,
  type SessionState,
} from "../lib/session";
import { pairedDestination } from "../lib/phone-pairing";

const input = "mt-1 w-full rounded-md border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent-border";
const button = "mt-5 w-full rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink disabled:opacity-50";
const fieldLabel = "mt-4 block text-[12px] font-medium text-ink-secondary";

/** Only the desktop app pairs from a link at once; a browser asks, so a sent link cannot sign it in unseen. */
export function pairsAutomatically(initialCode: string | null, desktop = typeof window !== "undefined" && Boolean(window.ogb?.workspaces)): boolean {
  return Boolean(initialCode) && desktop;
}

// Lazurio overlay (DEV-6673 M3): the OpenMausBot account's email-code sign-in is removed; devices pair with a code.
export function pairIntro({ cloudHome }: { cloudHome: boolean }): string {
  if (cloudHome) return "To open My Cloud, choose Open My Cloud in the OpenMausBot app on your computer (Settings → MausBot Cloud), or Use in your browser on your Plan page. Have a pairing code? Enter it below.";
  return "Enter the pairing code shown on the server. Codes work once and expire after five minutes.";
}

export function PairPage({ initialCode, reason }: { initialCode: string | null; reason?: string }) {
  const [code, setCode] = useState(initialCode ?? "");
  const [label, setLabel] = useState(defaultDeviceLabel());
  const [environment, setEnvironment] = useState<EnvironmentDescriptor | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState(() => newAttemptId());
  const [opening, setOpening] = useState(() => pairsAutomatically(initialCode));

  useEffect(() => {
    if (!opening || !initialCode) return;
    let active = true;
    void pairWithCode({ code: initialCode, label, attemptId }).then((result) => {
      if (!active) return;
      if (result.ok) { location.replace(pairedDestination(location)); return; }
      setOpening(false);
      setError(result.error);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetch("/.well-known/openmausbot/environment")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: EnvironmentDescriptor | null) => setEnvironment(d))
      .catch(() => setEnvironment(null));
    void readSessionState().then(setSession);
  }, []);

  const connected = isConnected(session);
  const cloudHome = environment?.capabilities.cloudHome === true;

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await pairWithCode({ code, label, attemptId });
    setBusy(false);
    if (result.ok) {
      location.replace(pairedDestination(location));
      return;
    }
    setError(result.error);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-6 text-ink">
      <div className="absolute left-3 top-12 max-w-[280px]"><DesktopWorkspaceSwitcher /></div>
      <div className="w-full max-w-[420px]">
        {opening ? (
          <p role="status" className="text-[20px] font-semibold">{cloudHome ? "Opening My Cloud…" : `Connecting to ${environment?.label ?? "this OpenMausBot"}…`}</p>
        ) : <>
        <h1 className="text-[20px] font-semibold">{cloudHome ? "My Cloud" : `Connect to ${environment?.label ?? "this OpenMausBot"}`}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">
          {environment && !cloudHome ? `Version ${environment.version} on ${environment.platform}. ` : ""}
          {pairIntro({ cloudHome })}
        </p>
        {reasonWorthShowing(reason) && !connected ? <p className="mt-3 text-[13px] text-ink-secondary">{reasonWorthShowing(reason)}</p> : null}
        {error && cloudHome && initialCode ? <p className="mt-3 text-[13px] text-ink-secondary">This link has expired or was already used. In the OpenMausBot app on your computer, open Settings → MausBot Cloud and choose Open My Cloud.</p> : null}
        </>}
        {opening ? null : connected ? (
          <p className="mt-4 text-[13.5px]">
            This browser is already connected.{" "}
            <a href={pairedDestination(location)} className="text-accent underline">
              Open the app
            </a>
          </p>
        ) : (
          <form onSubmit={submitCode}>
            <label className={fieldLabel} htmlFor="pair-code">
              Pairing code
            </label>
            <input
              id="pair-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setAttemptId(newAttemptId());
              }}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              className={`${input} font-mono text-[15px] tracking-[0.12em]`}
            />
            <label className={fieldLabel} htmlFor="pair-label">
              This device
            </label>
            <input id="pair-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} className={input} />
            {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
            <button type="submit" disabled={busy || code.replace(/[^a-z0-9]/gi, "").length < 12} className={button}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
