import { useState, useSyncExternalStore } from "react";
import { ExternalLink, LogIn, RefreshCw } from "lucide-react";
import { useStore, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";

export interface LazurioSignIn {
  settingsUrl: string | null;
  czech: boolean;
}

const SHELL_SCHEMA = "lazurio.shell.v1";
const UNREAD: LazurioSignIn = Object.freeze({ settingsUrl: null, czech: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

  try {
  } catch {
    return null;
  }
}

  if (!isRecord(shell) || shell.schema !== SHELL_SCHEMA) return UNREAD;
  const czech = shell.locale !== "en";
  const current = Array.isArray(shell.environments)
    : undefined;
}

/** The shell's script marks its tokens on <html> as soon as it runs, ahead of this app's module
 * (interface v1 `declares.theme`); outside Lazurio the script does not load and nothing is marked. */
function onLazurioEnvironment(): boolean {
  return typeof document !== "undefined" && document.documentElement?.dataset?.lazurioTheme !== undefined;
}

let read: LazurioSignIn | undefined;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function loadLazurioSignIn(): Promise<void> {
  if (!onLazurioEnvironment()) return Promise.resolve();
    .catch(() => null)
    .then((shell: unknown) => {
      for (const listener of listeners) listener();
    });
  return reading;
}

export function forgetLazurioSignIn(): void {
  read = undefined;
  reading = null;
}

function currentLazurioSignIn(): LazurioSignIn | null {
  return onLazurioEnvironment() ? read ?? UNREAD : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void loadLazurioSignIn();
  return () => listeners.delete(listener);
}

/** Null outside Lazurio; on an Environment, where its agent accounts are connected. */
export function useLazurioSignIn(): LazurioSignIn | null {
  return useSyncExternalStore(subscribe, currentLazurioSignIn, currentLazurioSignIn);
}

const words = (czech: boolean) => czech
  ? {
      title: (name: string) => `Připojte účet pro ${name}`,
      body: "Účet agenta se připojuje v Nastavení Prostředí. Potom zvolte Zkontrolovat znovu.",
      open: "Otevřít Nastavení Prostředí",
      check: "Zkontrolovat znovu",
      checking: "Kontroluji…",
      stillSignedOut: "Účet zatím není připojený.",
      failed: "Kontrola se nepovedla. Zkuste to znovu.",
      headline: (name: string) => `Účet pro ${name} zatím není připojený. Připojte ho v Nastavení Prostředí a zprávu pošlete znovu.`,
    }
  : {
      title: (name: string) => `Connect an account for ${name}`,
      body: "Agent accounts are connected in the Environment settings. Then choose Check again.",
      open: "Open Environment settings",
      check: "Check again",
      checking: "Checking…",
      stillSignedOut: "The account is not connected yet.",
      failed: "The check failed. Try again.",
      headline: (name: string) => `${name} isn't connected to an account yet. Connect it in the Environment settings, then send your message again.`,
    };

}

export function LazurioEngineSignIn({ signIn, instance, className, unframed = false }: {
  signIn: LazurioSignIn;
  instance: InstanceInfo;
  className?: string;
  unframed?: boolean;
}) {
  const { refreshInstances } = useStore();
  const [status, setStatus] = useState<"idle" | "checking" | "checked" | "failed">("idle");
  const copy = words(signIn.czech);
  const check = async () => {
    setStatus("checking");
    try {
      await refreshInstances({ reportErrors: true });
      setStatus("checked");
    } catch {
      setStatus("failed");
    }
  };
  return (
    <div data-lazurio-engine-sign-in className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          <LogIn size={14} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{copy.title(instance.displayName)}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{copy.body}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {signIn.settingsUrl && (
          <a
            href={signIn.settingsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white hover:brightness-110"
          >
            {copy.open}
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        )}
        <button
          type="button"
          disabled={status === "checking"}
          onClick={() => void check()}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] font-medium text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
        >
          <RefreshCw size={13} aria-hidden="true" className={cn(status === "checking" && "animate-spin")} />
          {status === "checking" ? copy.checking : copy.check}
        </button>
      </div>
      {status === "checked" && <p role="status" className="mt-1.5 text-[12px] text-ink-secondary">{copy.stillSignedOut}</p>}
      {status === "failed" && <p role="alert" className="mt-1.5 text-[12px] text-danger">{copy.failed}</p>}
    </div>
  );
}