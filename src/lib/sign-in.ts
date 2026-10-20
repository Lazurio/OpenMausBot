import { api } from "@/state/store";

export async function answerSignIn(ref: { botId: string; threadId: string; messageId: string }, answer: "done" | "cancel"): Promise<void> {
  await api(`/api/bots/${encodeURIComponent(ref.botId)}/sign-in-cards/${encodeURIComponent(ref.messageId)}/${answer}`, {
    method: "POST",
    body: JSON.stringify({ threadId: ref.threadId }),
  });
}
