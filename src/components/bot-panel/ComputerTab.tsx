import { Folder, Globe, Smartphone } from "lucide-react";

import { writeBrowserPanelView, type BrowserPanelView } from "@/lib/lazurio-browser-panel";
import { t } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { useStore, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { useBrowserWords } from "../LazurioBrowser";
import type { PageId } from "./page-registry";
import { Card, NavRow } from "./rows";

export function useOpenBrowserPanel(bot: Pick<Bot, "id">) {
  const { dispatch } = useStore();
  return (view: BrowserPanelView = "browser") => {
    writeBrowserPanelView(bot.id, view);
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "toggleComputer", open: true });
  };
}

export function ComputerTab({ bot, onOpen }: { bot: Bot; onOpen: (page: PageId) => void }) {
  const { capabilities } = useDesktopCapabilities();
  const openPanel = useOpenBrowserPanel(bot);
  const words = useBrowserWords();
  const home = capabilities.host?.homeDir;
  const android = Boolean(window.ogb?.androidDevice);

  return (
    <div data-panel-tabpanel="computer">
      <Card label={t("botPanel.onThisComputer")} anchor="on-computer">
        <NavRow
          data-panel-page="folder"
          icon={Folder}
          title={t("computer.files.folder")}
          hint={bot.cwd ? shortPath(bot.cwd, home) : t("computer.files.privateFolder", { name: bot.name })}
          onClick={() => onOpen("folder")}
        />
        <NavRow
          data-panel-row="browser"
          icon={Globe}
          title={words.browser}
          drill={false}
          onClick={() => openPanel("browser")}
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
    </div>
  );
}
