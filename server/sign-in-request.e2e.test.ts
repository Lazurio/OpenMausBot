// Nothing here reaches a real browser, the user's data or port 8799.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { openSse } from "./testing/sse.ts";

const asked = (turn: any): string => JSON.stringify(turn.prompt?.message?.content ?? "");

// The Environment browser stand-in is a shell script for the Platform's CLI (OMB_TEST_ENVIRONMENT_BROWSER).
it.skipIf(process.platform === "win32")("asks the person to sign in from a real turn, and runs the bot's next turn when they press Done", async () => {
  const fixture = await launchVerificationServer({ OMB_TEST_ENVIRONMENT_BROWSER: "1" }, undefined, undefined, undefined, undefined, { scripted: true });
  const url = fixture.info.url;
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const stream = await openSse(`${url}/api/events`);
  try {
    const bot = (await api("POST", "/api/bots", { name: "Signer" })).body.bot;
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "request_sign_in", arguments: { site: "https://www.example.com/dashboard", reason: "The dashboard is behind a login." } }],
        reply: "I asked you to sign in to example.com; I will continue once you have." },
      { reply: "You are signed in, so I opened the dashboard." },
    ] } }));

    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Check my example.com dashboard.", "--url", url]);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(1);
    const call = evidence()[0].evidence.find((entry: any) => entry.step?.tool === "request_sign_in");
    expect(call.response.result.isError).toBeFalsy();
    expect(call.response.result.content[0].text).toContain("The person was asked to sign in to example.com on the Environment browser, in your own tab. Your turn ends now");

    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as any[];
    await expect.poll(async () => (await messages()).some((message) => message.text === "I asked you to sign in to example.com; I will continue once you have."),
      { timeout: 15_000 }).toBe(true);
    const cards = (await messages()).filter((message) => message.kind === "signin");
    expect(cards).toHaveLength(1);
    expect(cards[0].signIn).toMatchObject({ site: "example.com", url: "https://www.example.com/dashboard", place: "browser", reason: "The dashboard is behind a login." });
    const notices = stream.frames.filter((frame) => frame.kind === "notify" && frame.notification?.kind === "sign-in");
    expect(notices).toHaveLength(1);
    expect(notices[0].notification.title).toBe("Signer needs you to sign in to example.com");
    expect((await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20", "--url", url]) as any).status).toBe("needs-user");

    expect(await api("POST", `/api/bots/${bot.id}/sign-in-cards/${cards[0].id}/done`, { threadId: bot.threadId }))
      .toMatchObject({ status: 200, body: { done: true, resumed: true } });
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(2);
    expect(asked(evidence()[1])).toContain("the person finished signing in to example.com. Check you are signed in, then continue");
    await expect.poll(async () => (await messages()).some((message) => message.text === "You are signed in, so I opened the dashboard."),
      { timeout: 15_000 }).toBe(true);
    expect((await messages()).find((message) => message.id === cards[0].id)?.signIn).toMatchObject({ done: true, resumed: true });
  } finally {
    stream.close();
    await fixture.close();
  }
}, 90_000);
