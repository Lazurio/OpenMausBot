import { describe, expect, it } from "vitest";
import { PLACES, placeLabelKey, placeOffered, toolPlace } from "./place";
import { toolSurfaceKind } from "../../shared/tool-surface";

describe("where a bot works", () => {
  it("offers this computer and the browser on a desktop or self-hosted server, and only the browser on an OMB Cloud home", () => {
    for (const config of [null, undefined, {}, { cloudHome: false }]) {
      expect(PLACES.filter((place) => placeOffered(place, config))).toEqual(["local", "browser"]);
    }
    expect(PLACES.filter((place) => placeOffered(place, { cloudHome: true }))).toEqual(["browser"]);
  });

  it("names places with one label key each", () => {
    expect(placeLabelKey("local")).toBe("place.local");
    expect(placeLabelKey("browser")).toBe("place.browser");
  });

  it("gives computer tools this computer, and other tools, browser tools included, nothing", () => {
    expect(toolPlace("browser_navigate")).toBeNull();
    expect(toolPlace("mcp__browser__browser_click")).toBeNull();
    expect(toolPlace("mcp__computer__screenshot")).toBe("local");
    expect(toolPlace("click")).toBe("local");
    for (const name of ["Bash", "Read", "list_bots", "recall", "propose_routine", "mcp__agents__ask_bot"]) {
      expect(toolPlace(name), name).toBeNull();
    }
  });

  it("classifies tool names without guessing computer for unrelated tools", () => {
    expect(toolSurfaceKind("browser_navigate")).toBe("browser");
    expect(toolSurfaceKind("browser__snapshot")).toBe("browser");
    expect(toolSurfaceKind("computer__click")).toBe("computer");
    expect(toolSurfaceKind("hotkey")).toBe("computer");
    expect(toolSurfaceKind("Bash")).toBeNull();
    expect(toolSurfaceKind("mcp__agents__list_bots")).toBeNull();
  });
});
