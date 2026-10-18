import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { localDesktopPage } from "./onboarding/WelcomeGate";

// Lazurio overlay (DEV-6673 M3): the MausBot Cloud offer to keep routines running elsewhere is removed.
export type SchedulePlace = { kind: "cloud" } | { kind: "server" } | { kind: "local" };

export function schedulePlace({ cloudHome, local }: { cloudHome: boolean; local: boolean }): SchedulePlace {
  if (cloudHome) return { kind: "cloud" };
  return local ? { kind: "local" } : { kind: "server" };
}

export function RoutineScheduleNote() {
  const { state } = useStore();
  const local = localDesktopPage() && window.ogb?.remoteClient?.active !== true;
  const place = schedulePlace({ cloudHome: state.config?.cloudHome === true, local });
  return <p data-routine-schedule-note={place.kind} className="text-[11px] leading-relaxed text-ink-secondary">
    {place.kind === "cloud" ? t("routines.scheduleNote.cloud") : place.kind === "server" ? t("routines.scheduleNote.server") : t("routines.scheduleNote.local")}
  </p>;
}
