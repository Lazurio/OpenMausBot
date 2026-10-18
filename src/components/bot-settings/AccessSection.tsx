import { browserUnavailableReason } from "@/lib/feature-flags";
import { useState } from "react";
import { FolderOpen } from "lucide-react";

import { useStore, type Bot } from "@/state/store";
import { useBotEditor } from "./BotEditorContext";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { Switch } from "../SettingsPrimitives";
import { ProposalStatus } from "./ProposalStatus";
import { ToolSelectionCard } from "./ToolSelectionCard";
import { useCloudPlan } from "../ProIntroduction";
import { xResearchAction } from "@/lib/cloud-plan";
import { inputCls } from "./field";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

/**
 * Claude keeps sessions per project folder, so the server pins each task's folder on its first turn. PATCHed directly,
 * not via updateBot: the server validates the path, and a rejected folder must not stick in local state.
 */
export function useWorkingFolder(bot: Pick<Bot, "id" | "cwd">) {
  const { request: api } = useBotEditor();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(bot.cwd);
    if (chosen) void save(chosen);
  };
  return { draft, setDraft, error, saving, canPick, save, pick };
}

export function WorkingFolder({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const { draft, setDraft, error, saving, canPick, save, pick } = useWorkingFolder(bot);
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const pinned = task?.cwd;
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("botAccess.folder.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("botAccess.folder.description")}</div>
      <ProposalStatus bot={bot} kind="chief" />
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[13px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">{t("botAccess.folder.private")}</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> {t("botAccess.folder.choose")}
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              {t("botAccess.folder.clear")}
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save((draft ?? bot.cwd ?? "").trim() || null);
          }}
        >
          <input
            className={cn(inputCls, "font-mono text-[13px]")}
            placeholder={t("botAccess.folder.placeholder")}
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            {t("botAccess.folder.save")}
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          {t("botAccess.folder.pinned", { path: pinned ? shortPath(pinned, home) : t("botAccess.folder.home") })}
        </div>
      )}
    </div>
  );
}

export function cloudPreferenceShown(bot: Pick<Bot, "computer">, config: { cloudHome?: boolean } | null | undefined): boolean {
  return (!bot.computer || bot.computer === "cloud") && !config?.cloudHome;
}

/**
 * A bot's own VPS server. PATCHed directly, not via updateBot: the server refuses
 * a move while the bot's computer still lives on the old host.
 */
export function VpsAliasField({ bot }: { bot: Bot }) {
  const { request: api } = useBotEditor();
  const { state } = useStore();
  const defaultAlias = state.config?.vps?.sshAlias ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the old server could not be reached: the move went ahead, and this says what may be left there.
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (alias: string | null) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api<{ notice?: string }>(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ vpsAlias: alias }) });
      setNotice(saved?.notice ?? null);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const value = draft ?? bot.vpsAlias ?? "";
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[13px] text-ink">{t("botAccess.cloud.server")}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">
        {defaultAlias
          ? t("botAccess.cloud.serverDefault", { alias: defaultAlias })
          : t("botAccess.cloud.serverNoDefault")}
      </div>
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save(value.trim() || null);
        }}
      >
        <input
          className={cn(inputCls, "font-mono text-[13px]")}
          placeholder={defaultAlias || t("botAccess.cloud.serverPlaceholder")}
          value={value}
          aria-label={t("botAccess.cloud.server")}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          disabled={saving || draft === null}
          className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {t("botAccess.cloud.serverSave")}
        </button>
      </form>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {notice && <div role="status" className="mt-2 break-words text-[12px] text-ink-secondary">{notice}</div>}
    </div>
  );
}

export function CloudPreference({ bot, patch }: { bot: Bot; patch: ReturnType<typeof useBotSettingsDerived>["patch"] }) {
  const { state } = useStore();
  const { draft } = useBotEditor();
  if (!cloudPreferenceShown(bot, state.config)) return null;
  return (
    <>
      {!bot.computer && (
        <div className="mt-3 rounded-lg bg-inset px-3 py-2.5 text-[12px] leading-relaxed text-ink-secondary">
          <span className="font-medium text-ink">{t("botAccess.cloud.autoTitle")}</span>{" "}
          {t("botAccess.cloud.autoDescription")}
        </div>
      )}
      <CloudBackendPicker
        value={bot.cloudBackend ?? "box"}
        onChange={(backend) => patch({ cloudBackend: backend })}
      />
      {/* A saved bot only: a new bot starts on the default server, and new-bot defaults never name one. */}
      {bot.cloudBackend === "vps" && !draft && <VpsAliasField bot={bot} />}
      {!bot.computer && bot.cloudBackend === "vps" && (
        <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] text-ink">{t("botAccess.cloud.startVps")}</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">
              {t("botAccess.cloud.startVpsDescription")}
            </div>
          </div>
          <Switch
            checked={Boolean(bot.autoStartVps)}
            aria-label={t("botAccess.cloud.startVps")}
            onClick={() => patch({ autoStartVps: !bot.autoStartVps })}
          />
        </div>
      )}
    </>
  );
}

export type AccessPart = "worksOn" | "folder" | "apps" | "phone" | "xResearch" | "mcp" | "tools" | "browser" | "webhooks" | "always";
export type AccessPart = "folder" | "webhooks" | "always";

export function AccessSection({
  bot,
  derived,
  parts,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  parts?: readonly AccessPart[];
}) {
  const { draft } = useBotEditor();
  const {
    patch,
    canUseBrowser,
    desktopBrowser,
    browserBlockedOnWindows,
    browserFeature,
    browserAllowed,
    browserEnabled,
  } = derived;
  const browserInstallable = state.config?.browserEngine?.installable === true;
  const { state } = useStore();

  const webhooks = state.webhooks.filter((webhook) => webhook.botId === bot.id);
  const alwaysAllow = bot.alwaysAllow ?? [];
  const shows = (part: AccessPart) => !parts || parts.includes(part);

  return (
    <div className="flex flex-col gap-4">
      {shows("folder") && <WorkingFolder bot={bot} />}

      {shows("tools") && <ToolSelectionCard key={bot.id} bot={bot} engineKind={derived.engine?.driverKind} />}

      {shows("browser") && <div className="rounded-xl bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[15px] font-medium text-ink">{t("botAccess.browser.title")}</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!desktopBrowser
                ? browserBlockedOnWindows && !browserInstallable
                  ? t("botAccess.browser.windowsUnavailable")
                  : browserUnavailableReason(state.config)
                : !browserFeature
                  ? t("botAccess.browser.disabledInSettings")
                  : !canUseBrowser
                    ? t("botAccess.browser.modelUnsupported")
                    : bot.computer === "off"
                      ? t("botAccess.browser.off")
                      : browserEnabled
                        ? t("botAccess.browser.enabled")
                        : t("botAccess.browser.disabled")}
            </div>
            <ProposalStatus bot={bot} kind="owner" />
          </div>
          <Switch
            aria-label={t("botAccess.browser.allow")}
            onClick={() => patch({ browser: !browserAllowed })}
            className="disabled:cursor-not-allowed"
          />
        </div>
        {!draft && (
          <RecordStepsRow
            on={bot.recordBrowserSteps === true}
            myChrome={state.config?.browserEngine?.myChrome === true && (state.config?.browserProfiles ?? []).some((profile) => profile.id === bot.browserProfile && profile.browser === "chrome")}
            onChange={(recordBrowserSteps) => patch({ recordBrowserSteps })}
          />
        )}
      </div>}

      {!draft && shows("webhooks") && <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("botAccess.webhooks.title")}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">{t("botAccess.webhooks.description")}</div>
        <ProposalStatus bot={bot} kind="owner" />
        {webhooks.length === 0 ? (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">{t("botAccess.webhooks.empty")}</div>
        ) : (
          <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {webhooks.map((webhook) => (
              <div key={webhook.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{webhook.name}</span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    webhook.enabled ? "bg-accent/15 text-accent-text" : "bg-control text-ink-secondary",
                  )}
                >
                  {webhook.enabled ? t("botAccess.webhooks.active") : t("botAccess.webhooks.paused")}
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-ink-secondary">
                  {t("botAccess.webhooks.deliveries", { count: webhook.deliveryCount })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>}

      {!draft && shows("always") && <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("botAccess.always.title")}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">{t("botAccess.always.description")}</div>
        <ProposalStatus bot={bot} kind="owner" />
        {alwaysAllow.length === 0 ? (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">{t("botAccess.always.empty")}</div>
        ) : (
          <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {alwaysAllow.map((entry) => (
              <div key={entry} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{entry}</span>
                <button
                  type="button"
                  aria-label={t("botAccess.always.remove", { entry })}
                  onClick={() => patch({ alwaysAllow: alwaysAllow.filter((key) => key !== entry) })}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
                >
                  {t("botAccess.always.removeButton")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>}

    </div>
  );
}
