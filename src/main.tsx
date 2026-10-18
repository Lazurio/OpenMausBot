import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
} from "./lib/session";
import { bootstrapBrand } from "./lib/brand";
import { applySkinChoice, readSkinChoice } from "./lib/skins";
import { applyChatWidth, readChatWidth } from "./lib/chat-width";
import { applyFont, readFont } from "./lib/fonts";
import { applyInterfaceMode, settleAdvancedModeDefault } from "./lib/interface-mode";
import { BrowserSignInPage } from "./pair/BrowserSignInPage";
import { PairPage } from "./pair/PairPage";
import "./styles.css";

// Before first paint; settleAdvancedModeDefault must run before applySkin writes omb-skin.
settleAdvancedModeDefault();
applyInterfaceMode();
applySkinChoice(readSkinChoice());
applyFont(readFont());
applyChatWidth(readChatWidth());

async function chooseRoot(): Promise<React.ReactNode> {
  if (location.pathname === "/pair") {
    const signIn = takeBrowserSignInFromLocation();
    if (signIn) {
      const preview = await previewBrowserSignIn(signIn);
      return preview ? <BrowserSignInPage credential={signIn} owner={preview.owner} /> : <PairPage initialCode={null} reason={BROWSER_SIGN_IN_FAILED} />;
    }
  }
  const session = await readSessionState();
  // Lazurio overlay (pair straight in): the Environment pairs a browser its gateway let in.
  if (session.kind === "unauthenticated") return (await selfPair()) ? <App /> : <PairPage initialCode={null} reason={session.error} />;
  if (session.kind === "loopback" && session.trust === "service") return <PairPage initialCode={null} reason={SERVICE_TRUST_REASON} />;
  return <App />;
}

void Promise.all([bootstrapBrand(), chooseRoot()]).then(([, root]) => {
  createRoot(document.getElementById("root")!).render(<StrictMode>{root}</StrictMode>);
});
