import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ setters: [] as Array<ReturnType<typeof vi.fn>>, states: {} as Record<number, unknown> }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: (value: unknown) => {
    const index = fixture.setters.length;
    const setter = vi.fn(); fixture.setters.push(setter);
    return [index in fixture.states ? fixture.states[index] : value, setter];
  } };
});
const answerSignIn = vi.fn();
const here = { value: true };
vi.mock("@/lib/sign-in", () => ({ answerSignIn: (...args: unknown[]) => answerSignIn(...args), signInHostIsHere: () => here.value }));

import { SignInBanner, SignInRequestCard } from "./SignInRequestCard";

const card = (signIn: Record<string, unknown> = {}): Message => ({
  id: "card-1",
  role: "bot",
  kind: "signin",
  at: 1,
  text: "Pepper needs you to sign in to example.com.",
  signIn: { url: "https://example.com/login", site: "example.com", place: "browser", reason: "The report is behind a login.", ...signIn } as Message["signIn"],
});
const props = (signIn?: Record<string, unknown>) => ({ botId: "pepper", botName: "Pepper", threadId: "thread-1", message: card(signIn) });
const view = (signIn?: Record<string, unknown>) => renderToStaticMarkup(createElement(SignInRequestCard, props(signIn)));

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
const elements = (node: ReactNode): Node[] => {
  if (!isValidElement(node)) return [];
  const element = node as Node;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
};
const tree = (signIn?: Record<string, unknown>) => {
  let root!: ReactNode;
  function Capture() { root = SignInRequestCard(props(signIn)); return root; }
  renderToStaticMarkup(createElement(Capture));
  const top = elements(root);
  return [...top, ...top.flatMap((node) => elements((node.props as { footer?: ReactNode }).footer))];
};
const button = (nodes: Node[], label: string) => nodes.find((node) => node.type === "button" && Children.toArray(node.props.children).includes(label))!;
const settle = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };

beforeEach(() => {
  vi.stubGlobal("window", {});
  answerSignIn.mockReset().mockResolvedValue(undefined);
  fixture.setters = []; fixture.states = {}; here.value = true;
});

describe("SignInRequestCard while it waits", () => {
  it("leads with the site, quotes the bot's reason, says where to sign in, and offers Done and Cancel", () => {
    const html = view();
    expect(html).toContain("Sign in needed");
    expect(html).toMatch(/data-testid="sign-in-site"[^>]*>example\.com</);
    expect(html).toContain("“The report is behind a login.”");
    expect(html).toContain("— Pepper");
    expect(html).toContain("Sign in in the Environment browser, through the link Pepper sent.");
    for (const label of ["Done", "Cancel"]) expect(html).toContain(label);
    expect(html).not.toMatch(/>Open</);
    expect(html).not.toContain("built-in browser");
    expect(html).toContain("OpenMausBot never sees it.");
    expect(html).not.toContain("<input");
  });

  it.each([
    ["local", "on this computer, in the browser Pepper is using"],
  ])("names the place for %s", (place, words) => {
    expect(view({ place })).toContain(words);
  });

  it("says the host computer, not this one, where this computer is somewhere else", () => {
    here.value = false;
    expect(view({ place: "local" })).toContain("the computer OpenMausBot runs on");
  });

  it("offers no Open into a browser of its own for the browser place", () => {
    expect(button(tree(), "Open")).toBeUndefined();
  });

  it("Open on this computer explains where to sign in instead", () => {
    button(tree({ place: "local" }), "Open").props.onClick!();
    // explained (the second useState) turns on
    expect(fixture.setters[1]).toHaveBeenCalledWith(true);
    fixture.setters = []; fixture.states = { 1: true };
    const explained = view({ place: "local" });
    expect(explained).toContain("Go to the browser window Pepper is using on this computer and sign in there.");
    expect(explained).not.toContain("Browser tab");
  });

  it.each(["done", "cancel"] as const)("%s settles this card", async (choice) => {
    button(tree(), choice === "done" ? "Done" : "Cancel").props.onClick!();
    await settle();
    expect(answerSignIn).toHaveBeenCalledExactlyOnceWith({ botId: "pepper", threadId: "thread-1", messageId: "card-1", place: "browser" }, choice);
  });
});

describe("SignInRequestCard once settled", () => {
  it("folds into one line that names the site once done and resumed", () => {
    const html = view({ done: true, resumed: true });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain("Signed in to example.com");
    expect(html).toContain("Pepper is continuing");
    expect(html).not.toMatch(/>Done<|>Open</);
  });

  it("says a declined sign-in was declined", () => {
    expect(view({ cancelled: true, resumed: true })).toContain("Sign-in to example.com declined");
  });

  it("keeps a retry with the same answer when resuming failed", async () => {
    const nodes = tree({ done: true, resumed: false, error: "The bot could not be resumed." });
    expect(view({ done: true, resumed: false, error: "The bot could not be resumed." })).toContain("The bot could not be resumed.");
    const retry = nodes.flatMap((node) => elements((node.props as { action?: ReactNode }).action)).find((node) => node.type === "button")!;
    retry.props.onClick!();
    await settle();
    expect(answerSignIn).toHaveBeenCalledWith(expect.objectContaining({ messageId: "card-1" }), "done");
  });

  it("stops offering anything once superseded", () => {
    const html = view({ superseded: true });
    expect(html).toContain("Superseded by a newer request");
    expect(html).not.toMatch(/>Done<|>Open<|>Cancel</);
  });
});

describe("SignInBanner", () => {
  const help = { botId: "pepper", threadId: "thread-1", messageId: "card-1", site: "example.com", place: "browser" as const };
  const banner = () => {
    let root!: ReactNode;
    function Capture() { root = SignInBanner({ help, askerName: "Pepper" }); return root; }
    return { html: renderToStaticMarkup(createElement(Capture)), nodes: elements(root) };
  };

  it("names the asking bot and the site, and answers the card", async () => {
    const { html, nodes } = banner();
    expect(html).toContain("<b>Pepper</b> needs you to sign in to example.com");
    expect(html).toContain("Sign in in the Environment browser, through the link Pepper sent.");
    button(nodes, "Done").props.onClick!();
    await settle();
    expect(answerSignIn).toHaveBeenCalledExactlyOnceWith(help, "done");
  });
});
