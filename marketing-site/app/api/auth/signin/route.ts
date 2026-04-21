import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authenticateUserWithPassword,
  buildSessionCookie,
  createAuthSession,
  publicAuthSession,
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
  password: z.string().min(1).max(1024),
});

function respondToRateLimit(rateLimit: RateLimitBlockedDecision) {
  const failure = resolveRateLimitFailure(
    rateLimit,
    "Too many sign-in attempts.",
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
    key: rateLimitKeyFromRequest(request, "account-signin"),
    limit: 10,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return respondToRateLimit(rateLimit);
  }

  const parsedBody = requestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid sign-in payload." },
      { status: 400 },
    );
  }

  const user = await authenticateUserWithPassword(parsedBody.data);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  const session = await createAuthSession(user);
  return NextResponse.json(
    { session: publicAuthSession(session) },
    {
      headers: {
        "set-cookie": buildSessionCookie(session),
      },
    },
  );
}
