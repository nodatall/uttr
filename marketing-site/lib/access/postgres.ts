import { dbQuery, dbTransaction, type DbExecutor } from "@/lib/db";
import { readUserById, verifySessionToken } from "@/lib/auth/server";
import type {
  AnonymousTrialRow,
  AuthenticatedUser,
  CheckoutSessionRow,
  EntitlementRow,
  TrialClaimRow,
  TrialState,
  UsageEventRow,
} from "./types";

function firstOrNull<T>(rows: T[]) {
  return rows[0] ?? null;
}

function normalizeRow<T>(row: T): T {
  if (!row || typeof row !== "object") {
    return row;
  }

  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  ) as T;
}

function normalizeRows<T>(rows: T[]) {
  return rows.map((row) => normalizeRow(row));
}

async function queryRows<T>(
  sql: string,
  values: readonly unknown[] = [],
  executor: DbExecutor = { query: dbQuery },
) {
  const result = await executor.query<T>(sql, values);
  return normalizeRows(result.rows);
}

export function buildPendingCheckoutSessionContextKey(params: {
  userId: string;
  anonymousTrialId: string | null;
  installId: string | null;
}) {
  return [
    `user_id:${params.userId}`,
    `anonymous_trial_id:${params.anonymousTrialId ?? "null"}`,
    `install_id:${params.installId ?? "null"}`,
  ].join("|");
}

function isReusableCheckoutSession(row: CheckoutSessionRow) {
  return row.status === "open" && new Date(row.expires_at).getTime() > Date.now();
}

function buildPendingCheckoutSessionRow(params: {
  userId: string;
  anonymousTrialId: string | null;
  installId: string | null;
  stripeCheckoutSessionId: string;
  stripeCustomerId: string | null;
  checkoutUrl: string;
  expiresAt: string;
}) {
  return {
    checkout_context_key: buildPendingCheckoutSessionContextKey(params),
    user_id: params.userId,
    anonymous_trial_id: params.anonymousTrialId,
    install_id: params.installId,
    stripe_checkout_session_id: params.stripeCheckoutSessionId,
    stripe_customer_id: params.stripeCustomerId,
    status: "open" as const,
    checkout_url: params.checkoutUrl,
    expires_at: params.expiresAt,
  };
}

export async function fetchAnonymousTrialByInstallId(
  installId: string,
) {
  const rows = await queryRows<AnonymousTrialRow>(
    `select *
       from public.anonymous_trials
      where install_id = $1
      limit 1`,
    [installId],
  );

  return firstOrNull(rows);
}

export async function fetchAnonymousTrialById(id: string) {
  const rows = await queryRows<AnonymousTrialRow>(
    `select *
       from public.anonymous_trials
      where id = $1
      limit 1`,
    [id],
  );

  return firstOrNull(rows);
}

export async function fetchTrialClaimByHash(claimTokenHash: string) {
  const rows = await queryRows<TrialClaimRow>(
    `select *
       from public.trial_claims
      where claim_token_hash = $1
      limit 1`,
    [claimTokenHash],
  );

  return firstOrNull(rows);
}

export async function insertTrialClaim(
  row: Omit<TrialClaimRow, "created_at" | "redeemed_at">,
) {
  const rows = await queryRows<TrialClaimRow>(
    `insert into public.trial_claims (
       id,
       anonymous_trial_id,
       claim_token_hash,
       expires_at
     )
     values ($1, $2, $3, $4)
     returning *`,
    [row.id, row.anonymous_trial_id, row.claim_token_hash, row.expires_at],
  );

  return firstOrNull(rows);
}

export async function upsertAnonymousTrialHeartbeat(params: {
  installId: string;
  deviceFingerprintHash: string;
  lastSeenAt: string;
}) {
  const rows = await queryRows<AnonymousTrialRow>(
    `insert into public.anonymous_trials (
       install_id,
       device_fingerprint_hash,
       last_seen_at
     )
     values ($1, $2, $3)
     on conflict (install_id) do update
       set device_fingerprint_hash = excluded.device_fingerprint_hash,
           last_seen_at = excluded.last_seen_at
     returning *`,
    [params.installId, params.deviceFingerprintHash, params.lastSeenAt],
  );

  return firstOrNull(rows);
}

const anonymousTrialPatchColumns = [
  "device_fingerprint_hash",
  "last_seen_at",
  "status",
  "trial_started_at",
  "trial_ends_at",
  "user_id",
] as const;

type AnonymousTrialPatchColumn = (typeof anonymousTrialPatchColumns)[number];

export async function patchAnonymousTrialById(
  id: string,
  patch: Partial<Pick<AnonymousTrialRow, AnonymousTrialPatchColumn>>,
) {
  const entries = anonymousTrialPatchColumns
    .filter((column) => patch[column] !== undefined)
    .map((column) => [column, patch[column]] as const);

  if (entries.length === 0) {
    return fetchAnonymousTrialById(id);
  }

  const setClauses = entries.map(
    ([column], index) => `${column} = $${index + 2}`,
  );
  const values = [id, ...entries.map(([, value]) => value)];
  const rows = await queryRows<AnonymousTrialRow>(
    `update public.anonymous_trials
        set ${setClauses.join(", ")}
      where id = $1
      returning *`,
    values,
  );

  return firstOrNull(rows);
}

export async function insertUsageEvent(
  row: Omit<UsageEventRow, "id" | "created_at">,
) {
  const rows = await queryRows<UsageEventRow>(
    `insert into public.usage_events (
       anonymous_trial_id,
       user_id,
       source,
       audio_seconds
     )
     values ($1, $2, $3, $4)
     returning *`,
    [row.anonymous_trial_id, row.user_id, row.source, row.audio_seconds],
  );

  return firstOrNull(rows);
}

export async function fetchUsageEventsSince(params: {
  anonymousTrialId: string;
  since: string;
}) {
  return queryRows<UsageEventRow>(
    `select *
       from public.usage_events
      where anonymous_trial_id = $1
        and created_at >= $2`,
    [params.anonymousTrialId, params.since],
  );
}

export async function fetchAuthenticatedUser(
  accessToken: string,
): Promise<AuthenticatedUser> {
  const payload = verifySessionToken(accessToken);
  const user = await readUserById(payload.sub);
  if (!user) {
    throw new Error("Session user was not found.");
  }

  return user;
}

export async function fetchEntitlementByUserId(userId: string) {
  const rows = await queryRows<EntitlementRow>(
    `select *
       from public.entitlements
      where user_id = $1
      limit 1`,
    [userId],
  );

  return firstOrNull(rows);
}

export async function upsertEntitlementState(
  row: Omit<EntitlementRow, "updated_at">,
) {
  const rows = await queryRows<EntitlementRow>(
    `insert into public.entitlements (
       user_id,
       subscription_status,
       stripe_customer_id,
       stripe_subscription_id,
       current_period_ends_at
     )
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update
       set subscription_status = excluded.subscription_status,
           stripe_customer_id = excluded.stripe_customer_id,
           stripe_subscription_id = excluded.stripe_subscription_id,
           current_period_ends_at = excluded.current_period_ends_at
     returning *`,
    [
      row.user_id,
      row.subscription_status,
      row.stripe_customer_id,
      row.stripe_subscription_id,
      row.current_period_ends_at,
    ],
  );

  return firstOrNull(rows);
}

export async function fetchReusableOpenCheckoutSession(params: {
  userId: string;
  anonymousTrialId: string | null;
  installId: string | null;
}) {
  const rows = await queryRows<CheckoutSessionRow>(
    `select *
       from public.checkout_sessions
      where checkout_context_key = $1
        and status = 'open'
      order by updated_at desc
      limit 10`,
    [buildPendingCheckoutSessionContextKey(params)],
  );

  return rows.find((row) => isReusableCheckoutSession(row)) ?? null;
}

export async function insertPendingCheckoutSession(params: {
  userId: string;
  anonymousTrialId: string | null;
  installId: string | null;
  stripeCheckoutSessionId: string;
  stripeCustomerId: string | null;
  checkoutUrl: string;
  expiresAt: string;
}) {
  const row = buildPendingCheckoutSessionRow(params);
  const rows = await queryRows<CheckoutSessionRow>(
    `insert into public.checkout_sessions (
       checkout_context_key,
       user_id,
       anonymous_trial_id,
       install_id,
       stripe_checkout_session_id,
       stripe_customer_id,
       status,
       checkout_url,
       expires_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      row.checkout_context_key,
      row.user_id,
      row.anonymous_trial_id,
      row.install_id,
      row.stripe_checkout_session_id,
      row.stripe_customer_id,
      row.status,
      row.checkout_url,
      row.expires_at,
    ],
  );

  return firstOrNull(rows);
}

async function patchCheckoutSessionByStripeSessionId(
  stripeCheckoutSessionId: string,
  patch: Pick<CheckoutSessionRow, "status">,
) {
  const rows = await queryRows<CheckoutSessionRow>(
    `update public.checkout_sessions
        set status = $2
      where stripe_checkout_session_id = $1
      returning *`,
    [stripeCheckoutSessionId, patch.status],
  );

  return firstOrNull(rows);
}

export async function markPendingCheckoutSessionCompleted(
  stripeCheckoutSessionId: string,
) {
  return patchCheckoutSessionByStripeSessionId(stripeCheckoutSessionId, {
    status: "completed",
  });
}

export async function markPendingCheckoutSessionExpired(
  stripeCheckoutSessionId: string,
) {
  return patchCheckoutSessionByStripeSessionId(stripeCheckoutSessionId, {
    status: "expired",
  });
}

export async function patchEntitlementByStripeSubscriptionId(
  stripeSubscriptionId: string,
  patch: Partial<
    Pick<
      EntitlementRow,
      | "subscription_status"
      | "stripe_customer_id"
      | "current_period_ends_at"
    >
  >,
) {
  const patchColumns = [
    "subscription_status",
    "stripe_customer_id",
    "current_period_ends_at",
  ] as const;
  const entries = patchColumns
    .filter((column) => patch[column] !== undefined)
    .map((column) => [column, patch[column]] as const);

  if (entries.length === 0) {
    return null;
  }

  const setClauses = entries.map(
    ([column], index) => `${column} = $${index + 2}`,
  );
  const values = [stripeSubscriptionId, ...entries.map(([, value]) => value)];
  const rows = await queryRows<EntitlementRow>(
    `update public.entitlements
        set ${setClauses.join(", ")}
      where stripe_subscription_id = $1
      returning *`,
    values,
  );

  return firstOrNull(rows);
}

export async function redeemTrialClaim(params: {
  claimTokenHash: string;
  userId: string;
}) {
  return dbTransaction(async (client) => {
    const claimRows = await queryRows<TrialClaimRow>(
      `select *
         from public.trial_claims
        where claim_token_hash = $1
        limit 1
        for update`,
      [params.claimTokenHash],
      client,
    );
    const claim = firstOrNull(claimRows);
    if (!claim) {
      throw new Error("Claim token not found.");
    }
    if (claim.redeemed_at) {
      throw new Error("Claim token already redeemed.");
    }
    if (new Date(claim.expires_at).getTime() <= Date.now()) {
      throw new Error("Claim token expired.");
    }

    await client.query(
      `update public.trial_claims
          set redeemed_at = now()
        where id = $1
          and redeemed_at is null`,
      [claim.id],
    );

    const trialRows = await queryRows<AnonymousTrialRow>(
      `update public.anonymous_trials
          set user_id = $2,
              status = 'linked'
        where id = $1
          and (user_id is null or user_id = $2)
        returning *`,
      [claim.anonymous_trial_id, params.userId],
      client,
    );
    const trial = firstOrNull(trialRows);
    if (!trial) {
      throw new Error("Claim token already linked to a different user.");
    }

    return trial;
  });
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
