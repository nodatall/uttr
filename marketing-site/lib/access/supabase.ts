import { readSupabaseConfig } from "@/lib/env";
import type {
  AnonymousTrialRow,
  EntitlementRow,
  SupabaseUser,
  TrialClaimRow,
  UsageEventRow,
  TrialState,
} from "./types";

function buildRestUrl(table: string, query?: Record<string, string>) {
  const { url } = readSupabaseConfig();
  const endpoint = new URL(`/rest/v1/${table}`, url);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      endpoint.searchParams.set(key, value);
    }
  }

  return endpoint;
}

async function parseJsonArray(response: Response): Promise<unknown[]> {
  const payload = (await response.json()) as unknown[] | unknown;
  return Array.isArray(payload) ? payload : [payload];
}

async function supabaseRequest(
  table: string,
  init: RequestInit,
  query?: Record<string, string>,
) {
  const { serviceRoleKey } = readSupabaseConfig();
  const response = await fetch(buildRestUrl(table, query), {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Supabase request failed for ${table} (${response.status}): ${body || response.statusText}`,
    );
  }

  return response;
}

function firstOrNull<T>(rows: T[]) {
  return rows[0] ?? null;
}

async function parseJsonObject<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function fetchAnonymousTrialByInstallId(
  installId: string,
) {
  const response = await supabaseRequest(
    "anonymous_trials",
    { method: "GET" },
    {
      select: "*",
      install_id: `eq.${installId}`,
      limit: "1",
    },
  );

  return firstOrNull(
    (await parseJsonArray(response)) as AnonymousTrialRow[],
  );
}

export async function fetchAnonymousTrialById(id: string) {
  const response = await supabaseRequest(
    "anonymous_trials",
    { method: "GET" },
    {
      select: "*",
      id: `eq.${id}`,
      limit: "1",
    },
  );

  return firstOrNull(
    (await parseJsonArray(response)) as AnonymousTrialRow[],
  );
}

export async function fetchTrialClaimByHash(claimTokenHash: string) {
  const response = await supabaseRequest(
    "trial_claims",
    { method: "GET" },
    {
      select: "*",
      claim_token_hash: `eq.${claimTokenHash}`,
      limit: "1",
    },
  );

  return firstOrNull((await parseJsonArray(response)) as TrialClaimRow[]);
}

export async function insertTrialClaim(
  row: Omit<TrialClaimRow, "created_at" | "redeemed_at">,
) {
  const response = await supabaseRequest(
    "trial_claims",
    {
      method: "POST",
      body: JSON.stringify(row),
      headers: {
        prefer: "return=representation",
      },
    },
    {
      select: "*",
    },
  );

  return firstOrNull((await parseJsonArray(response)) as TrialClaimRow[]);
}

export async function upsertAnonymousTrialHeartbeat(params: {
  installId: string;
  deviceFingerprintHash: string;
  lastSeenAt: string;
}) {
  const response = await supabaseRequest(
    "anonymous_trials",
    {
      method: "POST",
      body: JSON.stringify({
        install_id: params.installId,
        device_fingerprint_hash: params.deviceFingerprintHash,
        last_seen_at: params.lastSeenAt,
      }),
      headers: {
        prefer: "resolution=merge-duplicates,return=representation",
      },
    },
    {
      on_conflict: "install_id",
      select: "*",
    },
  );

  return firstOrNull(
    (await parseJsonArray(response)) as AnonymousTrialRow[],
  );
}

export async function patchAnonymousTrialById(
  id: string,
  patch: Partial<
    Pick<
      AnonymousTrialRow,
      | "device_fingerprint_hash"
      | "last_seen_at"
      | "status"
      | "trial_started_at"
      | "trial_ends_at"
      | "user_id"
    >
  >,
) {
  const response = await supabaseRequest(
    "anonymous_trials",
    {
      method: "PATCH",
      body: JSON.stringify(patch),
      headers: {
        prefer: "return=representation",
      },
    },
    {
      id: `eq.${id}`,
      select: "*",
    },
  );

  return firstOrNull(
    (await parseJsonArray(response)) as AnonymousTrialRow[],
  );
}

export async function insertUsageEvent(
  row: Omit<UsageEventRow, "id" | "created_at">,
) {
  const response = await supabaseRequest(
    "usage_events",
    {
      method: "POST",
      body: JSON.stringify(row),
      headers: {
        prefer: "return=representation",
      },
    },
    {
      select: "*",
    },
  );

  return firstOrNull((await parseJsonArray(response)) as UsageEventRow[]);
}

export async function fetchSupabaseUser(accessToken: string) {
  const { url, anonKey } = readSupabaseConfig();
  const response = await fetch(new URL("/auth/v1/user", url), {
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Supabase auth request failed (${response.status}): ${body || response.statusText}`,
    );
  }

  const payload = await parseJsonObject<Partial<SupabaseUser>>(response);
  if (typeof payload.id !== "string") {
    throw new Error("Supabase auth response missing user id.");
  }

  return {
    id: payload.id,
    email: typeof payload.email === "string" ? payload.email : null,
  } satisfies SupabaseUser;
}

export async function fetchEntitlementByUserId(userId: string) {
  const response = await supabaseRequest(
    "entitlements",
    { method: "GET" },
    {
      select: "*",
      user_id: `eq.${userId}`,
      limit: "1",
    },
  );

  return firstOrNull((await parseJsonArray(response)) as EntitlementRow[]);
}

export async function upsertEntitlementState(
  row: Omit<EntitlementRow, "updated_at">,
) {
  const response = await supabaseRequest(
    "entitlements",
    {
      method: "POST",
      body: JSON.stringify(row),
      headers: {
        prefer: "resolution=merge-duplicates,return=representation",
      },
    },
    {
      on_conflict: "user_id",
      select: "*",
    },
  );

  return firstOrNull((await parseJsonArray(response)) as EntitlementRow[]);
}

export async function redeemTrialClaim(params: {
  claimTokenHash: string;
  userId: string;
}) {
  const response = await supabaseRequest(
    "rpc/redeem_trial_claim",
    {
      method: "POST",
      body: JSON.stringify({
        p_claim_token_hash: params.claimTokenHash,
        p_user_id: params.userId,
      }),
    },
  );

  return parseJsonObject<AnonymousTrialRow>(response);
}

export function isAnonymousTrialExpired(trial: {
  status: TrialState;
  trial_ends_at: string | null;
}) {
  if (trial.status !== "trialing" || !trial.trial_ends_at) {
    return false;
  }

  return new Date(trial.trial_ends_at).getTime() <= Date.now();
}
