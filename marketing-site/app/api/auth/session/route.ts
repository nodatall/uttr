import { NextResponse } from "next/server";
import {
  buildSessionCookie,
  createAuthSession,
  publicAuthSession,
  readUserById,
  verifySessionToken,
} from "@/lib/auth/server";
import { readAccessTokenFromRequest } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const accessToken = readAccessTokenFromRequest(request);
  if (!accessToken) {
    return NextResponse.json({ error: "Missing session." }, { status: 401 });
  }

  try {
    const payload = verifySessionToken(accessToken);
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
    return NextResponse.json({ error: "Invalid session." }, { status: 401 });
  }
}
