"use client";

import { useState } from "react";

type CheckoutButtonProps = {
  className?: string;
  source?: string;
};

export function CheckoutButton({
  className,
  source = "landing-hero",
}: CheckoutButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ source }),
      });

      const payload = (await response.json()) as { url?: string; error?: string };

      if (!response.ok || !payload.url) {
        throw new Error(payload.error || "Unable to start checkout right now.");
      }

      window.location.assign(payload.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Checkout failed.";
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
        {isLoading ? "Preparing checkout..." : "Start for $5/month"}
      </button>
      {error ? (
        <p className="mt-3 text-sm text-rose-200">{error}</p>
      ) : null}
    </div>
  );
}
