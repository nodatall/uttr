import { getCurrentWindow } from "@tauri-apps/api/window";
import type { FC, MouseEvent } from "react";

interface WindowDragRegionProps {
  className?: string;
}

const WindowDragRegion: FC<WindowDragRegionProps> = ({ className }) => {
  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    void getCurrentWindow().startDragging().catch((error) => {
      console.warn("Window drag failed:", error);
    });
  };

  return (
    <div
      data-tauri-drag-region
      aria-hidden="true"
      onMouseDown={handleMouseDown}
      className={`h-[14px] shrink-0 cursor-move bg-background ${className ?? ""}`}
    />
  );
};

export default WindowDragRegion;
