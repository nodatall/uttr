import React from "react";

interface SettingsGroupProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  description,
  children,
}) => {
  return (
    <div className="space-y-3">
      {title && (
        <div className="px-1">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
            {title}
          </h2>
          {description && (
            <p className="mt-1 max-w-2xl text-sm text-text/48">{description}</p>
          )}
        </div>
      )}
      <div className="overflow-visible rounded-[18px] border border-white/7 bg-[rgba(255,255,255,0.022)] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <div className="divide-y divide-white/6">{children}</div>
      </div>
    </div>
  );
};
