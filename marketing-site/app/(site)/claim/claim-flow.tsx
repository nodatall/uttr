"use client";

import { useEffect, useState } from "react";
import { createAuthClient, type AuthSession } from "@/lib/auth/client";
import { getDownloadUrl } from "@/lib/download";
import {
  resolveClaimConversionClientDecision,
  type ClaimConversionClientPayload,
} from "@/lib/access/claim-conversion-client";

type AuthMode = "signin" | "signup";

type ClaimFlowProps = {
  initialClaimToken: string | null;
  initialSource: string;
};

const DEV_ACCOUNT = {
  email: "dev@dev.com",
  password: "123456",
} as const;

const SHOW_DEV_ACCOUNT_SHORTCUT = process.env.NODE_ENV !== "production";

async function continueCheckoutFlow({
  session,
  initialClaimToken,
  initialSource,
}: {
  session: AuthSession;
  initialClaimToken: string | null;
  initialSource: string;
}) {
  if (!session.access_token) {
    throw new Error("Session is missing an access token.");
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
    const linkPayload = (await linkResponse
      .json()
      .catch(() => ({}))) as ClaimConversionClientPayload;
    const linkDecision = resolveClaimConversionClientDecision(linkPayload);

    if (linkDecision.kind === "redirect") {
      window.location.assign(linkDecision.returnUrl);
      return;
    }

    if (linkDecision.kind === "error") {
      throw new Error(linkDecision.message);
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

  if (payload.already_entitled && payload.return_url) {
    window.location.assign(payload.return_url);
    return;
  }

  if (!checkoutResponse.ok) {
    throw new Error(payload.error || "Unable to start checkout right now.");
  }

  if (!payload.url) {
    throw new Error(payload.error || "Unable to start checkout right now.");
  }

  window.location.assign(payload.url);
}

export function ClaimFlow({
  initialClaimToken,
  initialSource,
}: ClaimFlowProps) {
  const downloadUrl = getDownloadUrl();
  const [auth] = useState(() => createAuthClient());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [status, setStatus] = useState<"idle" | "auth" | "link" | "checkout">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<AuthSession | null>(null);
  const canSubmitCredentials =
    status === "idle" && email.trim().length > 0 && password.length > 0;

  const finishAuthenticatedSession = async (
    session: AuthSession,
    fallbackEmail: string,
  ) => {
    setActiveSession(session);
    setSignedInEmail(session.user.email ?? fallbackEmail);
    setStatus(initialClaimToken ? "link" : "checkout");
    await continueCheckoutFlow({
      session,
      initialClaimToken,
      initialSource,
    });
  };

  const signInOrCreateDevAccount = async () => {
    try {
      return await auth.signInWithPassword(DEV_ACCOUNT);
    } catch (signInError) {
      try {
        return await auth.signUp(DEV_ACCOUNT);
      } catch (signUpError) {
        try {
          return await auth.signInWithPassword(DEV_ACCOUNT);
        } catch (retryError) {
          throw new Error(
            signInError instanceof Error
              ? signInError.message
              : signUpError instanceof Error
                ? signUpError.message
                : retryError instanceof Error
                  ? retryError.message
                  : "Unable to create the development account.",
          );
        }
      }
    }
  };

  useEffect(() => {
    let cancelled = false;

    void auth.getSession().then(async (session) => {
      if (cancelled || !session) {
        return;
      }

      setActiveSession(session);
      setSignedInEmail(session.user.email ?? null);
      setError(null);
      setStatus("idle");
    });

    return () => {
      cancelled = true;
    };
  }, [auth, initialClaimToken, initialSource]);

  const submit = async (mode: AuthMode) => {
    if (!canSubmitCredentials) {
      return;
    }

    setAuthMode(mode);
    setStatus("auth");
    setError(null);

    try {
      const session =
        mode === "signup"
          ? await auth.signUp({
              email,
              password,
            })
          : await auth.signInWithPassword({
              email,
              password,
            });

      await finishAuthenticatedSession(session, email);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Authentication failed.";
      setError(message);
      setStatus("idle");
    }
  };

  const handleDevAccount = async () => {
    setEmail(DEV_ACCOUNT.email);
    setPassword(DEV_ACCOUNT.password);
    setAuthMode("signin");
    setStatus("auth");
    setError(null);

    try {
      const session = await signInOrCreateDevAccount();
      await finishAuthenticatedSession(session, DEV_ACCOUNT.email);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Development login failed.";
      setError(message);
      setStatus("idle");
    }
  };

  const continueWithCurrentAccount = async () => {
    if (!activeSession) {
      setError("Sign in or create an account before checkout.");
      return;
    }

    setError(null);
    setStatus(initialClaimToken ? "link" : "checkout");

    try {
      await continueCheckoutFlow({
        session: activeSession,
        initialClaimToken,
        initialSource,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Checkout failed.";
      setError(message);
      setStatus("idle");
    }
  };

  const handleDifferentAccount = async () => {
    await auth.signOut();
    setActiveSession(null);
    setSignedInEmail(null);
    setEmail("");
    setPassword("");
    setStatus("idle");
    setError(null);
  };

  if (!initialClaimToken) {
    return (
      <div className="mx-auto mt-8 w-full max-w-xl space-y-5 text-center">
        <h1 className="text-4xl font-semibold leading-tight md:text-5xl">
          Download Uttr first.
        </h1>
        <p className="mx-auto max-w-lg text-sm leading-relaxed text-cosmic-200">
          New to Uttr? Download the desktop app, use the trial, then start your
          subscription from inside the app so Pro is linked to your install.
        </p>
        <a
          href={downloadUrl}
          className="inline-flex rounded-full bg-cosmic-50 px-6 py-3 text-sm font-semibold !text-cosmic-950 transition hover:bg-white"
        >
          Download for macOS
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-8 w-full max-w-xl space-y-4 text-left">
      {activeSession && signedInEmail ? (
        <div>
          <p className="text-sm text-cosmic-100">
            Signed in as <strong>{signedInEmail}</strong>.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void continueWithCurrentAccount()}
              disabled={status !== "idle"}
              className="rounded-full bg-cosmic-50 px-6 py-3 text-sm font-semibold text-cosmic-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              {status === "link"
                ? "Linking install..."
                : status === "checkout"
                  ? "Starting checkout..."
                  : "Continue to checkout"}
            </button>
            <button
              type="button"
              onClick={() => void handleDifferentAccount()}
              disabled={status !== "idle"}
              className="rounded-full border border-white/20 px-6 py-3 text-sm text-cosmic-100 transition hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-70"
            >
              Use different account
            </button>
          </div>
        </div>
      ) : (
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
              autoComplete={
                authMode === "signup" ? "new-password" : "current-password"
              }
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
              disabled={!canSubmitCredentials}
              className="rounded-full bg-cosmic-50 px-6 py-3 text-sm font-semibold text-cosmic-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              {status === "auth" && authMode === "signup"
                ? "Creating account..."
                : "Create account"}
            </button>
            <button
              type="button"
              onClick={() => void submit("signin")}
              disabled={!canSubmitCredentials}
              className="rounded-full border border-white/20 px-6 py-3 text-sm text-cosmic-100 transition hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {status === "auth" && authMode === "signin"
                ? "Signing in..."
                : "Sign in"}
            </button>
            {SHOW_DEV_ACCOUNT_SHORTCUT ? (
              <button
                type="button"
                onClick={() => void handleDevAccount()}
                disabled={status !== "idle"}
                className="rounded-full border border-galaxy-blue/40 bg-galaxy-blue/10 px-6 py-3 text-sm text-galaxy-blue transition hover:border-galaxy-blue/70 hover:bg-galaxy-blue/20 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {status === "auth" &&
                authMode === "signin" &&
                email === DEV_ACCOUNT.email
                  ? "Opening dev account..."
                  : "Use dev account"}
              </button>
            ) : null}
          </div>
          {SHOW_DEV_ACCOUNT_SHORTCUT ? (
            <p className="text-xs text-cosmic-300">
              Local dev shortcut: <strong>{DEV_ACCOUNT.email}</strong> /{" "}
              <strong>{DEV_ACCOUNT.password}</strong>. The account is created on
              first use.
            </p>
          ) : null}
        </div>
      )}

      {error ? <p className="text-sm text-rose-200">{error}</p> : null}

      {status !== "idle" ? (
        <p className="text-sm text-cosmic-100">
          {status === "auth"
            ? "Authenticating account..."
            : status === "link"
              ? "Linking install..."
              : "Starting checkout..."}
        </p>
      ) : null}
    </div>
  );
}
