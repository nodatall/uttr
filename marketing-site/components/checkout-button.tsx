"use client";

import type { ReactNode } from "react";

type CheckoutButtonProps = {
  children?: ReactNode;
  className?: string;
  source?: string;
};

export function CheckoutButton({
  children,
  className,
  source = "landing-hero",
}: CheckoutButtonProps) {
  const onClick = async () => {
    const url = new URL("/claim", window.location.origin);
    url.searchParams.set("source", source);
    window.location.assign(url.toString());
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${className ?? ""} cursor-pointer`}
    >
      {children ?? "Download for macOS"}
    </button>
  );
}
