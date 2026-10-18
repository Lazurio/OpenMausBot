// Phone onboarding only chooses a route; the caller starts, verifies and stops it, and mints or cancels its pairing code.
import type { CliOptions } from "./cli.ts";
import type { SetupIo } from "./cli-prompts.ts";

export type PhoneKind = "ios" | "android";
export interface PhoneSetupResult {
  options: CliOptions;
  phone?: PhoneKind;
}

/** An HTTPS origin, not proof a phone can reach it; never a pasted invitation, password, query token, localhost or unspecified bind. */
export function normalizePhoneOrigin(raw: string): string | null {
  const value = raw.trim();
  // Reject control characters before URL parsing can silently remove them.
  // eslint-disable-next-line no-control-regex
  if (!/^https:\/\/[^/]/i.test(value) || /[\s\u0000-\u001f\u007f\\?#@]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") return null;
    if (!host || host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host.startsWith("127.")) return null;
    if (host === "[::]" || host === "[::1]" || /^\[::ffff:(?:0:0|7f[0-9a-f]{2}:[0-9a-f]+)\]$/.test(host)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function runPhoneSetup(
  options: CliOptions,
  io: SetupIo,
): Promise<PhoneSetupResult> {
  const skip = (): PhoneSetupResult => ({ options });
  const selected = (phone: PhoneKind, route: Partial<CliOptions> = {}): PhoneSetupResult => ({
    options: { ...options, ...route, client: true, pair: true }, phone,
  });
  for (;;) {
    const device = await io.choose("Use OpenMausBot on your phone?", [
      "Skip for now",
      "iPhone / iPad — native app or Safari",
      "Android — app or browser",
    ], 0);
    if (device === 0) return skip();
    const phone: PhoneKind = device === 1 ? "ios" : "android";
    // Lazurio overlay (DEV-6673 M3): no managed public address through an OpenMausBot account; a fleet's --tunnel is already set up.
    if (options.tunnel) return selected(phone);
    if (options.tailscale) {
      io.log("Keep Tailscale connected on both this computer and your phone, on the same tailnet.");
      return selected(phone);
    }
    const existing = options.publicUrl ? normalizePhoneOrigin(options.publicUrl) : null;
    if (existing) {
      io.log("Your configured HTTPS address will be checked before a phone pairing link is shown.");
      return selected(phone, { publicUrl: existing });
    }
    io.log("This server listens only on this computer. A localhost or LAN-IP link will not connect your phone.");
    let back = false;
    while (!back) {
      const route = await io.choose("How should your phone reach this computer?", [
        "Existing Tailscale — only your tailnet",
        "Existing HTTPS address — advanced",
        "Back to phone choice",
        "Skip for now",
      ], 3);
      if (route === 3) return skip();
      if (route === 2) { back = true; continue; }
      if (route === 0) {
        io.log("Tailscale must already be installed and signed in on this computer and phone, with HTTPS certificates enabled for the tailnet.");
        if (!await io.confirm("Allow OpenMausBot to serve HTTPS to your tailnet while it runs?", false)) continue;
        return selected(phone, { tailscale: true, tunnel: false, publicUrl: undefined });
      }
      io.log("Use an HTTPS reverse proxy you already configured for this server. Enter only its origin, without a password, pairing code, path, query or fragment.");
      const answer = await io.ask("Existing HTTPS address (Enter goes back): ");
      if (!answer.trim()) continue;
      const origin = normalizePhoneOrigin(answer);
      if (!origin) {
        io.log("Enter a non-localhost HTTPS origin, such as https://maus.example.com. The address was not saved.");
        continue;
      }
      io.log("This does not create a proxy or open a LAN listener. Its connection will be checked before pairing.");
      return selected(phone, { publicUrl: origin, tunnel: false, tailscale: false });
    }
  }
}

/** The URL is an origin, never the invitation carrying its one-time credential. */
export function phonePairingInstructions(
  phone: PhoneKind,
  input: { origin: string | null; ready: boolean },
): string[] {
  const origin = input.origin ? normalizePhoneOrigin(input.origin) : null;
  if (!input.ready || !origin) {
    return ["Phone access is not ready yet. No phone QR should be shown until the HTTPS connection is verified.",
      "Your local OpenMausBot can still be used on this computer."];
  }
  return [
    phone === "ios"
      ? "On iPhone or iPad, scan the QR with Camera to open Safari. If you already have the OpenMausBot iOS app, use its pairing scanner or paste the full pairing link there."
      : "On Android, open the OpenMausBot app and scan the QR with its pairing scanner. The QR is an app link, so Camera will not open it in a browser.",
    `Or open ${origin}/pair on your phone and enter the code.`,
    "Choose Connect on the phone. Scanning a QR does not mean the phone is paired.",
    "The code works once and expires after five minutes. This phone receives client access: chat and approvals, not settings or pairing administration.",
  ];
}
