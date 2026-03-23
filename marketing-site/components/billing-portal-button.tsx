"use client";

import { createClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useState } from "react";

type BillingPortalButtonProps = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  className?: string;
  children?: ReactNode;
};

export function BillingPortalButton({
  supabaseUrl,
  supabaseAnonKey,
  className,
  children = "Manage billing",
}: BillingPortalButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supabase] = useState(() =>
    createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }),
  );

  const onClick = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        throw new Error("Sign in to manage billing.");
      }

      const response = await fetch("/api/billing/portal", {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
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
      const message = err instanceof Error ? err.message : "Unable to open billing portal.";
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
