import { useEffect, useRef, useState } from "react";
import { api, ApiError, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { openExternalLink } from "@/lib/app-links";
import { engineSignedIn } from "@/lib/product-events";
import { CodexMark } from "./ProviderIcons";

export interface DeviceSignInStatus {
  phase: "waiting" | "succeeded" | "failed" | "expired" | "cancelled";
  flowId: string | null;
  authorizationUrl: string | null;
  userCode?: string;
  expiresAt: string | null;
  message?: string;
}


export function deviceFlowUnavailable(cause: unknown): boolean {
  return cause instanceof ApiError && [401, 403, 404, 410].includes(cause.status);
}

}

export function chatgptPlanLink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/authorize" &&
      !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}

const chatgptButton = "flex w-full items-center justify-center gap-2 rounded-lg border border-black/20 bg-white px-3 py-2 text-[13px] font-semibold text-black hover:opacity-85 disabled:opacity-50";


  if (auth.phase !== "waiting") {
    return <p role="status" className={auth.phase === "succeeded" ? "text-[12px] text-success" : "text-[12px] text-ink-secondary"}>{label}</p>;
  }


  return (
    <div className="space-y-2 rounded-lg border border-hairline/50 bg-app p-3">
      <a href={link} target="_blank" rel="noopener noreferrer" onClick={(event) => {
        if (window.ogb?.openExternal) { event.preventDefault(); void openExternalLink(link); }
      }} className={browserPkce ? chatgptButton : "flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white hover:brightness-110"}>
        {browserPkce && <CodexMark size={16} className="fill-current" />}
        {t(browserPkce ? "engineSetup.chatgpt.start" : copy.open)} <ExternalLink size={13} />
      </a>
      <p role="status" className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
        <Loader2 size={12} className="animate-spin" /> {t("engineSetup.device.waiting")}
      </p>
      {auth.expiresAt && Number.isFinite(Date.parse(auth.expiresAt)) && (
      )}
    </div>
  );
}

/** `autoStart` begins at once; `onDone` hears the outcome so an account list can close the panel. */
  instanceId: string;
  autoStart?: boolean;
  onDone?: (signedIn: boolean) => void;
}) {
  const { refreshInstances, refreshModels } = useStore();
  const [auth, setAuth] = useState<DeviceSignInStatus | null>(null);
  const [busy, setBusy] = useState(autoStart);
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/auth`;

  // The sign-in already succeeded: a failed catalog refresh must not read as a failed sign-in.
  const refresh = async () => {
    try { await refreshInstances(); } catch {}
    try { await refreshModels(instanceId); } catch {}
    onDone?.(true);
  };

  useEffect(() => {
    if (busy || auth?.phase !== "waiting" || !auth.flowId) return;
    const controller = new AbortController();
    const remaining = auth.expiresAt ? Date.parse(auth.expiresAt) - Date.now() : Number.NaN;
    const expiryTimer = Number.isFinite(remaining)
      ? window.setTimeout(() => { controller.abort(); setAuth(endedFlow("expired")); setError(null); }, Math.max(0, remaining))
      : null;
    const timer = window.setTimeout(() => {
      void api(`${base}/status?flowId=${encodeURIComponent(auth.flowId!)}`, { signal: controller.signal })
        .then(async ({ auth: next }: { auth: DeviceSignInStatus }) => {
          if (controller.signal.aborted) return;
          setAuth(next);
          setError(null);
          if (next.phase === "succeeded") await refresh();
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          if (deviceFlowUnavailable(cause)) {
            setError(null);
            return;
          }
          setError(cause instanceof Error ? cause.message : failed);
          setAuth({ ...auth });
        });
    }, 2000);
    return () => {
      window.clearTimeout(timer);
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
      controller.abort();
    };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/start`, { method: "POST" });
      setAuth(next);
      if (next.phase === "succeeded") await refresh();
        const link = chatgptPlanLink(next.authorizationUrl);
        if (link) await openExternalLink(link);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failed);
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!auth?.flowId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/cancel`, { method: "POST", body: JSON.stringify({ flowId: auth.flowId }) });
      setAuth({ phase: "cancelled", flowId: null, authorizationUrl: null, expiresAt: null });
      onDone?.(false);
    } catch (cause) {
      else setError(cause instanceof Error ? cause.message : failed);
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    void start();
  }, [autoStart]);

    : auth || error ? t("engineSetup.device.tryAgain")

  return (
      {auth?.phase === "waiting" ? (
        <button type="button" disabled={busy} onClick={() => void cancel()} className="w-full rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-50">
          {busy ? t("engineSetup.device.cancelling") : t("engineSetup.device.cancel")}
        </button>
      ) : auth?.phase !== "succeeded" && (
        <button type="button" disabled={busy} onClick={() => void start()} className={browserPkce ? chatgptButton : "flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50"}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : browserPkce ? <CodexMark size={16} className="fill-current" /> : <LogIn size={14} />}
          {startLabel}
        </button>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
