import { hasPriorRun } from "./prior-run";

export const SKIN_IDS = [
  "midnight",
  "atelier",
  "foundry",
  "lagoon",
  "graphite",
  "linen",
  "dusk",
  "daylight",
  "meadow",
  "pop",
  // Lazurio: the Environment theme (the end of this file).
  "environment",
  "halloween",
] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
  tagline: string;
};

export const SKINS: readonly Skin[] = [
  // Lazurio: first, because on an Environment it is the default and the way
  // back to the Environment theme; offered only there (offeredSkins below).
  { id: "environment", name: "Environment", tagline: "Follows this Environment's theme, like Chat and Apps." },
  { id: "midnight", name: "Midnight", tagline: "The original. Cool and dark." },
  { id: "atelier", name: "Atelier", tagline: "Daylight on paper, warm and quiet." },
  { id: "foundry", name: "Foundry", tagline: "Night shift. Dark, warm, lit in brass." },
  { id: "lagoon", name: "Lagoon", tagline: "Cool daylight. Porcelain and deep teal." },
  { id: "graphite", name: "Graphite", tagline: "Quiet charcoal and softened steel blue." },
  { id: "linen", name: "Linen", tagline: "Clean daylight with a restrained navy accent." },
  { id: "dusk", name: "Dusk", tagline: "Muted plum after dark, calm and low-key." },
  { id: "daylight", name: "Daylight", tagline: "Midnight in reverse. Near-white, ink-black bubbles." },
  { id: "meadow", name: "Meadow", tagline: "Fresh white with a calm green. The MausBot look." },
  { id: "pop", name: "Pop", tagline: "Cream paper, thick ink outlines, hard shadows. Chunky and cheerful." },
  { id: "halloween", name: "Halloween", tagline: "Plum after dark, lit in pumpkin orange. Bats optional." },
];

/** "system" follows the OS between the light and dark skins below; anything else pins one skin. */
export type SkinChoice = SkinId | "system";
export const THEME_SKINS = { light: "daylight", dark: "midnight" } as const satisfies Record<"light" | "dark", SkinId>;

export const DEFAULT_SKIN_CHOICE: SkinChoice = "system";
export const PRIOR_INSTALL_SKIN: SkinId = "midnight";

const KEY = "omb-skin";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function isSkinId(value: unknown): value is SkinId {
  return SKIN_IDS.includes(value as SkinId);
}

function isSkinChoice(value: unknown): value is SkinChoice {
  return value === "system" || isSkinId(value);
}

function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
  } catch {
    return true;
  }
}

export function resolveSkin(choice: SkinChoice, prefersDark = systemPrefersDark()): SkinId {
  if (choice !== "system") return choice;
  return prefersDark ? THEME_SKINS.dark : THEME_SKINS.light;
}

// With storage blocked the localStorage getter itself throws, and `typeof` alone doesn't shield it.
function getStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readSkinChoice(): SkinChoice {
  if (moveToEnvironmentSkin()) return ENVIRONMENT_SKIN;
  awaitEnvironmentTheme();
  try {
    const store = getStore();
    const stored = store?.getItem(KEY);
    if (isSkinChoice(stored)) return stored;
    return defaultSkinChoice(store);
  } catch {
    return environmentThemeDeclared() ? ENVIRONMENT_SKIN : PRIOR_INSTALL_SKIN;
  }
}

export function readSkin(): SkinId {
  return resolveSkin(readSkinChoice());
}

let followingSystem: { query: MediaQueryList; onChange: () => void } | null = null;
const listeners = new Set<() => void>();

export function subscribeSkin(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function paintSkin(id: SkinId): void {
  document.documentElement.dataset.skin = id;
  for (const listener of listeners) listener();
  // On Windows the caption buttons sit in a native overlay the main process paints, out of CSS's reach.
  try {
    void window.ogb?.applySkin?.(id)?.catch(() => undefined);
  } catch {
  }
}

function followSystem(follow: boolean): void {
  if (followingSystem && !follow) {
    followingSystem.query.removeEventListener("change", followingSystem.onChange);
    followingSystem = null;
  }
  if (!follow || followingSystem || typeof matchMedia !== "function") return;
  try {
    const query = matchMedia(DARK_QUERY);
    const onChange = () => paintSkin(resolveSkin("system", query.matches));
    query.addEventListener("change", onChange);
    followingSystem = { query, onChange };
  } catch {
  }
}

// ── Lazurio: the Environment skin (LAZURIO.md "The Environment skin") ──────
// A Lazurio Environment has one colour theme, which Chat, Apps and Automate
// follow (Lazurio decision 0208). The Environment's shell declares it on the
// document as the design system's tokens with their colour scheme, which the
// Environment skin's block in styles.css reads, and marks the root
// `data-lazurio-environment-theme` where it holds. A Platform before 0208
// marks only its tokens (`data-lazurio-theme`), without the theme's colour
// scheme, so that mark alone changes nothing here. The shell applies the
// theme its origin remembers as soon as it runs, from a script index.html
// loads ahead of this app's module, so on every visit but a browser's first
// the mark is in place before main.tsx reads the skin; on the first it comes
// once the shell read its document, announced as `lazurio-theme`. Where it
// is, the Environment skin is the default and the picker offers it;
// elsewhere nothing changes.
const ENVIRONMENT_SKIN: SkinId = "environment";

// main.tsx writes omb-skin on every boot, so a stored skin cannot tell a pick
// from the default. Every browser on an Environment therefore moves to the
// Environment skin once, and this key remembers that it did; a skin picked
// after that sticks.
const ENVIRONMENT_MOVE_KEY = "omb-skin-environment-moved";

function environmentThemeDeclared(): boolean {
  try {
    return typeof document !== "undefined" && document.documentElement.dataset.lazurioEnvironmentTheme !== undefined;
  } catch {
    return false;
  }
}

/** The skin a browser without a stored one starts on: the Environment skin
 * on an Environment, upstream's choice elsewhere. */
function defaultSkinChoice(store: Storage | undefined): SkinChoice {
  if (environmentThemeDeclared()) return ENVIRONMENT_SKIN;
  return hasPriorRun(store) ? PRIOR_INSTALL_SKIN : DEFAULT_SKIN_CHOICE;
}

/** True the first time a browser on an Environment reads its skin. A browser
 * that cannot remember the move keeps its stored skin rather than moving on
 * every boot. */
function moveToEnvironmentSkin(): boolean {
  if (!environmentThemeDeclared()) return false;
  try {
    const store = getStore();
    if (!store || store.getItem(ENVIRONMENT_MOVE_KEY) !== null) return false;
    store.setItem(ENVIRONMENT_MOVE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

// The documents a browser's first visit waits on: there the shell marks the
// document only once it read /.lazurio/shell.json, after main.tsx read the
// skin, and announces the theme as `lazurio-theme`. The move then happens on
// that announcement, once, as on any later load.
const awaited = new WeakSet<object>();

function awaitEnvironmentTheme(): void {
  try {
    if (typeof document === "undefined" || awaited.has(document) || environmentThemeDeclared()) return;
    document.addEventListener("lazurio-theme", () => {
      if (moveToEnvironmentSkin()) applySkin(ENVIRONMENT_SKIN);
    });
    awaited.add(document);
  } catch {
    /* a document without events */
  }
}

/** The skins the picker offers: the Environment skin only on an Environment. */
export function offeredSkins(): readonly Skin[] {
  return environmentThemeDeclared() ? SKINS : SKINS.filter((skin) => skin.id !== ENVIRONMENT_SKIN);
}

export function applySkinChoice(choice: SkinChoice): void {
  try {
    getStore()?.setItem(KEY, choice);
  } catch {
  }
  followSystem(choice === "system");
  paintSkin(resolveSkin(choice));
}

export function applySkin(id: SkinId): void {
  applySkinChoice(id);
}
