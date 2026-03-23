import { readSupabaseConfig } from "@/lib/env";
import type {
  AnonymousTrialRow,
  EntitlementRow,
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

export function isAnonymousTrialExpired(trial: {
  status: TrialState;
  trial_ends_at: string | null;
}) {
  if (trial.status !== "trialing" || !trial.trial_ends_at) {
    return false;
  }

  return new Date(trial.trial_ends_at).getTime() <= Date.now();
}
