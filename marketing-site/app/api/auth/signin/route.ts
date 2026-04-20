import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authenticateUserWithPassword,
  buildSessionCookie,
  createAuthSession,
} from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(1024),
});

export async function POST(request: Request) {
  const parsedBody = requestSchema.safeParse(await request.json().catch(() => ({})));
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
    { session },
    {
      headers: {
        "set-cookie": buildSessionCookie(session),
      },
    },
  );
}
