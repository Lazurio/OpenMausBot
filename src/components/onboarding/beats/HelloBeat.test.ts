import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
import { HelloBeat } from "./HelloBeat";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() };
function render(hosted?: boolean) {
  let tree: ReactNode = null;
  function Capture() {
    tree = HelloBeat({ ...props, ...(hosted === undefined ? {} : { hosted }) });
    return tree;
  }
  return { html: renderToStaticMarkup(createElement(Capture)), tree };
}

beforeEach(() => {
  store.api.mockReset();
  props.onNext.mockReset();
  setLocale("en");
});

describe("the greeting beat", () => {
  it("asks a hosted workspace for nothing and saves nothing", () => {
    const { html, tree } = render(true);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("let you know when big things ship");
    expect(html).toContain("shared OpenMausBot");
    expect(html).toContain("nothing to install");
    const primary = nodes(tree).find((node) => typeof node.type === "function" && node.props.onClick);
    primary!.props.onClick!();
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(store.api).not.toHaveBeenCalled();
  });

  it("asks a desktop for nothing either: no name and e-mail form (Lazurio, DEV-6673 M3)", () => {
    for (const { html, tree } of [render(), render(false)]) {
      expect(html).not.toContain("<input");
      expect(html).not.toContain("you@example.com");
      expect(html).not.toContain("let you know when big things ship");
      expect(html).not.toContain("their own computer");
      const primary = nodes(tree).find((node) => typeof node.type === "function" && node.props.onClick);
      primary!.props.onClick!();
    }
    expect(props.onNext).toHaveBeenCalledTimes(2);
    expect(store.api).not.toHaveBeenCalled();
  });
});
