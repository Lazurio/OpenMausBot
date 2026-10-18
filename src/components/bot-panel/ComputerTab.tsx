
import { writeComputerPanelView, type ComputerPanelView } from "@/lib/computer-panel-view";
import { t } from "@/lib/i18n";
import { BotAvatar } from "../Avatar";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import type { BotPatch, useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { useStore, type Bot } from "@/state/store";
import { useBrowserWords } from "../LazurioBrowser";
import type { SimplePageId } from "./page-registry";
import { Card, NavRow } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;
interface PlaceOption {
  value: PlaceChoice;
  label: string;
  hint?: string;
  disabled?: boolean;
}


export function useOpenComputer(bot: Pick<Bot, "id">) {
  const { dispatch } = useStore();
  return (view: ComputerPanelView = "computer") => {
    writeComputerPanelView(bot.id, view);
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "toggleComputer", open: true });
  };
}

  const { capabilities } = useDesktopCapabilities();
  const { browserEnabled } = derived;
  const openPanel = useOpenBrowserPanel(bot);
  const words = useBrowserWords();

  return (
    <div data-panel-tabpanel="computer">
        className="group relative mt-2.5 flex aspect-[16/10] w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-composer ring-1 ring-inset ring-ink/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
      >
        {screenSrc ? (
          <img src={screenSrc} alt="" className="absolute inset-0 size-full object-cover" />
        ) : bot.busy ? (
          <>
            <span className="opacity-55"><BotAvatar bot={bot} size={52} animated={false} /></span>
            <span className="max-w-[80%] text-center text-[13px] text-ink-secondary">{t("botPanel.screen.working")}</span>
          </>
        ) : (
          <>
            <span className="opacity-60"><BotAvatar bot={bot} size={44} state="sleeping" animated={false} /></span>
            <span className="max-w-[80%] text-center text-[13px] font-medium text-ink">{t("botPanel.screen.resting")}</span>
          </>
        )}
        <span
          aria-hidden="true"
          className="absolute bottom-2.5 right-2.5 flex h-7 items-center gap-1.5 rounded-full border border-ink/10 bg-panel/80 px-2.5 text-[12px] text-ink opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100"
        >
          <Monitor size={13} aria-hidden="true" />
          {t("place.action.watch")}
        </span>
      </button>
      <div className="mt-3 text-center text-[13px] text-ink-tertiary">{screenOf}</div>

        <NavRow
        />
      <Card label={t("botPanel.onThisComputer")} anchor="on-computer">
        <NavRow
          data-panel-page="browser"
          icon={KeyRound}
          title={t("settings.sites.title")}
          value={signedIn ?? undefined}
          onClick={() => onOpen("browser")}
          data-panel-row="browser"
          icon={Globe}
          title={words.browser}
          drill={false}
          onClick={() => openPanel("browser")}
        />
      </Card>
    </div>
  );
}
