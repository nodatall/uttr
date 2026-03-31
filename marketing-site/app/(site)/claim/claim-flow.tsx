"use client";

import { createClient, type Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

type AuthMode = "signin" | "signup";

type ClaimFlowProps = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  initialClaimToken: string | null;
  initialSource: string;
};

async function readJsonError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  return payload.error || "Request failed.";
}

async function continueCheckoutFlow({
  session,
  initialClaimToken,
  initialSource,
}: {
  session: Session;
  initialClaimToken: string | null;
  initialSource: string;
}) {
  if (!session.access_token) {
    throw new Error("Supabase session is missing an access token.");
  }

  if (initialClaimToken) {
    const linkResponse = await fetch("/api/auth/convert-anonymous", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ claim_token: initialClaimToken }),
    });

    if (!linkResponse.ok && linkResponse.status !== 409) {
      throw new Error(await readJsonError(linkResponse));
    }
  }

  const checkoutResponse = await fetch("/api/checkout", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      claim_token: initialClaimToken ?? undefined,
      source: initialSource,
    }),
  });

  const payload = (await checkoutResponse.json().catch(() => ({}))) as {
    already_entitled?: boolean;
    error?: string;
    return_url?: string;
    url?: string;
  };

  if (!checkoutResponse.ok) {
    throw new Error(payload.error || "Unable to start checkout right now.");
  }

  if (payload.already_entitled && payload.return_url) {
    window.location.assign(payload.return_url);
    return;
  }

  if (!payload.url) {
    throw new Error(payload.error || "Unable to start checkout right now.");
  }

  window.location.assign(payload.url);
}

export function ClaimFlow({
  supabaseUrl,
  supabaseAnonKey,
  initialClaimToken,
  initialSource,
}: ClaimFlowProps) {
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
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [status, setStatus] = useState<"idle" | "auth" | "link" | "checkout">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void supabase.auth.getSession().then(async ({ data }) => {
      if (cancelled || !data.session) {
        return;
      }

      setSignedInEmail(data.session.user.email ?? null);
      setError(null);

      try {
        setStatus(initialClaimToken ? "link" : "checkout");
        await continueCheckoutFlow({
          session: data.session,
          initialClaimToken,
          initialSource,
        });
      } catch (err) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "Checkout failed.";
          setError(message);
          setStatus("idle");
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [supabase, initialClaimToken, initialSource]);

  const submit = async (mode: AuthMode) => {
    setAuthMode(mode);
    setStatus("auth");
    setError(null);

    try {
      const result =
        mode === "signup"
          ? await supabase.auth.signUp({
              email,
              password,
            })
          : await supabase.auth.signInWithPassword({
              email,
              password,
            });

      const session = result.data.session;
      if (!session) {
        throw new Error(
          result.error?.message ||
            "Supabase did not return an active session for this account.",
        );
      }

      setSignedInEmail(session.user.email ?? email);
      setStatus(initialClaimToken ? "link" : "checkout");
      await continueCheckoutFlow({
        session,
        initialClaimToken,
        initialSource,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed.";
      setError(message);
      setStatus("idle");
    }
  };

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="space-y-4">
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
          <span className="mb-2 block text-sm text-cosmic-200">Password</span>
          <input
            type="password"
            autoComplete={authMode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-2xl border border-white/15 bg-black/20 px-4 py-3 text-cosmic-50 outline-none ring-0 transition placeholder:text-cosmic-400 focus:border-white/35"
            placeholder="Use at least 6 characters"
          />
        </label>

        <div className="flex flex-wrap gap-3 pt-2">
          <button
            type="button"
            onClick={() => void submit("signup")}
            disabled={status !== "idle"}
            className="rounded-full bg-cosmic-50 px-6 py-3 text-sm font-semibold text-cosmic-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-70"
          >
            {status === "auth" && authMode === "signup"
              ? "Creating account..."
              : "Create account"}
          </button>
          <button
            type="button"
            onClick={() => void submit("signin")}
            disabled={status !== "idle"}
            className="rounded-full border border-white/20 px-6 py-3 text-sm text-cosmic-100 transition hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {status === "auth" && authMode === "signin"
              ? "Signing in..."
              : "Sign in"}
          </button>
        </div>

        {error ? <p className="text-sm text-rose-200">{error}</p> : null}
      </div>

      <div className="glass-panel rounded-2xl p-6">
        <p className="font-mono text-xs tracking-[0.2em] text-cosmic-300 uppercase">
          Flow
        </p>
        <ol className="mt-4 space-y-3 text-sm text-cosmic-100/90">
          <li>1. Sign in or create an account.</li>
          <li>2. Link the claim token from the blocked install, if present.</li>
          <li>3. Continue to Stripe Checkout with the linked install metadata.</li>
        </ol>
        <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-cosmic-200">
          {initialClaimToken ? (
            <p>The desktop app claim token is ready to redeem.</p>
          ) : (
            <p>No claim token detected. You can still sign in and start checkout.</p>
          )}
          {signedInEmail ? (
            <p className="mt-3 text-cosmic-100">
              Signed in as <strong>{signedInEmail}</strong>.
            </p>
          ) : null}
          {status !== "idle" ? (
            <p className="mt-3 text-cosmic-100">
              {status === "auth"
                ? "Authenticating account..."
                : status === "link"
                  ? "Linking install..."
                  : "Starting checkout..."}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
