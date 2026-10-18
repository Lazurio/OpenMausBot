import type { ComputerHelpRef } from "../../shared/wire";
import { api } from "@/state/store";

  await api(`/api/bots/${encodeURIComponent(ref.botId)}/sign-in-cards/${encodeURIComponent(ref.messageId)}/${answer}`, {
    method: "POST",
    body: JSON.stringify({ threadId: ref.threadId }),
  });
}

export function signInHostIsHere(): boolean {
  return Boolean(window.ogb) && window.ogb?.remoteClient?.active !== true;
}
