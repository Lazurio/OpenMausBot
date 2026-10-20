// Lazurio overlay (DEV-6673): the right panel Prohlížeč, its views, the server's strip as the panel reads it, and
// what opens it on a tab (a link to the bot's tab, a sign-in in it); and that upstream's Computer panel is gone.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { lazurioAccountSite } from "../../shared/lazurio-browser";
import {
  browserPanelViews,
  parseBotBrowserStrip,
  readBrowserPanelView,
  resolveBrowserPanelView,
  signInToReveal,
  viewTabOfLink,
} from "./lazurio-browser-panel";

const VIEW = "https://browser.vm-01.example.lazurio.io";
const TAB_A = "A".repeat(32);
const TAB_B = "B".repeat(32);
const strip = parseBotBrowserStrip({
  available: true,
  viewOrigin: VIEW,
  current: TAB_A,
})!;

describe("the panel's views", () => {
  it("are the browser and the files in Simple mode, with routines and data only in Advanced", () => {
    expect(browserPanelViews(false)).toEqual(["browser", "files"]);
    expect(browserPanelViews(true)).toEqual(["browser", "files", "routines", "data"]);
  });

  it("show Data in Simple mode only while a data result the person opened is in view", () => {
    expect(browserPanelViews(false, "data")).toEqual(["browser", "files", "data"]);
    expect(resolveBrowserPanelView("routines", false)).toBe("browser");
    expect(resolveBrowserPanelView("files", false)).toBe("files");
  });

  it("start on the browser, and keep no view of upstream's Computer panel", () => {
    expect(readBrowserPanelView("bot", { getItem: () => null })).toBe("browser");
    expect(readBrowserPanelView("bot", { getItem: () => "computer" })).toBe("browser");
    expect(readBrowserPanelView("bot", { getItem: () => "files" })).toBe("files");
    for (const advanced of [false, true]) expect(browserPanelViews(advanced)).not.toContain("computer");
  });
});

describe("the bot's strip from the server", () => {
  it("keeps each tab with its view on the declared origin", () => {
  });

  it("drops a tab whose view is on another origin or names another tab, and reads no browser plainly", () => {
    expect(parseBotBrowserStrip({
      available: true,
      viewOrigin: VIEW,
      tabs: [
        { tabId: TAB_A, view: `https://browser.other.example.lazurio.io/t/${TAB_A}` },
        { tabId: TAB_A, view: `${VIEW}/t/${TAB_B}` },
        { tabId: TAB_B, view: `https://example.com/t/${TAB_B}` },
      ],
      current: TAB_A,
    expect(parseBotBrowserStrip({ available: false })).toEqual({ available: false });
    expect(parseBotBrowserStrip("nonsense")).toBeNull();
  });
});

describe("a link in the chat", () => {
  it("opens the panel on a tab of this Environment's view", () => {
  });

  it("stays a link of the person's own browser for another Environment's view, any other page, or no browser", () => {
    expect(viewTabOfLink(`https://browser.other.example.lazurio.io/t/${TAB_A}`, strip)).toBeNull();
    expect(viewTabOfLink(`${VIEW}/`, strip)).toBeNull();
    expect(viewTabOfLink("https://dashboard.lazurio.io/", strip)).toBeNull();
    expect(viewTabOfLink(`${VIEW}/t/${TAB_A}`, { available: false })).toBeNull();
    expect(viewTabOfLink(`${VIEW}/t/${TAB_A}`, undefined)).toBeNull();
  });
});

describe("a sign-in the bot asks for", () => {
  const card = (signIn: Record<string, unknown>, id = "m1") => ({
    id,
    kind: "signin",
    signIn: { url: "https://example.com/login", site: "example.com", place: "browser" as const, tab: TAB_A, ...signIn },
  });

  it("opens the panel on the bot's tab, the newest card waiting for the person", () => {
  });

  it("opens nothing for a settled card, one without the bot's tab, on the host computer, or with a Lazurio account", () => {
    for (const signIn of [{ done: true }, { cancelled: true }, { superseded: true }, { stopped: true }, { tab: undefined }, { place: "local" },
      { url: "https://auth.lazurio.io/sign-in", site: "auth.lazurio.io" }]) {
    }
  });

  it("counts every page at lazurio.io as a Lazurio account, and nothing else", () => {
    expect(lazurioAccountSite("https://lazurio.io/")).toBe(true);
    expect(lazurioAccountSite("https://dashboard.lazurio.io/x")).toBe(true);
    expect(lazurioAccountSite("https://launchpad.vm-01.example.lazurio.io./")).toBe(true);
    expect(lazurioAccountSite("https://notlazurio.io/")).toBe(false);
    expect(lazurioAccountSite("https://lazurio.io.example.com/")).toBe(false);
    expect(lazurioAccountSite("not a url")).toBe(false);
  });
});

describe("upstream's Computer panel", () => {
  const root = join(import.meta.dirname, "..", "..");
  const source = (file: string) => readFileSync(join(root, file), "utf8");

  it("is gone, with its own live view of the screen", () => {
    for (const file of ["src/components/ComputerPanel.tsx", "src/components/remote-desktop-panel.tsx", "src/components/LocalScreenPreview.tsx",
      "src/components/LinuxLocalControl.tsx", "src/components/computer-panel-tabs.ts", "src/lib/computer-panel-view.ts"]) {
      expect(existsSync(join(root, file)), file).toBe(false);
    }
  });

  it("is replaced in the app by the browser panel, whose button the bot's header shows in every mode", () => {
    expect(source("src/App.tsx")).toContain("<LazurioBrowserPanel ");
    expect(source("src/App.tsx")).not.toMatch(/ComputerPanel|RemoteDesktopPanel/);
    expect(source("src/components/lazy-screens.tsx")).not.toMatch(/ComputerPanel|RemoteDesktopPanel/);
    // On a phone the header's ⋯ menu opens the same panel.
    expect(source("src/components/ChatView.tsx")).toMatch(/^ {10}\{!phoneMenu && <LazurioBrowserButton open=\{state\.computerOpen\} round=\{simpleHead\} \/>\}$/m);
    expect(source("src/components/ChatMoreMenu.tsx")).toContain('onSelect: () => dispatch({ type: "toggleComputer" })');
  });
});