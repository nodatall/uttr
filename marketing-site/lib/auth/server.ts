import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { dbQuery } from "@/lib/db";
import { readEnv } from "@/lib/env";
import type { AuthenticatedUser } from "@/lib/access/types";

const scryptAsync = promisify(scrypt);
const PASSWORD_KEY_LENGTH = 64;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_COOKIE_NAME = "uttr_session";

type SessionPayload = {
  sub: string;
  email: string | null;
  iat: number;
  exp: number;
};

export type AuthSession = {
  access_token: string;
  expires_at: string;
  user: AuthenticatedUser;
};

function base64UrlEncode(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scryptAsync(
    password,
    salt,
    PASSWORD_KEY_LENGTH,
  )) as Buffer;

  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, passwordHash: string) {
  const [algorithm, salt, expectedHash] = passwordHash.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHash) {
    return false;
  }

  const actual = (await scryptAsync(
    password,
    salt,
    PASSWORD_KEY_LENGTH,
  )) as Buffer;
  const expected = Buffer.from(expectedHash, "base64url");

  return (
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

function signPayload(encodedPayload: string) {
  return createHmac("sha256", readEnv("UTTR_SESSION_SECRET"))
    .update(encodedPayload)
    .digest("base64url");
}

function createSessionToken(user: AuthenticatedUser) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: user.id,
    email: user.email,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_MAX_AGE_SECONDS,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function verifySessionToken(token: string): SessionPayload {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    throw new Error("Invalid session token.");
  }

  const expectedSignature = signPayload(encodedPayload);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new Error("Invalid session token signature.");
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<SessionPayload>;
  if (
    typeof payload.sub !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("Invalid session token payload.");
  }

  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Session token expired.");
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    iat: payload.iat,
    exp: payload.exp,
  };
}

async function readUserByEmail(email: string) {
  const result = await dbQuery<{
    id: string;
    email: string;
    password_hash: string;
  }>(
    "select id, email, password_hash from public.profiles where lower(email) = lower($1) limit 1",
    [email],
  );

  return result.rows[0] ?? null;
}

export async function readUserById(id: string) {
  const result = await dbQuery<AuthenticatedUser>(
    "select id, email from public.profiles where id = $1 limit 1",
    [id],
  );

  return result.rows[0] ?? null;
}

export async function createUserWithPassword(params: {
  email: string;
  password: string;
}) {
  const passwordHash = await hashPassword(params.password);
  const result = await dbQuery<AuthenticatedUser>(
    `insert into public.profiles (email, password_hash)
     values ($1, $2)
     returning id, email`,
    [params.email, passwordHash],
  );

  return result.rows[0];
}

export async function authenticateUserWithPassword(params: {
  email: string;
  password: string;
}) {
  const user = await readUserByEmail(params.email);
  if (!user || !(await verifyPassword(params.password, user.password_hash))) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
  } satisfies AuthenticatedUser;
}

export async function createAuthSession(user: AuthenticatedUser): Promise<AuthSession> {
  const accessToken = createSessionToken(user);
  const payload = verifySessionToken(accessToken);

  return {
    access_token: accessToken,
    expires_at: new Date(payload.exp * 1000).toISOString(),
    user,
  };
}

export function buildSessionCookie(session: AuthSession) {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.access_token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    process.env.NODE_ENV === "production" ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function buildClearSessionCookie() {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    process.env.NODE_ENV === "production" ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function readSessionCookieName() {
  return SESSION_COOKIE_NAME;
}
