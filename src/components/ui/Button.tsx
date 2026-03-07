import React from "react";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "primary"
    | "primary-soft"
    | "secondary"
    | "danger"
    | "danger-ghost"
    | "ghost";
  size?: "sm" | "md" | "lg";
}

export const Button: React.FC<ButtonProps> = ({
  children,
  className = "",
  variant = "primary",
  size = "md",
  ...props
}) => {
  const baseClasses =
    "font-medium rounded-xl border focus:outline-none transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";

  const variantClasses = {
    primary:
      "text-white bg-background-ui border-background-ui/70 hover:bg-background-ui/90 hover:border-background-ui focus:ring-1 focus:ring-background-ui/60 shadow-[0_10px_24px_rgba(29,155,100,0.18)]",
    "primary-soft":
      "text-text bg-logo-primary/14 border-logo-primary/12 hover:bg-logo-primary/18 hover:border-logo-primary/25 focus:ring-1 focus:ring-logo-primary/40",
    secondary:
      "bg-white/[0.04] border-white/8 text-text/82 hover:bg-white/[0.07] hover:border-white/12 focus:outline-none",
    danger:
      "text-white bg-red-600 border-mid-gray/20 hover:bg-red-700 hover:border-red-700 focus:ring-1 focus:ring-red-500",
    "danger-ghost":
      "text-red-400 border-transparent hover:text-red-300 hover:bg-red-500/10 focus:bg-red-500/20",
    ghost:
      "text-current border-transparent hover:bg-white/[0.05] hover:border-white/10 focus:bg-white/[0.06]",
  };

  const sizeClasses = {
    sm: "px-2.5 py-1.5 text-xs",
    md: "px-4 py-2 text-sm",
    lg: "px-4 py-2.5 text-base",
  };

  return (
    <button
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};
