import React from "react";

interface SettingContainerProps {
  title: string;
  description: string;
  children: React.ReactNode;
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  layout?: "horizontal" | "stacked";
  disabled?: boolean;
  tooltipPosition?: "top" | "bottom";
}

export const SettingContainer: React.FC<SettingContainerProps> = ({
  title,
  description,
  children,
  grouped = false,
  layout = "horizontal",
  disabled = false,
}) => {
  const containerClasses = grouped
    ? "px-4 py-3"
    : "rounded-2xl border border-white/7 px-4 py-3";

  if (layout === "stacked") {
    return (
      <div className={containerClasses}>
        <div className="mb-2">
          <h3 className={`text-sm font-medium ${disabled ? "opacity-50" : ""}`}>
            {title}
          </h3>
        </div>
        <div className="w-full">{children}</div>
      </div>
    );
  }

  // Horizontal layout (default)
  const horizontalContainerClasses = grouped
    ? "flex min-h-[56px] flex-col items-start gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
    : "flex min-h-[56px] flex-col items-start gap-3 rounded-2xl border border-white/7 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6";

  return (
    <div className={horizontalContainerClasses}>
      <div className="w-full min-w-0 sm:max-w-[58%]">
        <h3
          className={`text-[15px] leading-5 font-medium ${disabled ? "opacity-50" : "text-text/92"}`}
        >
          {title}
        </h3>
      </div>
      <div className="relative w-full sm:w-auto">{children}</div>
    </div>
  );
};
