import type { LocaleKey } from "@/locales";
import type { BotSettingsSection } from "@/state/store";

export const PANEL_TABS = ["details", "library", "computer"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export const TAB_LABEL: Record<PanelTab, LocaleKey> = {
  details: "botPanel.tab.details",
  library: "botPanel.tab.library",
  computer: "botPanel.tab.computer",
};

export type PageId =
  | "settings"
  | "setup" | "model" | "instructions" | "approvals" | "always" | "routines"
  | "memory" | "skills"
  | "folder" | "android"
  | "voice" | "blurb" | "team" | "chiefteams" | "webhooks" | "visibility" | "slack"
  | "overview" | "prompt" | "history";

/** The pages Simple mode draws; a link to any other page lands where its section does. */
export const SIMPLE_PAGES = ["settings", "routines", "memory", "skills", "folder"] as const satisfies readonly PageId[];
export type SimplePageId = (typeof SIMPLE_PAGES)[number];

export function isSimplePage(page: PageId): page is SimplePageId {
  return (SIMPLE_PAGES as readonly PageId[]).includes(page);
}

export interface PageMeta {
  title: LocaleKey;
  home: PanelTab;
  intro?: LocaleKey;
}

export const PAGES: Record<PageId, PageMeta> = {
  settings: { title: "botPanel.page.settings", home: "details" },
  setup: { title: "botSetup.ideas", home: "details" },
  model: { title: "model.simple.model", home: "details" },
  instructions: { title: "botSettings.simple.instructions", home: "details" },
  approvals: { title: "botPanel.page.approvals", home: "details" },
  routines: { title: "botSettings.simple.routines", home: "details" },
  memory: { title: "botPanel.memoryRow", home: "library", intro: "botPanel.memory.intro" },
  skills: { title: "botSettings.simple.skills", home: "library", intro: "botSettings.simple.skillsHint" },
  folder: { title: "computer.files.folder", home: "library", intro: "botPanel.folder.intro" },
  android: { title: "botPanel.page.android", home: "computer" },
  voice: { title: "botPanel.page.voice", home: "details" },
  blurb: { title: "botPanel.page.blurb", home: "details" },
  team: { title: "botPanel.page.team", home: "details" },
  chiefteams: { title: "botPanel.page.chiefTeams", home: "details" },
  webhooks: { title: "botPanel.page.webhooks", home: "details" },
  always: { title: "botPanel.page.always", home: "details" },
  visibility: { title: "botSettings.visibility.title", home: "details" },
  slack: { title: "botPanel.page.slack", home: "details" },
  overview: { title: "botPanel.page.overview", home: "details" },
  prompt: { title: "botPanel.page.prompt", home: "details" },
  history: { title: "botPanel.page.history", home: "details" },
};

export const PAGE_IDS = Object.keys(PAGES) as PageId[];

export interface PanelTarget {
  tab: PanelTab;
  page?: SimplePageId;
  anchor?: string;
  /** Opens the Instructions editor in place on the Bot settings page. */
  editInstructions?: boolean;
}

const SECTION_TARGET: Record<BotSettingsSection, PanelTarget> = {
  overview: { tab: "details" },
  identity: { tab: "details" },
  slack: { tab: "details" },
  soul: { tab: "details", page: "settings", anchor: "instructions", editInstructions: true },
  skills: { tab: "library", page: "skills" },
  memory: { tab: "library", page: "memory" },
  routines: { tab: "details", page: "routines" },
  access: { tab: "computer" },
  model: { tab: "details", anchor: "model" },
  permissions: { tab: "details", page: "settings", anchor: "approval" },
  voice: { tab: "details" },
  visibility: { tab: "details" },
  history: { tab: "details" },
  usage: { tab: "details" },
};

export function sectionTarget(section: BotSettingsSection): PanelTarget {
  return SECTION_TARGET[section];
}
