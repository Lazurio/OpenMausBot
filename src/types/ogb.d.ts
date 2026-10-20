// The narrow bridge the Electron preload exposes. Absent in the browser.

declare global {
  type CompanyBackupEntry = Omit<import("../../electron/company-backups.mjs").CompanyBackupMetadata, "status"> & { status: "creating" | "uploading" | "completing" | "ready" | "cleanup" };
  interface CompanyBackupScheduleState {
    enabled: boolean;
    status: "off" | "waiting" | "running" | "paused" | "error";
    nextBackupAt?: number;
    lastAttemptAt?: number;
    lastBackupAt?: number;
    message?: string;
  }
  interface CompanyBackupState {
    busy: boolean;
    pendingRestore?: boolean;
    kind?: "backup" | "restore";
    progress?: import("../../electron/company-backups.mjs").CompanyBackupProgress;
    message?: string;
    lastBackupAt?: number;
    schedule?: CompanyBackupScheduleState;
  }
/** The package.json version, inlined by Vite's define at build time. */
const __APP_VERSION__: string;


  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      /** The user's home folder, for showing paths as ~/… */
      homeDir?: string;
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "win-caption" | "native";
    dictation: {
      available: boolean;
      engine: "apple-speech" | "none";
      onDevice: boolean;
      reasonCode?: string;
    };
  };

  /** Whether the desktop is holding this computer awake for routines. */
  interface DesktopRoutineWake {
    /** the toggle */
    keepAwake: boolean;
    /** a power assertion is held right now */
    hold: boolean;
    /** "due" | "running" while held; "off" | "battery" | "idle" | "stopped" otherwise */
    reason: string;
    /** the due routine's time, when the hold is for a due routine */
    at: number | null;
    onBattery: boolean;
  }
  interface DesktopRemoteClientState {
    active: boolean;
    endpoint?: string;
    serverName?: string;
    deviceId?: string;
  }

  interface Window {
    ogb?: {
      platform: NodeJS.Platform;
      /** This app's own version, and whether this page is this app's own: false on a server added in the Server menu,
       * whose page carries that server's version. Absent in desktop builds before it. */
      app?: { version: string; ownPage: boolean };
      organization?: import("../../electron/managed-desktop.mjs").ManagedDesktopBridge;
      desktopNotices?: import("../../electron/desktop-prefs.mjs").DesktopNoticesBridge;
      /** This computer's own page only: the account's full name, for a first run's profile (system-name.mjs). */
      desktopProfile?: { systemName(): Promise<string | null> };
      desktopAnalytics?: import("../../electron/desktop-prefs.mjs").DesktopAnalyticsBridge;
      desktopLanguage?: import("../../electron/desktop-prefs.mjs").DesktopLanguageBridge;
      /** This computer's page and My Cloud's own page: the one-time "Get MausBot updates?" answer. */
      companyBackups?: {
        state(): Promise<CompanyBackupState>;
        list(): Promise<{ backups: CompanyBackupEntry[]; usedBytes: number; limits: { ownerQuotaBytes: number; retainedSnapshots: number } }>;
        create(input: { clientState: import("../../shared/workspace-backup").WorkspaceBackupClientState }): Promise<CompanyBackupEntry>;
        configureSchedule?(input: { enabled: false } | { enabled: true; confirmation: "BACK UP THIS WORKSPACE DAILY" }): Promise<CompanyBackupState>;
        prepareRestore(input: { id: string; password?: string }): Promise<{ id: string; summary: import("../../shared/workspace-backup").WorkspaceBackupSummary }>;
        restore(input: { id: string; confirmation: "REPLACE" }): Promise<{ restoreId: string }>;
        delete(input: { id: string; confirmation: "DELETE" }): Promise<unknown>;
        cancel(): Promise<void>;
        onState(callback: (state: CompanyBackupState) => void): () => void;
      };
      workspaces?: {
        /** `color`: a saved server's colour name (its owner chose it while setting the Cloud up); `home`: this window's
         * home is this Cloud, so there is nothing to switch to. */
        state: () => Promise<{ local: boolean; name: string; origin?: string; color?: string; home?: boolean; role?: string }>;
        /** The native server menu; resolves when it closes. `from: "howto"`: the Show me how tip opened it. */
        menu: (options?: { from?: "howto" }) => Promise<void>;
        /** One plain line for the next page, served once: a team this person is no longer in. */
        line?: () => Promise<{ kind: "left"; name: string } | null>;
      };
      /** Saved servers and the active one (desktop Server menu). Present on
       * the local server's UI; a remote server's page sees a reduced bridge. */
      environments?: {
        state: () => Promise<{
          localOrigin: string;
          remote: boolean;
          /** Named local environments exist only in a packaged build. */
          packaged: boolean;
          activeId: string;
          environments: Array<{
            id: string;
            kind?: "local" | "remote";
            name: string;
            origin?: string;
            dataDir?: string;
            missing?: boolean;
            /** One of the six Cloud colours (environments.cjs ENTRY_COLORS). */
            color?: string;
            /** The person's own My Cloud. */
            home?: boolean;
          }>;
        }>;
        /** Local targets answer {ok, error?} (error strings are an open set); remote ones answer nothing. */
        switch: (id: string) => Promise<{ ok: boolean; error?: string } | void>;
        addFromLink: (link: string, name?: string) => Promise<boolean | void>;
        /** Register a named local environment; an omitted dataDir lands beside the app's own. */
        create: (name: string, dataDir?: string) => Promise<{ ok: boolean; error?: string; state: unknown }>;
        /** Native folder chooser for the create form; { ok: false } on cancel. */
        pickDir: () => Promise<{ ok: boolean; path?: string }>;
        /** {ok:false} when main refused (active local, failed folder delete); a
         * cancelled remote confirm and remote success answer nothing. */
        forget: (id: string, purge?: boolean) => Promise<{ ok: boolean; error?: string } | void>;
        /** `panel` "copy": that server's Copy this computer here panel; otherwise its Computer access. */
        onOpenSettings?: (callback: (computerId?: string | null) => void) => () => void;
      };
      confirm(message: string): Promise<boolean>;
      getCapabilities(): Promise<DesktopCapabilities>;
      onCapabilitiesChanged(cb: (capabilities: DesktopCapabilities) => void): () => void;
      remoteClient?: {
        active: boolean;
        state(): Promise<DesktopRemoteClientState>;
        pair(endpoint: string, code: string): Promise<DesktopRemoteClientState>;
        disconnect(): Promise<DesktopRemoteClientState>;
      };
      /** Keep this computer awake for scheduled routines; absent on remote
       * server pages and in older desktop builds. */
      routines?: {
        wakeState(): Promise<DesktopRoutineWake>;
        keepAwake(enabled: boolean): Promise<DesktopRoutineWake>;
      };
      companionAccount?: {
        state(): Promise<CompanionAccountState>;
        requestCode(email: string): Promise<CompanionAccountState>;
        verifyCode(email: string, code: string): Promise<CompanionAccountState>;
        retry(): Promise<CompanionAccountState>;
        /** Create or repair this computer's HTTPS address because a person
         * is pairing now. Absent in older desktop builds. */
        prepare?(): Promise<CompanionAccountState>;
        signOut(): Promise<CompanionAccountState>;
      };
      androidDevice?: {
        status(): Promise<AndroidDeviceStatus>;
        frame(serial: string): Promise<{ serial: string; dataUrl: string }>;
        input(serial: string, payload: AndroidDeviceInput): Promise<void>;
      };
      /** Start native dictation. Call mode supplies endpointMs so silence
       * finalizes a turn; composer dictation omits it and remains manual. */
      speechStart(options?: { endpointMs?: number }): Promise<void>;
      speechStop(): Promise<void>;
      /** Finish capture and emit the recognizer's final transcript. */
      speechFinish?(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      /** Absolute path of a dropped File ("" when the drag carried no
       * file on disk). Absent in older builds of the shell. */
      getPathForFile?(file: File): string;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. `pageMic`: whether
       * this app lets the asking page use the microphone (this computer's
       * page always; a server's page only on the person's own Cloud).
       * Absent in older builds of the shell. */
      permStatus(): Promise<{ mic: string; pageMic?: "allowed" | "refused" }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech|accessibility. */
      permOpenSettings(pane: "mic" | "screen" | "speech" | "accessibility"): Promise<void>;
      /** Relaunch the local desktop app through its normal shutdown cleanup. */
      relaunch?(): Promise<boolean>;
      /** Copies an engine install command and opens a blank terminal. False
       * when no terminal could be launched; the clipboard still has it. */
      openInstallTerminal?(command: string): Promise<boolean>;
      /** Writes plain text to the system clipboard; false on failure. Absent on older builds. */
      copyText?(text: string): Promise<boolean>;
      /** Opens an http(s) link in the user's default browser. */
      openExternal?(url: string): Promise<boolean>;
      /** Recolor the native window chrome for a skin; absent on older builds. */
      applySkin?(skin: string): Promise<boolean>;
      /** The renderer-drawn Windows caption buttons; absent outside the
       * frameless Windows shell (macOS/Linux/browser keep native chrome). */
      windowControls?: {
        minimize(): Promise<boolean>;
        toggleMaximize(): Promise<boolean>;
        close(): Promise<boolean>;
        state(): Promise<{ maximized: boolean }>;
        onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
      };
      /** Receives a GitHub package URL opened through openmausbot://install. */
      onPackageInstall?(cb: (url: string) => void): () => void;
      /** Receives a chat link (openmausbot://thread/… or openmausbot://bot/…)
       * opened from outside the app. */
      onChatLink?(cb: (link: string) => void): () => void;
      /** The desktop shell's app-menu Preferences… item was activated; open
       * app Settings. Local-shell only: remote server pages never receive
       * the channel, and the bridge is absent in the browser. "cloud" is the
       * openmausbot://cloud link (Settings → OMB Cloud, opened by the link). */
      onOpenAppSettings?(cb: (section?: "organization" | "cloud" | "cloud-settings" | "cloud-add" | "cloud-add-howto") => void): () => void;
      /** Updates the native Dock/taskbar unread indicator. */
      setUnreadCount?(count: number): void;
      /** Native folder picker; resolves null when the user cancels. */
      pickFolder?(current?: string): Promise<string | null>;
      /** Writes the redacted diagnostics report to a user-chosen file;
       * resolves the path, or null when cancelled. */
      exportDiagnostics?(): Promise<string | null>;
      /** Asks where to save a bot-created file (inside ~/.openmausbot), copies
       * it there and reveals it. Resolves the chosen path, or null if the
       * user cancelled the dialog. */
      saveFile?(filePath: string): Promise<string | null>;
      /** Points this computer's file manager at a file a bot linked outside
       * its workspace, without opening or reading it. Local app only. */
      revealInFolder?(filePath: string): Promise<"shown" | "missing" | "invalid">;
      /** Opens this app's logs folder in Explorer or Finder and says where it is. */
      openLogsFolder?(): Promise<{ folder: string; opened: boolean; error?: string }>;
      /** This app's own login item, which opens the window. `available`: false in a build that cannot add one. */
      openAtLogin?: { state(): Promise<{ available: boolean; on: boolean }>; set(on: boolean): Promise<{ available: boolean; on: boolean }> };
      /** Save a provider credential through Electron's OS-backed store. */
      setCredential?(
        name: "xaiApiKey" | "boxToken" | "opencodeGoApiKey" | "ttsKey" | "fishAudioKey" | "jevApiKey" | "openrouterDeciderKey" | "workersAiToken" | "openaiImageApiKey" | "customImageApiKey" | "openaiLiveKey",
        value: string,
      ): Promise<ConfigStatus>;
      /** In-app auto-update (packaged app only; dormant in dev). Updates
       * download by themselves. On this computer's page and the person's own
       * Cloud page; any other server's page gets no state. onState fires
       * with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        /** apply the download: quit-and-install, or copy the command and open
         * a terminal. On a server's page, only from the person's click. */
        install(): Promise<void>;
        /** The person saw the line that the app updated itself: it is not shown again. */
        seen?(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "downloading"
    /** downloaded bytes are being staged by the native macOS updater */
    | "preparing"
    | "downloaded"
    | "installing"
    /** the command is on the clipboard; the user finishes in a terminal */
    | "handed-off"
    | "error";
  version?: string;
  /** the release's notes as published (HTML or Markdown), when the feed has them */
  releaseNotes?: string;
  percent?: number;
  message?: string;
  /** native work may still be running; recovery requires an app restart */
  retryable?: boolean;
  /**
   * How the download gets applied. "restart" quits and installs in place (an
   * Ubuntu .deb asks for the password once, installs and reopens);
   * "handoff" copies the install command and opens a terminal so the user
   * can finish — rpm/pacman builds, and a .deb where no password prompt
   * can be shown, use this.
   */
  installMode?: "restart" | "handoff";
  /** hand-off only: the install command, already on the clipboard */
  command?: string;
  /** hand-off only: whether a terminal was opened to paste it into */
  terminalOpened?: boolean;
  /** downloaded only: the app installs it by itself the next time the person is away and nothing is running */
  installsByItself?: boolean;
  /** the version the app updated itself to while the person was away, until they have seen it said */
  updated?: string;
}

export interface CompanionAccountState {
  available: boolean;
  status: "signed-out" | "connecting" | "ready" | "error";
  email?: string;
  endpoint?: string;
  message?: string;
}

export type AndroidUsbDevice = {
  serial: string;
  state: string;
  connection: "usb";
  model: string;
  product?: string;
  transportId?: string;
};

export type AndroidDeviceStatus = {
  available: boolean;
  reasonCode?: "adb-unavailable" | "adb-failed";
  message?: string;
  devices: AndroidUsbDevice[];
};

export type AndroidDeviceInput =
  | { type: "tap"; x: number; y: number; width: number; height: number }
  | {
      type: "swipe";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      durationMs: number;
      width: number;
      height: number;
    }
  | { type: "key"; key: string; width?: number; height?: number }
  | { type: "text"; text: string; width?: number; height?: number };
