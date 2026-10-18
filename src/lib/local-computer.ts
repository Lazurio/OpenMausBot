import { t } from "./i18n";
import type { Bot, InstanceInfo } from "@/state/store";

export function instanceSupportsLocalComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const capabilities = instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  )?.capabilities;
  return capabilities?.localComputerMcp === true || capabilities?.computerMcp === true;
}

export function localComputerSelectable({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (capabilities.localComputer.available) return true;
  return capabilities.host.platform === "darwin" || capabilities.host.platform === "win32";
}

/** Why a bot can't use this computer, in words for the person: what to do, never the parts underneath. */
export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): string | null {
  if (!providerSupportsLocal) return t("computer.problem.localAiCannot");
  if (capabilities.localComputer.available) return null;
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") return t("computer.problem.localWaylandBlocked");
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") return t("computer.problem.localWaylandDesktop");
    if (!capabilities.localComputer.enabled) return t("computer.problem.localTurnOn");
    return capabilities.localComputer.message ?? t("computer.problem.localNotReady");
  }
  if (capabilities.host.label === "Browser") return t("computer.problem.localNeedsApp");
  if (capabilities.host.platform === "win32") return t("computer.problem.localWindows");
  return t("computer.problem.localMac");
}
