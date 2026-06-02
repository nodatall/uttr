import React from "react";
import ReactDOM from "react-dom/client";
import AskSelectionPanel from "./AskSelectionPanel";
import "@/i18n";
import "./AskSelectionPanel.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AskSelectionPanel />
  </React.StrictMode>,
);
