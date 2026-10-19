// LocalComputerAutoWarning remembers its bot, so a bot switch while it is up never applies the choice to the new bot.
import { useState } from "react";
import { Crown } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import type { ApprovalMode } from "../../../shared/approval-mode";
import { ApprovalModeSelector } from "../ApprovalModeSelector";
import { CommandAllowlistDialog } from "../CommandAllowlistDialog";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { Switch } from "../SettingsPrimitives";
import { ManagedTeamsSettings } from "./ManagedTeamsSettings";
import { ProposalStatus } from "./ProposalStatus";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";
import { useBotEditor } from "./BotEditorContext";

export type PermissionsPart = "chief" | "peers" | "approval";

export function PermissionsSection({
  bot,
  derived,
  parts,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  parts?: readonly PermissionsPart[];
}) {
  const { patch, engine, canCoordinate, approvalMode, sectionName, currentChief } = derived;
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const { draft } = useBotEditor();
  const [localAutoWarning, setLocalAutoWarning] = useState<string | null>(null);
  const [commandAllowlistTarget, setCommandAllowlistTarget] = useState<{ botId: string; botName: string } | null>(null);
  const shows = (part: PermissionsPart) => !parts || parts.includes(part);
  const applyFullEverywhere = () =>
    dispatch({ type: "updateBot", botId: bot.id, patch: { approvalMode: "full", applyToAllThreads: true } });
  const setApprovalMode = (mode: ApprovalMode) => {
    if (bot.busy || mode === approvalMode) return;
    if (mode === "full") {
      applyFullEverywhere();
      return;
    }
    if (mode === "auto") {
      setLocalAutoWarning(bot.id);
      return;
    }
    patch({ approvalMode: mode });
  };

  return (
    <div className="flex flex-col gap-4">
      {shows("chief") && <div
        className={cn(
          "rounded-xl border p-4",
          bot.chiefOfStaff ? "border-accent/40 bg-accent/10" : "border-hairline/40 bg-card",
        )}
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              bot.chiefOfStaff ? "bg-accent text-white" : "bg-control text-ink-secondary",
            )}
          >
            <Crown size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium text-ink">Chief of Staff</div>
            <div className="text-[11.5px] text-ink-secondary">One for {sectionName}</div>
          </div>
          <Switch
            checked={Boolean(bot.chiefOfStaff)}
            aria-label="Chief of Staff"
            disabled={!bot.chiefOfStaff && !canCoordinate}
            onClick={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
            title={!bot.chiefOfStaff && !canCoordinate ? "This model cannot contact other bots" : undefined}
            className="disabled:cursor-not-allowed"
          />
        </div>
        <div className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
          {bot.chiefOfStaff && !canCoordinate
            ? "This bot still holds the role, but its current provider cannot contact teammates. Choose a provider that supports bot coordination."
            : bot.chiefOfStaff
              ? `This is the primary contact for ${sectionName}. It can create and coordinate specialists in this team, then combine their work into one answer.`
              : !canCoordinate
                ? "Choose a provider that supports bot coordination."
                : currentChief
                  ? `Make this bot the ${sectionName} Chief and hand the role over from ${currentChief.name}.`
                  : `Make this bot the primary contact for the ${sectionName} team.`}
        </div>
        <ProposalStatus bot={bot} kind="chief" />
        {bot.chiefOfStaff && <ManagedTeamsSettings
          key={bot.id + JSON.stringify(bot.managedSections ?? [])}
          name={bot.name} ownTeam={bot.section?.trim() || ""}
          teams={["", ...(state.sections ?? []), ...[...state.bots, ...state.groups].map(member => member.section?.trim() || "")]}
          allowed={bot.managedSections ?? []}
          onSave={managedSections => patch({ managedSections, acknowledgePeerScope: true })}
        />}
        {bot.chiefOfStaff && <ProposalStatus bot={bot} kind="owner" />}
      </div>}

      {shows("peers") && <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
        <div>
          <div className="text-[15px] font-medium text-ink">Ask me before contacting other bots</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {bot.approvePeerComms
              ? "This bot will stop and ask before it reaches out to another bot."
              : "Let this bot talk to teammates on its own, without a confirmation step."}
          </div>
          <ProposalStatus bot={bot} kind="owner" />
        </div>
        <Switch
          checked={Boolean(bot.approvePeerComms)}
          aria-label="Ask me before contacting other bots"
          disabled={!bot.approvePeerComms && !canCoordinate}
          onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
          title={!bot.approvePeerComms && !canCoordinate ? "This model cannot contact other bots" : undefined}
          className="disabled:cursor-not-allowed"
        />
      </div>}

      {shows("approval") && <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Approval level</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {draft ? "Default for the new bot's threads, routines and delegated work." : "Default for new threads, routines and delegated work. Full access also applies at once to every existing thread. Use Refresh permissions on a thread to apply the current level to that conversation."}
        </div>
        <ProposalStatus bot={bot} kind="owner" />
        <div className="mt-3">
          <ApprovalModeSelector
            approvalMode={bot.approvalMode}
            autoApprove={bot.autoApprove}
            providerName={engine?.displayName ?? bot.name}
            driverKind={engine?.driverKind ?? ""}
            onSelect={setApprovalMode}
            menuDirection="down"
            wide
            disabled={Boolean(bot.busy)}
            onManageCommandAllowlist={!draft && ownerOrAdmin === true ? () => setCommandAllowlistTarget({ botId: bot.id, botName: bot.name }) : undefined}
          />
        </div>
        {!draft && approvalMode === "full" && <button
          type="button" disabled={Boolean(bot.busy)}
          className="mt-3 text-[13px] text-accent hover:underline disabled:opacity-40"
          onClick={applyFullEverywhere}
        >Apply Full access to all threads</button>}
        {!draft && ownerOrAdmin === true && <button
          type="button"
          className="mt-3 block text-[13px] text-accent hover:underline"
          onClick={() => setCommandAllowlistTarget({ botId: bot.id, botName: bot.name })}
        >{t("commandAllowlist.manage")}</button>}
      </div>}

      {commandAllowlistTarget && <CommandAllowlistDialog
        key={`command-allowlist:${commandAllowlistTarget.botId}`}
        {...commandAllowlistTarget}
        onClose={() => setCommandAllowlistTarget(null)}
      />}
      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          const target = localAutoWarning;
          setLocalAutoWarning(null);
          if (!target) return;
          dispatch({ type: "updateBot", botId: target, patch: { approvalMode: "auto", acknowledgeLocalAuto: true } });
        }}
      />
    </div>
  );
}
