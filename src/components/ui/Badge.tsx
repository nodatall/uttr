import React from "react";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "primary" | "success" | "secondary";
  className?: string;
}

const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "primary",
  className = "",
}) => {
  const variantClasses = {
    primary:
      "bg-logo-primary/16 text-logo-primary border border-logo-primary/18",
    success: "bg-green-500/12 text-green-300 border border-green-400/12",
    secondary: "bg-white/[0.05] text-text/65 border border-white/8",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
};

export default Badge;
