import { globSync } from "node:fs";
import path from "node:path";

// Most e2e files drive OMB's own logic through a real server and fake engines, which is the same on every OS, so CI
// runs them on Linux only. The files below also run on the Windows and macOS shards, which set OMB_VITEST_E2E=host:
// each one either has a test that never runs on Linux or depends on how the OS treats paths, processes or Chrome.
export const E2E = /\.e2e\.test\.[cm]?[jt]s$/;

export const HOST_E2E: Readonly<Record<string, string>> = {
  "server/acp-shutdown.e2e.test.ts": "Windows ends an engine on SIGTERM at once, without its exit handlers",
  "server/headless-cli.e2e.test.ts": "the omb command line as a real process on each OS",
  "server/long-running-chief.e2e.test.ts": "a teammate's screen call on the person's own desktop, macOS and Windows only",
  "server/room-roots.e2e.test.ts": "the host desktop fallback, macOS and Windows only",
  "server/runtime-roots.e2e.test.ts": "the host desktop fallback, macOS and Windows only",
  "server/session-credentials.e2e.test.ts": "Auto on this computer, macOS and Windows only",
  "server/voice-notes.e2e.test.ts": "the built-in Mac voices",
};

/** True on the CI shards that run only HOST_E2E of the e2e files. */
export function hostE2eOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_VITEST_E2E === "host";
}

/** Whether a repo-relative POSIX path is an e2e file that runs on Linux only. */
export function isPortableE2e(file: string): boolean {
  return E2E.test(file) && !Object.hasOwn(HOST_E2E, file);
}

/** The repo-relative POSIX paths of every e2e file the include globs find that runs on Linux only. */
export function portableE2eFiles(root: string, include: readonly string[]): string[] {
  return globSync([...include], { cwd: root, exclude: (file) => /(^|[\\/])node_modules$/.test(file) })
    .map((file) => file.split(path.sep).join("/"))
    .filter(isPortableE2e)
    .sort();
}
