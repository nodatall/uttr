import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildSessionCookie,
  createAuthSession,
  createUserWithPassword,
} from "@/lib/auth/server";

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

export async function POST(request: Request) {
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
