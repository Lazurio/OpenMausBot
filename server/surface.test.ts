import { describe, expect, it } from "vitest";

import { SURFACE_PROMPT } from "./surface.ts";

describe("SURFACE_PROMPT", () => {
  it("says that no computer tools are mounted", () => {
    expect(SURFACE_PROMPT).toContain("No computer tools are mounted this turn");
    expect(SURFACE_PROMPT).toContain("do not claim to have opened or checked it");
  });

  it("never offers a computer to choose, a place to pin or a browser of MausBot's own", () => {
    expect(SURFACE_PROMPT).not.toMatch(/select_computer|Local VM|cloud computer|pinned|Works on|built-in browser|Browser tab|computer server's tools/);
  });
});
