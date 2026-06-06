import "./uxReviewMocks";
import "./ux-review.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { AgentationReviewTools } from "./AgentationReviewTools";

const mountAgentation = () => {
  const container = document.createElement("div");
  container.id = "agentation-root";
  document.body.appendChild(container);

  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <AgentationReviewTools />
    </React.StrictMode>,
  );
};

void import("./main").then(mountAgentation);
