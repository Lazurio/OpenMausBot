// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

vi.mock("@/components/EngineLibrary", () => ({ engineReady: () => true }));
const ph = vi.hoisted(() => {
  const ph = {
    loads: 0,
    calls: [] as unknown[][],
    module: () => {
      ph.loads += 1;
      return { default: {
        init: () => {}, has_opted_out_capturing: () => false, opt_in_capturing: () => {}, opt_out_capturing: () => {},
        register: () => {}, unregister: () => {},
        capture: (event: string, props?: unknown) => void ph.calls.push(["capture", event, props]),
        identify: (id: string, props?: unknown) => void ph.calls.push(["identify", id, props]),
      } };
    },
  };
  return ph;
});
vi.mock("posthog-js", () => ph.module());
import { CloudProPopup, cloudProCloudPageView, cloudProPopupView, otherDialogOpen, useOtherDialogOpen, type CloudProPopupView } from "./CloudProPopup";
import { Spotlight } from "./onboarding/Spotlight";

const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 16);
const plans = [
  { tier: "starter", label: "Starter", amount: 1500, trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 7 },
];
const TRIAL_OFFER: CloudOffer = { plans, recommended: "pro", creditUsd: 5, refundDays: 14 };
const PLAIN_OFFER: CloudOffer = { plans: plans.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro" };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const onPlan = (tier: string | undefined, extra: Partial<CloudAccountState> = {}): CloudAccountState =>
  ({ ...free, entitlement: { plan: "pro", ...(tier ? { tier } : {}), status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const running = { state: "active" as const, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none" as const };

beforeEach(() => setLocale("en"));


describe("what the popup offers, by plan", () => {
  it("waits while the plan or the offer loads, and for a later launch when the Cloud can't be reached", () => {
    for (const account of [null, { status: "signed-out", message: "restoring" }, { status: "connecting" }] as const) {
      expect(cloudProPopupView(account as CloudAccountState | null, TRIAL_OFFER), JSON.stringify(account)).toBe("loading");
    }
    expect(cloudProPopupView({ status: "signed-out" }, undefined)).toBe("loading");
    expect(cloudProPopupView({ status: "signed-out" }, null)).toBe("offline");
    expect(cloudProPopupView({ status: "unavailable", lastPlan: { tier: "pro", active: true } }, TRIAL_OFFER)).toBe("offline");
  });

  it("no plan: the in-app checkout, with the trial, prices, credit and money-back from the live offer", () => {
    const signedOut = cloudProPopupView({ status: "signed-out" }, TRIAL_OFFER) as CloudProPopupView;
    expect(signedOut).toMatchObject({ primary: { via: "add-cloud", label: "Start free trial" }, seePlans: true, plan: "none", signedIn: false, email: null,
      badge: "Free for 7 days", price: "Then from $15/month + tax. Cancel any time.", moneyBack: "14-day money-back on every plan.", current: null });
    expect(signedOut.points).toContain("$5 of Claude credit to start");
    const costlier = { ...PLAIN_OFFER, plans: PLAIN_OFFER.plans.map(plan => ({ ...plan, amount: plan.amount + 1000 })) };
    expect(cloudProPopupView(free, costlier)).toMatchObject({ primary: { via: "add-cloud", label: "Upgrade to Cloud Pro" },
      plan: "none", signedIn: true, email: "person@example.test", badge: null, price: "MausBot Cloud plans from $25/month + tax.", moneyBack: null });
    expect((cloudProPopupView(free, costlier) as CloudProPopupView).points).toContain("Cloud desktops and voice included");
  });

  it("a plan: Manage plan in Settings → MausBot Cloud for every plan, no Compare plans, never a checkout, a price or the browser", () => {
    const cases: Array<[CloudAccountState, string, string, string | null]> = [
      [onPlan("personal"), "personal", "Manage plan", "Personal active · verified by MausBot Cloud"],
      [onPlan("pro", { trial: running }), "trial", "Manage plan", "Pro free trial · verified by MausBot Cloud"],
      [onPlan("pro"), "pro", "Manage plan", "Pro active · verified by MausBot Cloud"],
      [onPlan(undefined), "pro", "Manage plan", "Pro active · verified by MausBot Cloud"],
      [onPlan("max"), "max", "Manage plan", "Max active · verified by MausBot Cloud"],
      [onPlan("ultra"), "other", "Manage plan", "Cloud active · verified by MausBot Cloud"],
      [{ ...free, purchase: { state: "confirming" } }, "none", "Manage plan", "MausBot Cloud · payment received"],
      [{ ...free, entitlement: { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 3 } }, "none", "Manage plan", "Pro · not active right now"],
      [{ status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }, "unknown", "Manage plan", "Sign in again to use the Cloud on this computer. Your plan is not affected."],
      [{ status: "signed-out", message: "restore-removed" }, "none", "Manage plan", null],
    ];
    for (const [account, plan, label, current] of cases) {
      const view = cloudProPopupView(account, TRIAL_OFFER) as CloudProPopupView;
      expect(view, plan).toMatchObject({ primary: { via: "settings", label }, seePlans: false, plan, current, badge: null, price: null, moneyBack: null });
      expect(view.signedIn, plan).toBe(account.status === "connected");
    }
  });

  it("My Cloud's page: a plan manages in that page's Settings, never the plan page in the browser; a plan being checked waits; no plan read offers none", () => {
    const cases: Array<[CloudPlanSnapshot, string, boolean, string]> = [
      [{ status: "paid", tier: "personal" }, "personal", true, "Personal active · verified by MausBot Cloud"],
      [{ status: "paid", tier: "pro", trial: running }, "trial", true, "Pro free trial · verified by MausBot Cloud"],
      [{ status: "paid" }, "pro", true, "Pro active · verified by MausBot Cloud"],
      [{ status: "paid", tier: "ultra" }, "other", true, "Cloud active · verified by MausBot Cloud"],
      [{ status: "attention", tier: "max" }, "none", true, "Max · not active right now"],
      [{ status: "attention" }, "none", true, "MausBot Cloud · not active right now"],
      [{ status: "signin", tier: "pro" }, "unknown", false, "Sign in again to use the Cloud on this computer. Your plan is not affected."],
    ];
    for (const [snapshot, plan, signedIn, current] of cases) {
      expect(cloudProCloudPageView(snapshot), plan).toMatchObject({ primary: { via: "settings", label: "Manage plan" }, seePlans: false, plan, signedIn,
        email: null, current, badge: null, price: null, moneyBack: null });
    }
    expect(cloudProCloudPageView(null)).toBe("loading");
    expect(cloudProCloudPageView({ status: "checking", tier: "pro" })).toBe("offline");
    expect(cloudProCloudPageView({ status: "none" })).toBe("offline");
  });

});

describe("the popup as a dialog", () => {
  let root: Root, container: HTMLElement, opener: HTMLButtonElement;
  const view = cloudProPopupView({ status: "signed-out" }, TRIAL_OFFER) as CloudProPopupView;
  const actions = { onPrimary: vi.fn(), onSeePlans: vi.fn(), onNotNow: vi.fn(), onClose: vi.fn() };
  const show = (props: Partial<Parameters<typeof CloudProPopup>[0]> = {}) => flushSync(() => root.render(createElement(CloudProPopup, { view, ...actions, ...props })));
  const press = (key: string, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    return event;
  };
  const focused = () => (document.activeElement as HTMLElement).textContent || document.activeElement!.getAttribute("aria-label");
  beforeEach(() => {
    vi.clearAllMocks();
    opener = document.body.appendChild(document.createElement("button"));
    opener.textContent = "composer"; opener.focus();
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });
  afterEach(() => { root.unmount(); document.body.replaceChildren(); });

  it("is a labelled modal dialog that takes focus at its title, keeps Tab inside and gives focus back when it goes", () => {
    show();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("MausBot Cloud Pro");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent).toContain("Then from $15/month + tax.");
    expect(document.activeElement!.id).toBe("cloud-pro-popup-title");
    const order: Array<string | null> = [];
    for (let i = 0; i < 5; i++) { expect(press("Tab").defaultPrevented).toBe(true); order.push(focused()); }
    expect(order).toEqual(["Start free trial", "Compare plans", "Not now", "Close", "Start free trial"]);
    press("Tab", true); expect(focused()).toBe("Close");
    flushSync(() => root.render(null));
    expect(document.activeElement).toBe(opener);
  });

  it("Escape, the X and a press outside close it; a press inside does not; each button does its own thing", () => {
    show();
    const escape = press("Escape");
    expect(escape.defaultPrevented).toBe(true); expect(actions.onClose).toHaveBeenCalledTimes(1);
    const backdrop = container.firstElementChild!, dialog = container.querySelector('[role="dialog"]')!;
    dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(actions.onClose).toHaveBeenCalledTimes(1);
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(actions.onClose).toHaveBeenCalledTimes(2);
    const button = (name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name || item.getAttribute("aria-label") === name)!;
    button("Close").click(); expect(actions.onClose).toHaveBeenCalledTimes(3);
    button("Start free trial").click(); expect(actions.onPrimary).toHaveBeenCalledOnce();
    button("Compare plans").click(); expect(actions.onSeePlans).toHaveBeenCalledOnce();
    button("Not now").click(); expect(actions.onNotNow).toHaveBeenCalledOnce();
    // A payer has no plans to compare in the app yet: no Compare plans link.
    show({ view: cloudProPopupView(onPlan("pro"), TRIAL_OFFER) as CloudProPopupView });
    expect([...container.querySelectorAll("button")].map(item => item.textContent)).not.toContain("Compare plans");
  });

  it("knows when another dialog is open, and notices it opening and closing", () => {
    vi.useFakeTimers();
    try {
      const seen: boolean[] = [];
      const Probe = () => { seen.push(useOtherDialogOpen(true)); return null; };
      show();
      expect(otherDialogOpen()).toBe(false);
      flushSync(() => createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(Probe)));
      expect(seen.at(-1)).toBe(false);
      const other = document.body.appendChild(document.createElement("div"));
      other.setAttribute("aria-modal", "true");
      expect(otherDialogOpen()).toBe(true);
      flushSync(() => vi.advanceTimersByTime(1_000));
      expect(seen.at(-1)).toBe(true);
      other.remove();
      flushSync(() => vi.advanceTimersByTime(1_000));
      expect(seen.at(-1)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("any dialog on screen counts, modal or not, the tour's cards and the card that says a new Cloud is set up; one not shown or its own does not", () => {
    show();
    expect(otherDialogOpen()).toBe(false);
    for (const [attribute, value] of [["role", "dialog"], ["role", "alertdialog"], ["aria-modal", "true"], ["data-tour-card", ""], ["data-cloud-setup-ready", ""]]) {
      const other = document.body.appendChild(document.createElement("div"));
      other.setAttribute(attribute!, value!);
      expect(otherDialogOpen(), `${attribute}=${value}`).toBe(true);
      other.style.display = "none";
      expect(otherDialogOpen(), `not shown: ${attribute}=${value}`).toBe(false);
      other.remove();
    }
    const inside = container.querySelector('[role="dialog"]')!.appendChild(document.createElement("div"));
    inside.setAttribute("role", "alertdialog");
    expect(otherDialogOpen(), "inside the popup").toBe(false);
  });

  it("the first conversation's spotlight is a dialog it waits for, and an Escape meant for the spotlight reaches it", () => {
    const spotRoot = createRoot(document.body.appendChild(document.createElement("div")));
    const gotIt = vi.fn();
    flushSync(() => spotRoot.render(createElement(Spotlight, { anchor: null, placement: "below", primary: { label: "Got it", onClick: gotIt }, onDone: gotIt, children: "Approve this step" })));
    expect(document.querySelector('[role="dialog"]')!.getAttribute("aria-modal"), "the spotlight is not modal").toBeNull();
    expect(otherDialogOpen()).toBe(true);
    const spotButton = [...document.querySelectorAll("button")].find(button => button.textContent === "Got it")!;
    show(); spotButton.focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    spotButton.dispatchEvent(escape);
    expect(actions.onClose).not.toHaveBeenCalled(); expect(escape.defaultPrevented).toBe(false);
    expect(gotIt).toHaveBeenCalledOnce();
    expect(press("Tab").defaultPrevented, "nor does it pull Tab out of the spotlight").toBe(false);
    expect(document.activeElement).toBe(spotButton);
    spotRoot.unmount();
  });

  it("the calendar's Quick create (a dialog with only a label) counts too", () => {
    const quick = document.body.appendChild(document.createElement("div"));
    quick.setAttribute("role", "dialog"); quick.setAttribute("aria-label", "Quick create");
    quick.appendChild(document.createElement("input")).focus();
    expect(otherDialogOpen()).toBe(true);
    quick.remove();
    expect(otherDialogOpen()).toBe(false);
  });

  it("gives focus back only while it still has it, or nothing does", () => {
    show();
    const other = document.body.appendChild(document.createElement("input"));
    other.focus();
    flushSync(() => root.render(null));
    expect(document.activeElement, "focus that moved on stays where it went").toBe(other);
    show(); expect(document.activeElement!.id).toBe("cloud-pro-popup-title");
    document.body.focus(); (document.activeElement as HTMLElement | null)?.blur();
    flushSync(() => root.render(null));
    expect(document.activeElement, "lost focus goes back to where it was").toBe(other);
  });
});

