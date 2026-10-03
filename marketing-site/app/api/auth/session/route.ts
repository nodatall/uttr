import { NextResponse } from "next/server";
import {
  buildSessionCookie,
  createAuthSession,
  publicAuthSession,
  readUserById,
  verifySessionToken,
} from "@/lib/auth/server";
import { readAccessTokenFromRequest } from "@/lib/access";
import { readSecretEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const accessToken = readAccessTokenFromRequest(request);
  if (!accessToken) {
    return NextResponse.json({ error: "Missing session." }, { status: 401 });
  }

  try {
    readSecretEnv("UTTR_SESSION_SECRET");
    let payload: ReturnType<typeof verifySessionToken>;
    try {
      payload = verifySessionToken(accessToken);
    } catch {
      return NextResponse.json({ error: "Invalid session." }, { status: 401 });
    }
    const user = await readUserById(payload.sub);
    if (!user) {
      return NextResponse.json({ error: "Invalid session." }, { status: 401 });
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
  } catch {
    console.error(
      JSON.stringify({ level: "error", event: "account_session_unavailable" }),
    );
    return NextResponse.json(
      { error: "Unable to check your session." },
      { status: 503 },
    );
  }
}
