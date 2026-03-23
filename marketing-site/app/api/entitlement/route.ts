import { NextResponse } from "next/server";
import type { InstallTokenPayload } from "@/lib/access";
import {
  fetchAnonymousTrialById,
  fetchEntitlementByUserId,
  readInstallTokenFromRequest,
  refreshAnonymousTrialState,
  resolveAccessDecision,
  verifyInstallToken,
} from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const installToken = readInstallTokenFromRequest(request);
    if (!installToken) {
      return NextResponse.json(
        { error: "Missing install token." },
        { status: 400 },
      );
    }

    let tokenPayload: InstallTokenPayload;
    try {
      tokenPayload = verifyInstallToken(installToken);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Invalid install token.",
        },
        { status: 401 },
      );
    }

    const trial = await fetchAnonymousTrialById(tokenPayload.anonymous_trial_id);

    if (
      !trial ||
      trial.install_id !== tokenPayload.install_id ||
      trial.device_fingerprint_hash !== tokenPayload.device_fingerprint_hash
    ) {
      return NextResponse.json(
        { error: "Invalid install token." },
        { status: 401 },
      );
    }

    const refreshedTrial = await refreshAnonymousTrialState(trial);
    const entitlement = refreshedTrial.user_id
      ? await fetchEntitlementByUserId(refreshedTrial.user_id)
      : null;
    const accessDecision = resolveAccessDecision(refreshedTrial, entitlement);

    return NextResponse.json({
      access_state: accessDecision.accessState,
      trial_state: accessDecision.trialState,
      entitlement_state: accessDecision.entitlementState,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "entitlement_lookup_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Could not resolve entitlement." },
      { status: 500 },
    );
  }
}
