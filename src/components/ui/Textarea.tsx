import React from "react";

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: "default" | "compact";
}

const TEXTAREA_BASE_CLASSES =
  "px-2 py-1 text-sm font-semibold bg-mid-gray/10 border border-mid-gray/80 rounded-md text-start transition-[background-color,border-color] duration-150 hover:bg-logo-primary/10 hover:border-logo-primary focus:outline-none focus:bg-logo-primary/10 focus:border-logo-primary resize-y";

const TEXTAREA_VARIANT_CLASSES: Record<
  NonNullable<TextareaProps["variant"]>,
  string
> = {
  default: "px-3 py-2 min-h-[100px]",
  compact: "px-2 py-1 min-h-[80px]",
};

export const Textarea: React.FC<TextareaProps> = ({
  className = "",
  variant = "default",
  ...props
}) => {
  return (
    <textarea
      className={`${TEXTAREA_BASE_CLASSES} ${TEXTAREA_VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
};
