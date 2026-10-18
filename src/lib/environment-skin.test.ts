// Lazurio: the Environment skin (LAZURIO.md "The Environment skin"). On a
// Lazurio Environment with the Environment theme the shell marks
// <html data-lazurio-environment-theme>: before this app's module runs, or on
// a browser's first visit once it read its document, announcing
// `lazurio-theme`. There the Environment skin is the default, a browser that
// ran the app before moves to it once, and the picker offers it; a skin picked
// after that sticks. Without the mark, a Platform that marks only its tokens
// included, nothing changes.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkinPicker } from "@/components/SkinPicker";
import { applySkin, DEFAULT_SKIN_CHOICE, offeredSkins, readSkin, resolveSkin } from "./skins";

const DEFAULT_SKIN = resolveSkin(DEFAULT_SKIN_CHOICE, false);

const MOVED = "omb-skin-environment-moved";

let stored: Map<string, string>;
let root: { dataset: Record<string, string | undefined> };
let listeners: Map<string, (() => void)[]>;

/** One page load: the document as the shell left it (`tokens`: a Platform
 * before the Environment theme, which marks only its tokens), over this
 * browser's storage, which carries over from the previous load. */
function load({ shell, tokens = false }: { shell: boolean; tokens?: boolean }) {
  root = {
    dataset: shell ? { lazurioTheme: "light", lazurioEnvironmentTheme: "lazurio" } : tokens ? { lazurioTheme: "light" } : {},
  };
  listeners = new Map();
  vi.stubGlobal("document", {
    documentElement: root,
    addEventListener: (type: string, listener: () => void) =>
      void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  vi.stubGlobal("window", {});
}

/** What main.tsx does before the first paint; returns the skin it stamped. */
function boot(): string | undefined {
  applySkin(readSkin());
  return root.dataset.skin;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Environment skin", () => {
  it("leaves upstream's default where the shell did not mark the document", () => {
    stored = new Map();
    load({ shell: false });
    expect(boot()).toBe(DEFAULT_SKIN);
    expect(stored.has(MOVED)).toBe(false);
  });

  it("changes nothing where the shell marks only its tokens", () => {
    stored = new Map();
    load({ shell: false, tokens: true });
    expect(boot()).toBe(DEFAULT_SKIN);
    expect(offeredSkins().map((skin) => skin.id)).not.toContain("environment");
    expect(stored.has(MOVED)).toBe(false);
  });

  it("moves a browser on its first visit once the shell announces the theme", () => {
    stored = new Map();
    load({ shell: false });
    expect(boot()).toBe(DEFAULT_SKIN);
    // The shell read its document: the mark, then the announcement.
    root.dataset.lazurioTheme = "light";
    root.dataset.lazurioEnvironmentTheme = "ocean";
    for (const listener of listeners.get("lazurio-theme") ?? []) listener();
    expect(root.dataset.skin).toBe("environment");
    expect(stored.get(MOVED)).toBe("1");
    // A later announcement (another theme) moves nobody again.
    applySkin("lagoon");
    for (const listener of listeners.get("lazurio-theme") ?? []) listener();
    expect(root.dataset.skin).toBe("lagoon");
  });

  it("is the default on a Lazurio Environment", () => {
    stored = new Map();
    load({ shell: true });
    expect(boot()).toBe("environment");
    expect(stored.get("omb-skin")).toBe("environment");
  });

  it("moves a browser once, then keeps the skin picked after that", () => {
    // main.tsx stored the skin on every boot, so this may be a pick or the default.
    stored = new Map([["omb-skin", "daylight"]]);
    load({ shell: true });
    expect(boot()).toBe("environment");
    expect(stored.get(MOVED)).toBe("1");

    load({ shell: true });
    expect(boot()).toBe("environment");

    applySkin("lagoon");
    load({ shell: true });
    expect(boot()).toBe("lagoon");
  });

  it("keeps a stored Environment skin while the shell is missing", () => {
    // Without the shell the block falls back to Midnight's values; when the
    // shell is back, the Environment theme is too.
    stored = new Map([["omb-skin", "environment"], [MOVED, "1"]]);
    load({ shell: false });
    expect(boot()).toBe("environment");
    load({ shell: true });
    expect(boot()).toBe("environment");
  });

  it("does not move a browser that cannot remember the move", () => {
    stored = new Map([["omb-skin", "daylight"]]);
    load({ shell: true });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(readSkin()).toBe("daylight");
  });

  it("decides the default from the mark alone where there is no storage", () => {
    stored = new Map();
    load({ shell: true });
    vi.stubGlobal("localStorage", undefined);
    expect(readSkin()).toBe("environment");
    load({ shell: false });
    vi.stubGlobal("localStorage", undefined);
    expect(readSkin()).toBe(DEFAULT_SKIN);
  });

  it("is offered in the picker, first, only on a Lazurio Environment", () => {
    stored = new Map();
    load({ shell: true });
    expect(offeredSkins()[0]?.id).toBe("environment");
    boot();
    const picker = renderToStaticMarkup(createElement(SkinPicker));
    expect(picker.indexOf(">Environment<")).toBeGreaterThan(-1);
    expect(picker.indexOf(">Environment<")).toBeLessThan(picker.indexOf(">Midnight<"));
    // the active card, with its live miniature in the Environment's colours
    const active = picker.slice(picker.indexOf('aria-pressed="true"'));
    expect(active.slice(0, active.indexOf("</button>"))).toMatch(/data-skin="environment"[^]*>Environment</);

    load({ shell: false });
    expect(offeredSkins().map((skin) => skin.id)).not.toContain("environment");
    boot();
    const upstream = renderToStaticMarkup(createElement(SkinPicker));
    expect(upstream).not.toContain(">Environment<");
    expect(upstream).toContain(">Midnight<");
  });
});
