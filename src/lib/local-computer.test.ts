import { describe, expect, it } from "vitest";
import en from "@/locales/en.json";
import type { Bot, InstanceInfo } from "@/state/store";
import {
  instanceSupportsLocalComputer,
  localComputerDisabledReason,
  localComputerSelectable,
} from "./local-computer";

describe("local computer UI eligibility", () => {
  it("requires the selected instance to advertise approval-capable local MCP", () => {
    const bot = {
      modelSelection: { instanceId: "claude", model: "test" },
    } satisfies Pick<Bot, "modelSelection">;
    const instances = [
      {
        instanceId: "claude",
        capabilities: { localComputerMcp: true },
      },
    ] satisfies Array<Pick<InstanceInfo, "instanceId" | "capabilities">>;
    expect(instanceSupportsLocalComputer(instances as InstanceInfo[], bot)).toBe(true);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: {} }] as InstanceInfo[],
        bot,
      ),
    ).toBe(false);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: { computerMcp: true } }] as InstanceInfo[],
        bot,
      ),
    ).toBe(true);
  });

  it("keeps This computer selectable on macOS before CUA is granted", () => {
    const capabilities = {
      host: { platform: "darwin" as const },
      localComputer: { available: false },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(
      localComputerSelectable({
        capabilities: {
          host: { platform: "linux" as const },
          localComputer: { available: false },
        } as DesktopCapabilities,
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("keeps This computer selectable on Windows before the driver is live", () => {
    const capabilities = {
      host: { platform: "win32" as const, label: "Windows" },
      localComputer: { available: false, enabled: false, status: "unavailable" },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(localComputerDisabledReason({ capabilities, providerSupportsLocal: true })).toBe(
      "Bots can't use this PC right now. Restart OpenMausBot, and if that doesn't help, open Settings → Diagnostics.",
    );
  });

  it("explains the Wayland seat-safety block and names the supported session", () => {
    const capabilities = {
      host: { platform: "linux" as const },
      localComputer: {
        available: false,
        enabled: false,
        reasonCode: "linux-wayland-seat-safety-blocked",
      },
    } as DesktopCapabilities;

    expect(
      localComputerDisabledReason({ capabilities, providerSupportsLocal: true }),
    ).toBe(
      "Bots can't use this computer in this kind of desktop session yet. Sign out, choose “Ubuntu on Xorg” on the sign-in screen, and sign back in.",
    );
  });
});

describe("what the person reads about using this computer", () => {
  const JARGON = /DevTools|CDP|profile[- ]access|grant\b|bind to|attach|endpoint|driver|\bCUA\b|Cua\b|Boat key|ACP|provider|Wayland|descriptor/i;
  const host = (platform: DesktopCapabilities["host"]["platform"], label = "Desktop") => ({ platform, label }) as DesktopCapabilities["host"];
  const reasons = [
    localComputerDisabledReason({ capabilities: { host: host("darwin"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: false }),
    localComputerDisabledReason({ capabilities: { host: host("darwin"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: true }),
    localComputerDisabledReason({ capabilities: { host: host("win32"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: true }),
    localComputerDisabledReason({ capabilities: { host: host("other", "Browser"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: true }),
    ...["linux-wayland-seat-safety-blocked", "wayland-compositor-unsupported", undefined].map((reasonCode) =>
      localComputerDisabledReason({ capabilities: { host: host("linux"), localComputer: { available: false, enabled: reasonCode !== undefined, reasonCode } } as DesktopCapabilities, providerSupportsLocal: true })),
    localComputerDisabledReason({ capabilities: { host: host("linux"), localComputer: { available: false, enabled: true } } as DesktopCapabilities, providerSupportsLocal: true }),
  ];

  it("says what to do in plain words, never the parts underneath", () => {
    expect(reasons.every((reason) => typeof reason === "string" && reason.length > 0)).toBe(true);
    for (const reason of reasons) expect(reason, reason!).not.toMatch(JARGON);
    expect(reasons[3]).toBe("Only the OpenMausBot app on this computer can let a bot use it. Open the app here to use it.");
  });

  it("keeps the same plain words in the questions and the place lines the app shows", () => {
    const shown = Object.entries(en as Record<string, string>).filter(([key]) =>
      key.startsWith("approval.yourComputer.") || key.startsWith("computer.problem.local") || key.startsWith("place.view.") || key.startsWith("place.action."));
    expect(shown.length).toBeGreaterThan(40);
    for (const [key, text] of shown) expect(text, key).not.toMatch(/DevTools|profile[- ]access|grant\b|bind to|\bCUA\b|Cua Driver|Boat key/i);
    // Boat makes the cloud desktops, and is named where they are offered.
    expect((en as Record<string, string>)["place.view.ccNeedsKey.line"]).toContain("from Boat");
  });
});
