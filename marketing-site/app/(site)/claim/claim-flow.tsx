"use client";

import { useEffect, useReducer, useState } from "react";
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

type ClaimStatus = "idle" | "auth" | "link" | "checkout";

type ClaimState = {
  email: string;
  password: string;
  authMode: AuthMode;
  status: ClaimStatus;
  error: string | null;
  signedInEmail: string | null;
  activeSession: AuthSession | null;
};

type ClaimAction =
  | { type: "email"; email: string }
  | { type: "password"; password: string }
  | { type: "auth_started"; mode: AuthMode }
  | { type: "session_loaded"; session: AuthSession }
  | { type: "checkout_started"; status: "link" | "checkout" }
  | { type: "error"; message: string }
  | { type: "different_account" };

const claimInitialState: ClaimState = {
  email: "",
  password: "",
  authMode: "signup",
  status: "idle",
  error: null,
  signedInEmail: null,
  activeSession: null,
};

const claimReducer = (
  state: ClaimState,
  action: ClaimAction,
): ClaimState => {
  switch (action.type) {
    case "email":
      return { ...state, email: action.email };
    case "password":
      return { ...state, password: action.password };
    case "auth_started":
      return { ...state, authMode: action.mode, status: "auth", error: null };
    case "session_loaded":
      return {
        ...state,
        activeSession: action.session,
        signedInEmail: action.session.user.email ?? null,
        status: "idle",
        error: null,
      };
    case "checkout_started":
      return { ...state, status: action.status, error: null };
    case "error":
      return { ...state, status: "idle", error: action.message };
    case "different_account":
      return {
        ...state,
        activeSession: null,
        signedInEmail: null,
        email: "",
        password: "",
        status: "idle",
        error: null,
      };
  }
};

async function continueCheckoutFlow({
  initialClaimToken,
  initialSource,
}: {
  initialClaimToken: string | null;
  initialSource: string;
}) {
  if (initialClaimToken) {
    const linkResponse = await fetch("/api/auth/convert-anonymous", {
      method: "POST",
      headers: {
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
  const [
    { email, password, authMode, status, error, signedInEmail, activeSession },
    dispatch,
  ] = useReducer(claimReducer, claimInitialState);
  const canSubmitCredentials =
    status === "idle" && email.trim().length > 0 && password.length > 0;

  const finishAuthenticatedSession = async (
    session: AuthSession,
    fallbackEmail: string,
  ) => {
    dispatch({
      type: "session_loaded",
      session: {
        ...session,
        user: { ...session.user, email: session.user.email ?? fallbackEmail },
      },
    });
    dispatch({
      type: "checkout_started",
      status: initialClaimToken ? "link" : "checkout",
    });
    await continueCheckoutFlow({
      initialClaimToken,
      initialSource,
    });
  };

  useEffect(() => {
    let cancelled = false;

    void auth.getSession().then(async (session) => {
      if (cancelled || !session) {
        return;
      }

      dispatch({ type: "session_loaded", session });
    });

    return () => {
      cancelled = true;
    };
  }, [auth, initialClaimToken, initialSource]);

  const submit = async (mode: AuthMode) => {
    if (!canSubmitCredentials) {
      return;
    }

    dispatch({ type: "auth_started", mode });

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
      dispatch({ type: "error", message });
    }
  };

  const continueWithCurrentAccount = async () => {
    if (!activeSession) {
      dispatch({
        type: "error",
        message: "Sign in or create an account before checkout.",
      });
      return;
    }

    dispatch({
      type: "checkout_started",
      status: initialClaimToken ? "link" : "checkout",
    });

    try {
      await continueCheckoutFlow({
        initialClaimToken,
        initialSource,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Checkout failed.";
      dispatch({ type: "error", message });
    }
  };

  const handleDifferentAccount = async () => {
    await auth.signOut();
    dispatch({ type: "different_account" });
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
              onChange={(event) =>
                dispatch({ type: "email", email: event.target.value })
              }
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
              onChange={(event) =>
                dispatch({ type: "password", password: event.target.value })
              }
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
          </div>
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
