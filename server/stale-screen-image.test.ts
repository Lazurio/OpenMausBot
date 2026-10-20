// Lazurio overlay (DEV-6673): an older screen message is read without its image.
import { describe, expect, it } from "vitest";

import { withoutScreenImage } from "./stale-screen-image.ts";

describe("a stale screen image", () => {
  it("leaves a screen message without its png and mime, and every other message as it is", () => {
    expect(withoutScreenImage({ id: "s1", kind: "screen", png: "iVBOR", mime: "image/png", at: 1 })).toEqual({ id: "s1", kind: "screen", at: 1 });
    expect(withoutScreenImage({ id: "s2", kind: "screen", mime: "image/png" })).toEqual({ id: "s2", kind: "screen" });
    const text = { id: "t1", kind: "text", text: "hi", attachments: [{ kind: "image", path: "a.png", mime: "image/png" }] };
    expect(withoutScreenImage(text)).toBe(text);
  });
});
