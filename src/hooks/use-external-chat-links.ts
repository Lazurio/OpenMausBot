import { useEffect, useState } from "react";
import { openChatLink } from "@/components/ThreadRefs";
import { useShowThreads } from "@/lib/thread-preferences";
import { isConversationPath, parseConversationPath, threadRefUrl } from "@/lib/thread-refs";
import type { Action, AppState } from "@/state/store";

/** The app's own navigation never changes the address, so a conversation's address left there would reopen it on reload. */
function leaveConversationPath(): void {
  if (isConversationPath(window.location.pathname)) window.history.replaceState(null, "", "/");
}

export function useExternalChatLinks(state: AppState, dispatch: (action: Action) => void): void {
  const [link, setLink] = useState<string | null>(null);
  const showThreads = useShowThreads();
  useEffect(() => window.ogb?.onChatLink?.(setLink), []);
  useEffect(() => {
    const address = parseConversationPath(window.location.pathname);
    if (address) setLink(threadRefUrl(address));
    else leaveConversationPath();
  }, []);
  useEffect(() => {
    if (!link || !state.hydrated) return;
    setLink(null);
    if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
    if (state.shortcutsOpen) dispatch({ type: "toggleShortcuts", open: false });
    openChatLink(dispatch, link, state, showThreads);
    leaveConversationPath();
  }, [link, state, showThreads, dispatch]);
}
