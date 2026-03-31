import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fetchEntitlementByUserId,
  refreshAnonymousTrialState,
  resolveAccessDecision,
  signInstallToken,
  upsertAnonymousTrialHeartbeat,
} from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  install_id: z.string().min(1).max(200),
  device_fingerprint_hash: z.string().min(1).max(200),
  app_version: z.string().min(1).max(100),
});

export async function POST(request: Request) {
  try {
    const parsedBody = requestSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid bootstrap payload." },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const trial = await upsertAnonymousTrialHeartbeat({
      installId: parsedBody.data.install_id,
      deviceFingerprintHash: parsedBody.data.device_fingerprint_hash,
      lastSeenAt: now,
    });

    if (!trial) {
      return NextResponse.json(
        { error: "Unable to create trial state." },
        { status: 500 },
      );
    }

    const refreshedTrial = await refreshAnonymousTrialState(trial);
    const entitlement = refreshedTrial.user_id
      ? await fetchEntitlementByUserId(refreshedTrial.user_id)
      : null;
    const accessDecision = resolveAccessDecision(refreshedTrial, entitlement);
    const installToken = signInstallToken({
      version: 1,
      anonymous_trial_id: refreshedTrial.id,
      install_id: refreshedTrial.install_id,
      device_fingerprint_hash: refreshedTrial.device_fingerprint_hash,
      issued_at: now,
    });

    return NextResponse.json({
      trial_state: accessDecision.trialState,
      access_state: accessDecision.accessState,
      install_token: installToken,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "trial_bootstrap_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Could not bootstrap install state." },
      { status: 500 },
    );
  }
}
