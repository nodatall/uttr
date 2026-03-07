import React, { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";

import ModelSelector from "../model-selector";
import UpdateChecker from "../update-checker";

const Footer: React.FC = () => {
  const [version, setVersion] = useState("");

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        const appVersion = await getVersion();
        setVersion(appVersion);
      } catch (error) {
        console.error("Failed to get app version:", error);
        setVersion("0.1.2");
      }
    };

    fetchVersion();
  }, []);

  return (
    <div className="w-full border-t border-white/6 bg-[rgba(255,255,255,0.02)]">
      <div className="flex items-center justify-between px-5 py-3 text-xs text-text/52">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 rounded-full bg-logo-primary shadow-[0_0_8px_rgba(103,215,163,0.55)]" />
          <ModelSelector />
        </div>
        <div className="flex items-center gap-2 text-text/42">
          <UpdateChecker />
          <span className="text-text/25">•</span>
          {/* eslint-disable-next-line i18next/no-literal-string */}
          <span>v{version}</span>
        </div>
      </div>
    </div>
  );
};

export default Footer;
