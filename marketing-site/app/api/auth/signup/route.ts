import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildSessionCookie,
  createAuthSession,
  createUserWithPassword,
} from "@/lib/auth/server";
import {
  checkRateLimit,
  rateLimitKeyFromRequest,
  resolveRateLimitFailure,
  type RateLimitBlockedDecision,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(6).max(1024),
});

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function respondToRateLimit(rateLimit: RateLimitBlockedDecision) {
  const failure = resolveRateLimitFailure(
    rateLimit,
    "Too many account creation attempts.",
  );

  return NextResponse.json(
    { error: failure.error },
    {
      status: failure.status,
      headers: {
        "retry-after": String(failure.retryAfterSeconds),
      },
    },
  );
}

export async function POST(request: Request) {
  const rateLimit = await checkRateLimit({
    key: rateLimitKeyFromRequest(request, "account-signup"),
    limit: 5,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return respondToRateLimit(rateLimit);
  }

  const parsedBody = requestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Use a valid email and a password with at least 6 characters." },
      { status: 400 },
    );
  }

  try {
    const user = await createUserWithPassword(parsedBody.data);
    const session = await createAuthSession(user);

    return NextResponse.json(
      { session },
      {
        headers: {
          "set-cookie": buildSessionCookie(session),
        },
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        { error: "An account already exists for that email." },
        { status: 409 },
      );
    }

    console.error(
      JSON.stringify({
        level: "error",
        event: "account_signup_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Could not create account." },
      { status: 500 },
    );
  }
}
