import { Folder, Globe, KeyRound, Monitor, Smartphone, Table } from "lucide-react";

import { writeComputerPanelView, type ComputerPanelView } from "@/lib/computer-panel-view";
import { t } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { screenFramePreview } from "../ScreenFrame";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import type { PageId } from "./page-registry";
import { Card, LinkRow, NavRow } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;

export function useOpenComputer(bot: Pick<Bot, "id">) {
  const { dispatch } = useStore();
  return (view: ComputerPanelView = "computer") => {
    writeComputerPanelView(bot.id, view);
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "toggleComputer", open: true });
  };
}

export function ComputerTab({ bot, derived, onOpen }: { bot: Bot; derived: Derived; onOpen: (page: PageId) => void }) {
  const { capabilities } = useDesktopCapabilities();
  const openComputer = useOpenComputer(bot);
  const { browserEnabled } = derived;

  const screen = [...bot.messages].reverse().find((message) => message.kind === "screen" && (message.hasImage || message.png));
  const screenSrc = screen ? screenFramePreview({ threadId: bot.threadId, messageId: screen.id }, screen.mime).src : null;
  const home = capabilities.host?.homeDir;
  const android = Boolean(window.ogb?.androidDevice);

  return (
    <div data-panel-tabpanel="computer">
      <div className="relative mt-[18px] flex aspect-[16/10] max-w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-[14px] border border-ink/[0.06] bg-inset">
        {screenSrc ? (
          <img src={screenSrc} alt={t("computer.screenOf", { name: bot.name })} className="absolute inset-0 size-full object-cover" />
        ) : (
          <>
            <span className="opacity-55"><BotAvatar bot={bot} size={52} animated={false} /></span>
            <span className="text-[12.5px] text-ink-secondary">{t(bot.busy ? "botPanel.screen.working" : "botPanel.screen.idle")}</span>
          </>
        )}
        <button
          type="button"
          data-panel-action="open-computer"
          onClick={() => openComputer()}
          className="absolute bottom-2.5 right-2.5 flex h-7 items-center gap-1.5 rounded-full border border-ink/10 bg-panel/80 px-2.5 text-[12px] text-ink backdrop-blur-sm hover:bg-panel"
        >
          <Monitor size={13} aria-hidden="true" />
          {t("botPanel.openFullView")}
        </button>
      </div>
      <div className="mt-[7px] text-center text-[12px] text-ink-tertiary">{t("computer.screenOf", { name: bot.name })}</div>

      <Card label={t("botPanel.onThisComputer")} anchor="on-computer">
        <NavRow
          data-panel-page="browser"
          icon={Globe}
          title={t("place.browser")}
          hint={t(browserEnabled ? "botPanel.browserOn" : "botPanel.browserOff")}
          onClick={() => onOpen("browser")}
        />
        <NavRow
          data-panel-page="logins"
          icon={KeyRound}
          title={t("botSettings.simple.logins")}
          hint={t("botPanel.loginsHint", { name: bot.name })}
          onClick={() => onOpen("browser")}
        />
        <NavRow
          data-panel-page="folder"
          icon={Folder}
          title={t("computer.files.folder")}
          hint={bot.cwd ? shortPath(bot.cwd, home) : t("computer.files.privateFolder", { name: bot.name })}
          onClick={() => onOpen("folder")}
        />
        <NavRow
          data-panel-row="data"
          icon={Table}
          title={t("computer.tab.data")}
          hint={t("botPanel.dataHint")}
          drill={false}
          onClick={() => openComputer("data")}
        />
        {android && (
          <NavRow
            data-panel-page="android"
            icon={Smartphone}
            title={t("botPanel.page.android")}
            hint={t("botPanel.androidHint")}
            onClick={() => onOpen("android")}
          />
        )}
      </Card>

      <Card>
        <LinkRow data-panel-link="computer" icon={Monitor} onClick={() => openComputer()}>{t("botPanel.openFullComputer")}</LinkRow>
      </Card>
      <p className="mt-2 text-center text-[12px] text-ink-tertiary">{t("botPanel.fullViewHint")}</p>
    </div>
  );
}
