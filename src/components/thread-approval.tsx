import { useState, type ComponentProps, type ReactNode } from "react";

import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import { CommandAllowlistDialog } from "./CommandAllowlistDialog";

export type ApprovalChoice = ComponentProps<typeof ApprovalModeSelector>;

/** One conversation's approval level as every control offers it (the composer and the bot panel), with the command
 * allowlist dialog it can open. A remote client gets none. */
export function useThreadApproval(bot: Bot | undefined): { choice: ApprovalChoice | undefined; dialogs: ReactNode } {
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const [allowlist, setAllowlist] = useState<{ botId: string; botName: string; threadId: string } | null>(null);
  const engine = bot ? state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId) : undefined;
  const onSelect = (mode: ApprovalMode) => {
    if (!bot || mode === approvalModeFor(bot)) return;
    dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { approvalMode: mode } });
  };
  const choice: ApprovalChoice | undefined = bot && engine && !remoteClient ? {
    approvalMode: bot.approvalMode,
    autoApprove: bot.autoApprove,
    providerName: engine.displayName,
    driverKind: engine.driverKind,
    onSelect,
    busy: Boolean(bot.busy),
    onManageCommandAllowlist: ownerOrAdmin === true ? () => setAllowlist({ botId: bot.id, botName: bot.name, threadId: bot.threadId }) : undefined,
  } : undefined;
  const dialogs = (
    <>
      {allowlist && <CommandAllowlistDialog key={`${allowlist.botId}:${allowlist.threadId}`} {...allowlist} onClose={() => setAllowlist(null)} />}
    </>
  );
  return { choice, dialogs };
}
