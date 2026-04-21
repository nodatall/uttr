"use client";

export type AuthSession = {
  expires_at: string;
  user: {
    id: string;
    email: string | null;
  };
};

type AuthResponse = {
  session?: AuthSession;
  error?: string;
};

const STORAGE_KEY = "uttr.session";

function clearLegacyStoredToken() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(STORAGE_KEY);
}

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as AuthResponse;
}

async function requestSession(
  path: string,
  init: RequestInit = {},
): Promise<AuthSession> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const payload = await readJson(response);

  if (!response.ok || !payload.session) {
    throw new Error(payload.error || "Authentication failed.");
  }

  clearLegacyStoredToken();
  return payload.session;
}

export function createAuthClient() {
  return {
    async getSession() {
      const response = await fetch("/api/auth/session", {
        method: "GET",
      });
      const payload = await readJson(response);

      if (!response.ok || !payload.session) {
        clearLegacyStoredToken();
        return null;
      }

      clearLegacyStoredToken();
      return payload.session;
    },

    async signInWithPassword(params: { email: string; password: string }) {
      return requestSession("/api/auth/signin", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    async signUp(params: { email: string; password: string }) {
      return requestSession("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    async signOut() {
      await fetch("/api/auth/signout", { method: "POST" }).catch(() => null);
      clearLegacyStoredToken();
    },
  };
}
