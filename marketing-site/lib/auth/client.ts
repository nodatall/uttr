"use client";

export type AuthSession = {
  access_token: string;
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

type StoredSessionPreview = {
  expires_at: string;
  user: AuthSession["user"];
};

const STORAGE_KEY = "uttr.session";

function readStoredToken() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem(STORAGE_KEY);
}

function storeSession(session: AuthSession | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!session) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, session.access_token);
}

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  return window.atob(padded);
}

function readStoredSessionPreview(): StoredSessionPreview | null {
  const token = readStoredToken();
  const encodedPayload = token?.split(".")[0];
  if (!encodedPayload) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload)) as {
      sub?: unknown;
      email?: unknown;
      exp?: unknown;
    };
    if (
      typeof payload.sub !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return {
      expires_at: new Date(payload.exp * 1000).toISOString(),
      user: {
        id: payload.sub,
        email: typeof payload.email === "string" ? payload.email : null,
      },
    };
  } catch {
    return null;
  }
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

  storeSession(payload.session);
  return payload.session;
}

export function createAuthClient() {
  return {
    hasStoredSessionToken() {
      return readStoredToken() !== null;
    },

    getStoredSessionPreview() {
      return readStoredSessionPreview();
    },

    async getSession() {
      const token = readStoredToken();
      const response = await fetch("/api/auth/session", {
        method: "GET",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      });
      const payload = await readJson(response);

      if (!response.ok || !payload.session) {
        storeSession(null);
        return null;
      }

      storeSession(payload.session);
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
      storeSession(null);
    },
  };
}
