import { Globe } from "lucide-react";

import { writeBrowserPanelView, type BrowserPanelView } from "@/lib/lazurio-browser-panel";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { useBrowserWords } from "../LazurioBrowser";
import type { SimplePageId } from "./page-registry";
import { Card, NavRow } from "./rows";

export function useOpenBrowserPanel(bot: Pick<Bot, "id">) {
  const { dispatch } = useStore();
  return (view: BrowserPanelView = "browser") => {
    writeBrowserPanelView(bot.id, view);
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "toggleComputer", open: true });
  };
}

export function ComputerTab({ bot }: { bot: Bot; onOpen: (page: SimplePageId) => void }) {
  const openPanel = useOpenBrowserPanel(bot);
  const words = useBrowserWords();

  return (
    <div data-panel-tabpanel="computer">
      <Card label={t("botPanel.onThisComputer")} anchor="on-computer">
        <NavRow
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
