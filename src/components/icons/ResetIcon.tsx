import React from "react";

interface ResetIconProps {
  width?: number;
  height?: number;
  color?: string;
  className?: string;
}

const ResetIcon: React.FC<ResetIconProps> = ({
  width = 20,
  height = 20,
  className = "",
}) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <g
        stroke={"currentColor"}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      >
        <path d="m13.5 8.5h3v-3" />
        <path d="m13.78 14c-.79.74-1.77 1.24-2.84 1.42-1.07.18-2.16.05-3.15-.39s-1.83-1.15-2.41-2.06-.89-1.97-.87-3.05.35-2.13.96-3.03 1.47-1.58 2.47-1.99 2.1-.51 3.16-.29 2.03.74 2.8 1.5l2.61 2.39" />
      </g>
    </svg>
  );
};

export default ResetIcon;
