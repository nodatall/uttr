import React from "react";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "primary" | "success" | "secondary";
  className?: string;
}

const BADGE_VARIANT_CLASSES: Record<NonNullable<BadgeProps["variant"]>, string> =
  {
    primary:
      "bg-logo-primary/16 text-logo-primary border border-logo-primary/18",
    success: "bg-green-500/12 text-green-300 border border-green-400/12",
    secondary: "bg-white/[0.05] text-text/65 border border-white/8",
  };

const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "primary",
  className = "",
}) => {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${BADGE_VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </span>
  );
};

export default Badge;
