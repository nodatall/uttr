import { NextResponse } from "next/server";
import { buildClearSessionCookie } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { signed_out: true },
    {
      headers: {
        "set-cookie": buildClearSessionCookie(),
      },
    },
  );
}
