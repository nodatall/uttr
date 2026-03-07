import React from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  variant?: "default" | "compact";
}

export const Input: React.FC<InputProps> = ({
  className = "",
  variant = "default",
  disabled,
  ...props
}) => {
  const baseClasses =
    "text-sm font-medium bg-white/[0.04] border border-white/10 rounded-xl text-start transition-all duration-150 text-text/92";

  const interactiveClasses = disabled
    ? "opacity-60 cursor-not-allowed bg-white/[0.03] border-white/7"
    : "hover:bg-white/[0.06] hover:border-white/16 focus:outline-none focus:bg-white/[0.07] focus:border-logo-primary/40 focus:ring-1 focus:ring-logo-primary/30";

  const variantClasses = {
    default: "px-3.5 py-2.5",
    compact: "px-2.5 py-1.5",
  } as const;

  return (
    <input
      className={`${baseClasses} ${variantClasses[variant]} ${interactiveClasses} ${className}`}
      disabled={disabled}
      {...props}
    />
  );
};
