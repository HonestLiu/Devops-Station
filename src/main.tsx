import React from "react";
import ReactDOM from "react-dom/client";

import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useAppStore } from "./store/useAppStore";
import { useHostsStore } from "./store/useHostsStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PetWindow } from "./pets/PetWindow";

// Boot order matters: theme + typography must be applied before the first
// paint, otherwise we get a flash of the default theme. Settings and the host
// list are the only async bootstrap work.
async function bootstrap() {
  await useAppStore.getState().loadSettings();
  await useHostsStore.getState().load().catch(() => undefined);

  const root = document.getElementById("root");
  if (!root) throw new Error("Root element #root not found");

  // The dedicated transparent pet overlay window renders a different root.
  const isPetWindow = getCurrentWindow().label === "pet";

  ReactDOM.createRoot(root).render(
    <ErrorBoundary>
      {isPetWindow ? <PetWindow /> : <App />}
    </ErrorBoundary>,
  );
}

void bootstrap();
