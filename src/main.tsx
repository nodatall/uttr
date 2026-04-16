import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { logFrontendStartup } from "@/lib/startupLog";

// Initialize i18n
import "./i18n";

logFrontendStartup("main module loaded");

// Initialize model store (loads models and sets up event listeners)
import { useModelStore } from "./stores/modelStore";
logFrontendStartup("model store initialize start");
useModelStore.getState().initialize();
logFrontendStartup("model store initialize dispatched");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
logFrontendStartup("react render dispatched");
