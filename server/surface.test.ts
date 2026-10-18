import { describe, expect, it } from "vitest";

import { surfaceLabel, surfacePrompt, type MountedSurfaces } from "./surface.ts";

describe("surfaceLabel", () => {
  it("names the two places a bot can work: this host and the built-in browser", () => {
    expect(surfaceLabel("local")).toBe("this computer");
    expect(surfaceLabel("browser")).toBe("the built-in browser");
  });
});

describe("surfacePrompt", () => {
  it("names both surfaces and splits the work when both are mounted", () => {
    const text = surfacePrompt({ computer: "local", browser: true });
    expect(text).toMatch(/Two surfaces are mounted/);
    expect(text).toMatch(/Web tasks → the built-in browser/);
    expect(text).toMatch(/Desktop apps, files and shell → this computer tools/);
    expect(text).toMatch(/Pick one surface for a task and stay on it/);
    expect(text).toMatch(/say which surface — the Browser tab or this computer/);
  });

  it("names only the computer when it is the only surface", () => {
    const text = surfacePrompt({ computer: "local", browser: false });
    expect(text).toMatch(/happens on this computer, web pages included/);
    expect(text).toMatch(/no separate built-in browser/);
    expect(text).toMatch(/say in one short sentence where you are working/);
    expect(text).toMatch(/tell them it is on this computer/);
    expect(text).not.toMatch(/Two surfaces/);
  });

  it("names only the browser tab when it is the only surface", () => {
    const text = surfacePrompt({ computer: null, browser: true });
    expect(text).toMatch(/happens in the built-in browser tab/);
    expect(text).toMatch(/there is no desktop screen this turn/);
    expect(text).toMatch(/Browser tab of the Computer panel/);
    expect(text).toMatch(/say in one short sentence where you are working/);
  });

  it("explains unavailable tools and carries the note", () => {
    expect(surfacePrompt({ computer: null, browser: false })).toContain("No computer or built-in browser tools are mounted");
    expect(surfacePrompt({ computer: null, browser: false }, { note: " NOTE." })).toBe(" NOTE.");
    const withBrowser = surfacePrompt({ computer: null, browser: true }, { note: " NOTE." });
    expect(withBrowser).toMatch(/^ Everything you do on screen happens in the built-in browser tab/);
    expect(withBrowser.endsWith(" NOTE.")).toBe(true);
  });

  it.each(["local", "browser"] as const)("requires observed results on the actual %s tools", (place) => {
    const text = surfacePrompt({ computer: place === "browser" ? null : place, browser: place === "browser" });
    expect(text).toContain("verify its result before claiming success");
    expect(text).toContain("Announcing an action is not performing it");
    expect(text).toContain("never act on a different computer.");
    expect(text).toContain("use OpenMausBot's mounted browser/computer tools first");
    expect(text).toContain("Do not substitute the provider's own desktop");
  });

  it("never offers a computer to choose or a place to pin", () => {
    const mounts: MountedSurfaces[] = [
      { computer: "local", browser: false }, { computer: null, browser: true }, { computer: "local", browser: true }, { computer: null, browser: false },
    ];
    for (const mounted of mounts) {
      const text = surfacePrompt(mounted);
      expect(text, JSON.stringify(mounted)).not.toMatch(/select_computer|Local VM|cloud computer|pinned|Works on/);
    }
  });

  it("does not instruct use of a selected browser when no surface is mounted", () => {
    expect(surfacePrompt({ computer: null, browser: false })).not.toContain("For online research");
    expect(surfacePrompt({ computer: null, browser: true })).toContain("For online research");
  });

  it("tells a Cloud home's bots that the user's own computer is out of reach, and changes nothing elsewhere", () => {
    const mounts: MountedSurfaces[] = [{ computer: null, browser: true }, { computer: null, browser: false }];
    for (const mounted of mounts) {
      const text = surfacePrompt(mounted, { cloudHome: true });
      expect(text).not.toMatch(/user's host/);
      if (mounted.browser) {
        expect(text).toContain("the built-in browser is a separate browser, and the user's own computer cannot be reached from here");
      }
      expect(surfacePrompt(mounted, { cloudHome: false })).toBe(surfacePrompt(mounted));
    }
    expect(surfacePrompt({ computer: null, browser: true })).toContain("this computer is the user's host and the built-in browser is a separate browser");
  });
});
