import { describe, expect, it } from "vitest";

import { surfaceLabel, surfacePrompt, type MountedSurfaces } from "./surface.ts";

describe("surfaceLabel", () => {
  it("names the two places a bot can work: this host and the Environment browser", () => {
    expect(surfaceLabel("local")).toBe("this computer");
    expect(surfaceLabel("browser")).toBe("the Environment browser");
  });
});

describe("surfacePrompt", () => {
  it("names the computer when its tools are mounted, and leaves web pages to the Environment browser", () => {
    const text = surfacePrompt({ computer: "local" });
    expect(text).toMatch(/Desktop apps you use on screen are on this computer/);
    expect(text).toMatch(/say in one short sentence where you are working/);
    expect(text).toMatch(/tell them it is on this computer/);
    expect(text).toMatch(/you work in them in the Environment browser/);
  });

  it("explains that no computer tools are mounted, and carries the note", () => {
    expect(surfacePrompt({ computer: null })).toContain("No computer tools are mounted this turn");
    expect(surfacePrompt({ computer: null }, { note: " NOTE." })).toBe(" NOTE.");
    expect(surfacePrompt({ computer: "local" }, { note: " NOTE." }).endsWith(" NOTE.")).toBe(true);
  });

  it("requires observed results on the actual computer tools", () => {
    const text = surfacePrompt({ computer: "local" });
    expect(text).toContain("verify its result before claiming success");
    expect(text).toContain("Announcing an action is not performing it");
    expect(text).toContain("never act on a different computer.");
    expect(text).toContain("Do not substitute the provider's own desktop");
  });

  it("never offers a computer to choose, a place to pin or a browser of MausBot's own", () => {
    const mounts: MountedSurfaces[] = [{ computer: "local" }, { computer: null }];
    for (const mounted of mounts) {
      const text = surfacePrompt(mounted);
      expect(text, JSON.stringify(mounted)).not.toMatch(/select_computer|Local VM|cloud computer|pinned|Works on|built-in browser|Browser tab/);
    }
  });

  it("tells a Cloud home's bots that the user's own computer is out of reach, and changes nothing elsewhere", () => {
    const mounts: MountedSurfaces[] = [{ computer: "local" }, { computer: null }];
    for (const mounted of mounts) {
      const text = surfacePrompt(mounted, { cloudHome: true });
      expect(text).not.toMatch(/user's host/);
      expect(surfacePrompt(mounted, { cloudHome: false })).toBe(surfacePrompt(mounted));
    }
    expect(surfacePrompt({ computer: "local" }, { cloudHome: true })).toContain("the user's own computer cannot be reached from here");
  });
});
