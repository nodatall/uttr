"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { createAuthClient } from "@/lib/auth/client";

type BillingPortalButtonProps = {
  className?: string;
  children?: ReactNode;
};

export function BillingPortalButton({
  className,
  children = "Manage billing",
}: BillingPortalButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auth] = useState(() => createAuthClient());

  const onClick = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const session = await auth.getSession();
      if (!session) {
        throw new Error("Sign in to manage billing.");
      }

      const response = await fetch("/api/billing/portal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      });

      const payload = (await response.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };

      if (!response.ok || !payload.url) {
        throw new Error(payload.error || "Unable to open billing portal.");
      }

      window.location.assign(payload.url);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to open billing portal.";
      setError(message);
      setIsLoading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={isLoading}
        className={`${className ?? ""} cursor-pointer disabled:cursor-not-allowed`}
      >
        {isLoading ? "Opening portal..." : children}
      </button>
      {error ? <p className="mt-3 text-sm text-rose-200">{error}</p> : null}
    </div>
  );
}
