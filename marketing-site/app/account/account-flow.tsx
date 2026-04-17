"use client";

import { createClient, type Session } from "@supabase/supabase-js";
import Link from "next/link";
import { useEffect, useState } from "react";

type AccountFlowProps = {
  supabaseUrl: string;
  supabaseAnonKey: string;
};

async function openBillingPortal(session: Session) {
  const response = await fetch("/api/billing/portal", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.access_token}`,
      "content-type": "application/json",
    },
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    url?: string;
  };

  if (!response.ok || !payload.url) {
    throw new Error(payload.error || "Unable to open billing portal.");
  }

  window.location.assign(payload.url);
}

export function AccountFlow({
  supabaseUrl,
  supabaseAnonKey,
}: AccountFlowProps) {
  const [supabase] = useState(() =>
    createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }),
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const [hasCheckedSession, setHasCheckedSession] = useState(false);
  const [status, setStatus] = useState<"idle" | "auth" | "portal" | "logout">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const canSubmitCredentials =
    status === "idle" && email.trim().length > 0 && password.length > 0;

  useEffect(() => {
    let cancelled = false;
    let fallbackTimeoutId: number | null = null;

    const clearFallbackTimeout = () => {
      if (fallbackTimeoutId !== null) {
        window.clearTimeout(fallbackTimeoutId);
        fallbackTimeoutId = null;
      }
    };

    const scheduleSignedOutFallback = () => {
      clearFallbackTimeout();
      fallbackTimeoutId = window.setTimeout(() => {
        if (!cancelled) {
          setHasCheckedSession(true);
        }
      }, 900);
    };

    const syncSession = async () => {
      scheduleSignedOutFallback();
      const { data } = await supabase.auth.getSession();
      if (cancelled) {
        return;
      }

      clearFallbackTimeout();
      setSignedInEmail(data.session?.user.email ?? null);
      setHasCheckedSession(true);
    };

    const refreshSession = () => {
      setHasCheckedSession(false);
      setStatus((currentStatus) =>
        currentStatus === "auth" || currentStatus === "portal"
          ? "idle"
          : currentStatus,
      );
      void syncSession();
    };

    void syncSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) {
        return;
      }

      setSignedInEmail(session?.user.email ?? null);
      setHasCheckedSession(true);
    });

    window.addEventListener("pageshow", refreshSession);
    window.addEventListener("focus", refreshSession);
    document.addEventListener("visibilitychange", refreshSession);

    return () => {
      cancelled = true;
      clearFallbackTimeout();
      subscription.unsubscribe();
      window.removeEventListener("pageshow", refreshSession);
      window.removeEventListener("focus", refreshSession);
      document.removeEventListener("visibilitychange", refreshSession);
    };
  }, [supabase]);

  const signIn = async () => {
    if (!canSubmitCredentials) {
      return;
    }

    setStatus("auth");
    setError(null);

    try {
      const result = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      const session = result.data.session;
      if (!session) {
        throw new Error(result.error?.message || "Unable to sign in.");
      }

      setSignedInEmail(session.user.email ?? email);
      setHasCheckedSession(true);
      setStatus("portal");
      await openBillingPortal(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
      setStatus("idle");
    }
  };

  const manageBilling = async () => {
    setStatus("portal");
    setError(null);

    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        throw new Error("Sign in to manage your subscription.");
      }

      await openBillingPortal(data.session);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to open billing portal.",
      );
      setStatus("idle");
    }
  };

  const logOut = async () => {
    setStatus("logout");
    setError(null);

    try {
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) {
        throw signOutError;
      }

      setSignedInEmail(null);
      setEmail("");
      setPassword("");
      setHasCheckedSession(true);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to log out.");
      setStatus("idle");
    }
  };

  return (
    <div className="mx-auto mt-9 w-full max-w-xl text-left">
      {signedInEmail ? (
        <div className="space-y-4 text-sm text-cosmic-200">
          <button
            type="button"
            onClick={() => void logOut()}
            disabled={status !== "idle"}
            className="mx-auto mb-2 block rounded-full border border-white/20 px-4 py-2 text-xs font-medium text-cosmic-100 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-70 sm:absolute sm:right-6 sm:top-6 sm:mb-0 md:right-8 md:top-8"
          >
            {status === "logout" ? "Logging out..." : "Log out"}
          </button>
          <p className="text-center">
            Signed in as{" "}
            <strong className="text-cosmic-50">{signedInEmail}</strong>.
          </p>
          <button
            type="button"
            onClick={() => void manageBilling()}
            disabled={status !== "idle"}
            className="mx-auto block rounded-full bg-cosmic-50 px-6 py-3 text-sm font-semibold text-cosmic-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-70"
          >
            {status === "portal"
              ? "Opening billing portal..."
              : "Manage subscription"}
          </button>
        </div>
      ) : !hasCheckedSession ? (
        <div className="space-y-4 text-center text-sm text-cosmic-200">
          <p>Checking your account...</p>
          <div className="mx-auto h-10 w-44 animate-pulse rounded-full bg-cosmic-100/12" />
        </div>
      ) : (
        <form
          className="flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn();
          }}
        >
          <div className="space-y-5">
            <label className="block">
              <span className="mb-2 block text-sm text-cosmic-200">Email</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-2xl border border-white/15 bg-black/20 px-4 py-3 text-cosmic-50 outline-none ring-0 transition placeholder:text-cosmic-400 focus:border-white/35"
                placeholder="you@example.com"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm text-cosmic-200">
                Password
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-2xl border border-white/15 bg-black/20 px-4 py-3 text-cosmic-50 outline-none ring-0 transition placeholder:text-cosmic-400 focus:border-white/35"
                placeholder="Your account password"
              />
            </label>
          </div>

          <div className="mt-5 flex flex-col items-center gap-4">
            <button
              type="submit"
              disabled={!canSubmitCredentials}
              className="rounded-full bg-cosmic-50 px-6 py-3 text-sm font-semibold text-cosmic-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              {status === "auth"
                ? "Signing in..."
                : "Sign in and manage subscription"}
            </button>

            <p className="text-center text-sm leading-relaxed text-cosmic-200">
              New to Uttr?{" "}
              <Link
                href="/claim?source=account"
                className="font-medium text-galaxy-blue transition hover:text-cosmic-50"
              >
                Download the app
              </Link>{" "}
              first, then start your subscription from the app.
            </p>
          </div>
        </form>
      )}

      {error ? (
        <p className="text-center text-sm text-rose-200">{error}</p>
      ) : null}
    </div>
  );
}
