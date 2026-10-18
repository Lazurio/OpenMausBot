import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  phoneMenuItems,
  profileInitials,
  profileMenuItems,
  selectPhoneDestination,
  profileLabel,
  updateBusy,
  updateNoteworthy,
  updateLabel,
  updatePhase,
} from "./SidebarProfileMenu";
import { ANDROID_APK_URL, DOCS_URL, FEEDBACK_URL, HELP_CENTER_URL, IOS_APP_STORE_URL, platformLabel } from "@/lib/app-links";
import {
  connectPhoneEntry,
  phoneDestinations,
  phonePairingSettingsAction,
  type PhonePairingAccess,
  type PhonePairingTarget,
} from "@/lib/phone-pairing";
import { PHONE_APPS, PhoneAppDialog, type PhoneAppConnect } from "./PhoneAppDialog";
import type { UpdaterState } from "@/lib/updater";

const state = (patch: Partial<UpdaterState>): UpdaterState => ({ status: "idle", ...patch }) as UpdaterState;

describe("profileInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(profileInitials({ name: "Milind Soni" })).toBe("MS");
    expect(profileInitials({ name: "Ada Byron Lovelace" })).toBe("AB");
  });

  it("falls back to the email, then to a placeholder", () => {
    expect(profileInitials({ email: "you@x.dev" })).toBe("Y");
    expect(profileInitials({})).toBe("?");
    expect(profileInitials(undefined)).toBe("?");
  });

  it("ignores whitespace-only names", () => {
    expect(profileInitials({ name: "   ", email: "you@x.dev" })).toBe("Y");
  });
});

describe("profileLabel", () => {
  it("prefers the name, then the email, then You", () => {
    expect(profileLabel({ name: "Omkar", email: "o@x.dev" })).toBe("Omkar");
    expect(profileLabel({ email: "o@x.dev" })).toBe("o@x.dev");
    expect(profileLabel(undefined)).toBe("You");
  });
});

describe("updatePhase", () => {
  it("reports the bridge's own in-flight states", () => {
    expect(updatePhase(state({ status: "checking" }), false)).toBe("checking");
    expect(updatePhase(state({ status: "downloading" }), false)).toBe("downloading");
    expect(updatePhase(state({ status: "preparing" }), false)).toBe("preparing");
    expect(updatePhase(state({ status: "installing" }), false)).toBe("installing");
  });

  it("acknowledges a check that found nothing", () => {
    expect(updatePhase(null, true)).toBe("up-to-date");
    expect(updatePhase(null, false)).toBe("idle");
  });

  it("lets a real status outrank the acknowledgement", () => {
    expect(updatePhase(state({ status: "downloading" }), true)).toBe("downloading");
  });
});

describe("updateLabel", () => {
  it("names the version it is ready to install", () => {
    expect(updateLabel("downloaded", state({ status: "downloaded", version: "0.2.0" }))).toBe(
      "OpenMausBot 0.2.0 ready — restart",
    );
  });

  it("shows progress only once there is a percentage", () => {
    expect(updateLabel("downloading", state({ status: "downloading" }))).toBe("Starting download…");
    expect(updateLabel("downloading", state({ status: "downloading", percent: 41.6 }))).toBe("Downloading… 42%");
  });

  it("distinguishes native preparation from restart readiness", () => {
    expect(updateLabel("preparing", state({ status: "preparing", percent: 100 }))).toBe("Preparing update…");
    expect(updateLabel("installing", state({ status: "installing", message: "Restart is taking longer than expected." })))
      .toBe("Restart is taking longer than expected.");
    expect(updateLabel("downloaded", state({ status: "downloaded", version: "0.2.0", installMode: "handoff" })))
      .toBe("OpenMausBot 0.2.0 ready — install");
    expect(updateLabel("installing", state({ status: "installing", installMode: "handoff" })))
      .toBe("Opening a terminal…");
  });

  it("carries the updater's own message when something failed", () => {
    expect(updateLabel("error", state({ status: "error", message: "Network unreachable" }))).toBe(
      "Network unreachable",
    );
    expect(updateLabel("error", state({ status: "error" }))).toBe("Update failed — try again");
  });

  it("points a hand-off at the terminal that finishes it", () => {
    expect(updateLabel("handed-off", state({ status: "handed-off" }))).toBe(
      "Finish the update in your terminal",
    );
  });

  it("defaults to the invitation to check", () => {
    expect(updateLabel("idle", null)).toBe("Check for updates");
    expect(updateLabel("up-to-date", null)).toBe("You're up to date");
  });
});

describe("updateBusy", () => {
  it("blocks clicks while something is in flight", () => {
    expect(updateBusy("checking")).toBe(true);
    expect(updateBusy("downloading")).toBe(true);
    expect(updateBusy("preparing")).toBe(true);
    expect(updateBusy("installing")).toBe(true);
    expect(updateBusy("downloaded")).toBe(false);
    expect(updateBusy("idle")).toBe(false);
  });

  it("blocks the gap between the click and the bridge catching up", () => {
    expect(updateBusy("downloaded", true)).toBe(true);
    expect(updateBusy("error", true)).toBe(true);
  });
});

describe("platformLabel", () => {
  it("names the platforms we ship, and stays quiet otherwise", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("freebsd")).toBeNull();
    expect(platformLabel(undefined)).toBeNull();
  });
});

describe("updateNoteworthy", () => {
  it("puts a real update on the profile row", () => {
    expect(updateNoteworthy("downloading")).toBe(true);
    expect(updateNoteworthy("preparing")).toBe(true);
    expect(updateNoteworthy("downloaded")).toBe(true);
    expect(updateNoteworthy("installing")).toBe(true);
    expect(updateNoteworthy("error")).toBe(true);
    expect(updateNoteworthy("handed-off")).toBe(true);
  });

  it("leaves a quiet updater quiet", () => {
    expect(updateNoteworthy("idle")).toBe(false);
    expect(updateNoteworthy("checking")).toBe(false);
    expect(updateNoteworthy("up-to-date")).toBe(false);
  });

  it("shows the click that has not landed yet", () => {
    expect(updateNoteworthy("idle", true)).toBe(true);
  });
});

describe("outward links", () => {
  it("sends Help Center to the docs the website also links to", () => {
    expect(HELP_CENTER_URL).toBe(DOCS_URL);
    expect(DOCS_URL).toBe("https://github.com/milind-soni/OpenMausBot/tree/main/docs");
  });

  it("sends Send Feedback to the Discord community", () => {
    expect(FEEDBACK_URL).toBe("https://discord.gg/9Wb8MEpXRs");
  });
});

describe("the phone entries", () => {
  const admin: PhonePairingAccess = { session: { kind: "session", id: "s", label: "Mac", scopes: ["admin", "client"], expiresAt: 1 }, pairingCodes: true };
  const chatOnly: PhonePairingAccess = { session: { kind: "session", id: "s", label: "Phone", scopes: ["client"], expiresAt: 1 }, pairingCodes: true };
  const items = (target: PhonePairingTarget, access: PhonePairingAccess | null, connected = false) => {
    const onConnect = vi.fn(), onGetApp = vi.fn();
    const destinations = phoneDestinations(connectPhoneEntry(target, access));
    return { list: phoneMenuItems({ destinations, connected, onConnect, onGetApp }), onConnect, onGetApp };
  };
  const shown = (...args: Parameters<typeof items>) => items(...args).list.map((item) => [item.label, item.subtitle ?? null, ...(item.note ? [item.note] : [])]);
  const APP = ["Get the phone app", null];

  it("on this computer: Connect your phone, to this computer, then Get the phone app", () => {
    expect(shown("computer", null)).toEqual([["Connect your phone", "to this computer"], APP]);
  });

  it("on a Cloud home: one Connect your phone to My Cloud", () => {
    expect(shown("cloud", admin)).toEqual([["Connect your phone", "to My Cloud"], APP]);
  });

  it("on another server: to this server, and gone for a session that cannot make a pairing code", () => {
    expect(shown("server", admin)).toEqual([["Connect your phone", "to this server"], APP]);
    expect(shown("server", chatOnly)).toEqual([APP]);
    expect(shown("server", { ...admin, pairingCodes: false })).toEqual([APP]);
    expect(shown("cloud", chatOnly)).toEqual([APP]);
  });

  it("never offers the iOS-only entry it replaced", () => {
    for (const target of ["computer", "server"] as const) {
      expect(items(target, null).list.map((item) => item.label)).not.toContain("Get OpenMausBot for iOS");
    }
  });

  it("each line hands on its own destination", () => {
    const { list, onConnect, onGetApp } = items("computer", null);
    list[0]!.onSelect();
    expect(onConnect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "here", target: "computer" }));
    expect(onGetApp).not.toHaveBeenCalled();
    list[1]!.onSelect();
    expect(onGetApp).toHaveBeenCalledOnce();
  });

  it("shows this computer's live phone on this computer's line only", () => {
    expect(items("computer", null, true).list[0]!.trailing).toBeTruthy();
    expect(items("computer", null, false).list[0]!.trailing).toBeUndefined();
    expect(items("cloud", admin, true).list[0]!.trailing).toBeUndefined();
  });
});

describe("choosing where the phone connects", () => {
  it("opens this server's phone pairing", () => {
    const dispatch = vi.fn();
    selectPhoneDestination(phoneDestinations(connectPhoneEntry("computer", null))[0]!, { dispatch });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(phonePairingSettingsAction());
  });
});

describe("Get the phone app", () => {
  it("offers iPhone and Android with the links the website and Cloud page use", () => {
    expect(PHONE_APPS.map((app) => [app.id, app.url])).toEqual([["ios", IOS_APP_STORE_URL], ["android", ANDROID_APK_URL]]);
    expect(IOS_APP_STORE_URL).toBe("https://apps.apple.com/in/app/mausbot/id6803387923");
    expect(ANDROID_APK_URL).toBe("https://github.com/milind-soni/OpenMausBot/releases/download/android-v1.5.0/OpenMausBot.apk");
  });

  const render = (connect?: PhoneAppConnect[]) => {
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
    try {
      return renderToStaticMarkup(createElement(PhoneAppDialog, { open: true, onClose: () => {}, connect }));
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const to = (key: string, subtitle: string): PhoneAppConnect => ({ key, subtitle, onSelect: () => {} });

  it("draws a code to scan for each, and points on to Connect your phone where this window can pair", () => {
    const html = render([to("here", "to this computer")]);
    expect(html).toContain('data-phone-app="ios"');
    expect(html).toContain('data-phone-app="android"');
    expect(html.match(/<svg/g)?.length).toBe(2);
    expect(html).toContain("Open in the App Store");
    expect(html).toContain("Download the APK");
    expect(html).toContain("Connect your phone");
    expect(html).toContain("to this computer");
    expect(render()).not.toContain("Connect your phone");
    expect(render([])).not.toContain("Connect your phone");
  });

  it("offers every destination the menu does, in the same order", () => {
    const html = render([to("cloud", "to My Cloud (always on)"), to("here", "to this computer")]);
    expect(html.indexOf('data-phone-app-connect="cloud"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-phone-app-connect="cloud"')).toBeLessThan(html.indexOf('data-phone-app-connect="here"'));
  });

  it("is not drawn while closed", () => {
    expect(renderToStaticMarkup(createElement(PhoneAppDialog, { open: false, onClose: () => {} }))).toBe("");
  });
});

describe("profileMenuItems", () => {
  const noop = () => {};
  const build = (patch: Partial<Parameters<typeof profileMenuItems>[0]> = {}) => profileMenuItems({
    phone: [{ key: "phone-app", label: "Get the phone app", onSelect: noop }],
    usage: true,
    update: null,
    onUsage: noop, onSettings: noop, onShortcuts: noop, onAbout: noop, onHelp: noop, onFeedback: noop,
    ...patch,
  });

  it("groups usage and the phone, then help and settings", () => {
    const items = build();
    expect(items.map((item) => item.key)).toEqual(["usage", "phone-app", "support", "settings"]);
    expect(items.find((item) => item.key === "support")!.submenu!.map((item) => item.key)).toEqual(["help", "feedback", "shortcuts", "about"]);
  });

  it("only offers what this window has: no usage on a remote server", () => {
    const items = build({ usage: false });
    expect(items.map((item) => item.key)).toEqual(["phone-app", "support", "settings"]);
    expect(items.some((item) => item.separatorBefore)).toBe(false);
  });

  it("keeps the update entry beside settings", () => {
    const update = { key: "update", label: "Check for updates", onSelect: noop };
    expect(build({ update }).map((item) => item.key)).toEqual(["usage", "phone-app", "support", "settings", "update"]);
  });

  it("opens the Usage page of Settings", () => {
    const onUsage = vi.fn();
    const items = build({ onUsage });
    items.find((item) => item.key === "usage")!.onSelect();
    expect(onUsage).toHaveBeenCalledOnce();
  });
});
