"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { createAuthClient, type AuthSession } from "@/lib/auth/client";
import { getDownloadUrl } from "@/lib/download";

async function openBillingPortal() {
  const response = await fetch("/api/billing/portal", {
    method: "POST",
    headers: {
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

type AccountStatus = "idle" | "auth" | "portal" | "logout";

type AccountState = {
  email: string;
  password: string;
  signedInEmail: string | null;
  hasCheckedSession: boolean;
  isCheckingSession: boolean;
  sessionCheckFailed: boolean;
  status: AccountStatus;
  error: string | null;
};

type AccountAction =
  | { type: "email"; email: string }
  | { type: "password"; password: string }
  | { type: "checking_session" }
  | { type: "session_loaded"; email: string | null }
  | { type: "session_failed"; error: string }
  | { type: "session_refresh_requested" }
  | { type: "status"; status: AccountStatus; error?: string | null }
  | { type: "signed_in"; email: string }
  | { type: "signed_out" };

const accountInitialState: AccountState = {
  email: "",
  password: "",
  signedInEmail: null,
  hasCheckedSession: false,
  isCheckingSession: false,
  sessionCheckFailed: false,
  status: "idle",
  error: null,
};

const accountReducer = (
  state: AccountState,
  action: AccountAction,
): AccountState => {
  switch (action.type) {
    case "email":
      return { ...state, email: action.email };
    case "password":
      return { ...state, password: action.password };
    case "checking_session":
      return { ...state, isCheckingSession: true };
    case "session_loaded":
      return {
        ...state,
        signedInEmail: action.email,
        hasCheckedSession: true,
        isCheckingSession: false,
        sessionCheckFailed: false,
        error: state.sessionCheckFailed ? null : state.error,
      };
    case "session_failed":
      return {
        ...state,
        hasCheckedSession: true,
        isCheckingSession: false,
        sessionCheckFailed: true,
        error: action.error,
      };
    case "session_refresh_requested":
      return {
        ...state,
        status:
          state.status === "auth" || state.status === "portal"
            ? "idle"
            : state.status,
      };
    case "status":
      return {
        ...state,
        status: action.status,
        isCheckingSession:
          action.status === "logout" ? false : state.isCheckingSession,
        error: action.error ?? null,
      };
    case "signed_in":
      return {
        ...state,
        signedInEmail: action.email,
        hasCheckedSession: true,
        isCheckingSession: false,
        sessionCheckFailed: false,
        status: "portal",
      };
    case "signed_out":
      return {
        ...state,
        email: "",
        password: "",
        signedInEmail: null,
        hasCheckedSession: true,
        isCheckingSession: false,
        sessionCheckFailed: false,
        status: "idle",
        error: null,
      };
  }
};

export function AccountFlow() {
  const downloadUrl = getDownloadUrl();
  const [auth] = useState(() => createAuthClient());
  const sessionCheckRef = useRef<{
    controller: AbortController;
    promise: Promise<AuthSession | null>;
  } | null>(null);
  const sessionVersionRef = useRef(0);
  const actionInProgressRef = useRef<AccountStatus>("idle");
  const [sessionCheckAttempt, retrySessionCheck] = useState(0);
  const [
    {
      email,
      password,
      signedInEmail,
      hasCheckedSession,
      isCheckingSession,
      sessionCheckFailed,
      status,
      error,
    },
    dispatch,
  ] = useReducer(accountReducer, accountInitialState);
  const canSubmitCredentials =
    status === "idle" && email.trim().length > 0 && password.length > 0;

  useEffect(() => {
    let cancelled = false;

    const getVerifiedSession = () => {
      if (!sessionCheckRef.current) {
        const controller = new AbortController();
        const request = {
          controller,
          promise: auth.getSession({ signal: controller.signal }),
        };
        request.promise = request.promise.finally(() => {
          if (sessionCheckRef.current === request) {
            sessionCheckRef.current = null;
          }
        });
        sessionCheckRef.current = request;
      }

      return sessionCheckRef.current;
    };

    const syncSession = async () => {
      if (actionInProgressRef.current !== "idle") {
        return;
      }
      dispatch({ type: "checking_session" });
      const sessionVersion = sessionVersionRef.current;
      const request = getVerifiedSession();

      try {
        const session = await request.promise;
        if (
          cancelled ||
          request.controller.signal.aborted ||
          actionInProgressRef.current !== "idle" ||
          sessionVersion !== sessionVersionRef.current
        ) {
          return;
        }

        dispatch({
          type: "session_loaded",
          email: session?.user.email ?? null,
        });
      } catch (err) {
        if (
          cancelled ||
          request.controller.signal.aborted ||
          actionInProgressRef.current !== "idle" ||
          sessionVersion !== sessionVersionRef.current
        ) {
          return;
        }

        dispatch({
          type: "session_failed",
          error:
            err instanceof Error
              ? err.message
              : "Unable to check your session.",
        });
      }
    };

    const refreshSession = () => {
      if (actionInProgressRef.current !== "idle") {
        return;
      }
      dispatch({ type: "session_refresh_requested" });
      void syncSession();
    };

    void syncSession();

    window.addEventListener("pageshow", refreshSession);
    window.addEventListener("focus", refreshSession);
    document.addEventListener("visibilitychange", refreshSession);

    return () => {
      cancelled = true;
      sessionCheckRef.current?.controller.abort();
      sessionCheckRef.current = null;
      window.removeEventListener("pageshow", refreshSession);
      window.removeEventListener("focus", refreshSession);
      document.removeEventListener("visibilitychange", refreshSession);
    };
  }, [auth, sessionCheckAttempt]);

  const signIn = async () => {
    if (!canSubmitCredentials || actionInProgressRef.current !== "idle") {
      return;
    }

    actionInProgressRef.current = "auth";
    dispatch({ type: "status", status: "auth" });

    try {
      const session = await auth.signInWithPassword({
        email,
        password,
      });

      sessionVersionRef.current += 1;
      dispatch({ type: "signed_in", email: session.user.email ?? email });
      await openBillingPortal();
    } catch (err) {
      dispatch({
        type: "status",
        status: "idle",
        error: err instanceof Error ? err.message : "Unable to sign in.",
      });
    } finally {
      actionInProgressRef.current = "idle";
    }
  };

  const manageBilling = async () => {
    if (actionInProgressRef.current !== "idle") {
      return;
    }
    actionInProgressRef.current = "portal";
    dispatch({ type: "status", status: "portal" });

    try {
      const session = await auth.getSession();
      if (!session) {
        throw new Error("Sign in to manage your subscription.");
      }

      await openBillingPortal();
    } catch (err) {
      dispatch({
        type: "status",
        status: "idle",
        error:
          err instanceof Error ? err.message : "Unable to open billing portal.",
      });
    } finally {
      actionInProgressRef.current = "idle";
    }
  };

  const logOut = async () => {
    if (actionInProgressRef.current !== "idle") {
      return;
    }
    actionInProgressRef.current = "logout";
    sessionVersionRef.current += 1;
    sessionCheckRef.current?.controller.abort();
    sessionCheckRef.current = null;
    dispatch({ type: "status", status: "logout" });

    try {
      await auth.signOut();

      sessionVersionRef.current += 1;
      dispatch({ type: "signed_out" });
    } catch (err) {
      dispatch({
        type: "status",
        status: "idle",
        error: err instanceof Error ? err.message : "Unable to log out.",
      });
    } finally {
      actionInProgressRef.current = "idle";
    }
  };

  return (
    <div className="mx-auto mt-9 min-h-[17rem] w-full max-w-xl text-left">
      {!hasCheckedSession ? (
        <div aria-busy="true" className="h-[17rem]" />
      ) : sessionCheckFailed && !signedInEmail ? null : signedInEmail ? (
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
                onChange={(event) =>
                  dispatch({ type: "email", email: event.target.value })
                }
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
                onChange={(event) =>
                  dispatch({ type: "password", password: event.target.value })
                }
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
              <a
                href={downloadUrl}
                className="font-medium !text-galaxy-blue transition hover:!text-cosmic-50"
              >
                Download the app
              </a>{" "}
              first, then start your subscription from the app.
            </p>
          </div>
        </form>
      )}

      {error ? (
        <p role="alert" className="text-center text-sm text-rose-200">
          {error}
        </p>
      ) : null}
      {sessionCheckFailed ? (
        <button
          type="button"
          onClick={() => {
            if (actionInProgressRef.current === "idle") {
              retrySessionCheck((attempt) => attempt + 1);
            }
          }}
          disabled={isCheckingSession || status !== "idle"}
          className="mx-auto mt-4 block rounded-full border border-white/20 px-4 py-2 text-sm text-cosmic-100 transition hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isCheckingSession ? "Checking session..." : "Retry"}
        </button>
      ) : null}
    </div>
  );
}
