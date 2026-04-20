import { dbQuery } from "@/lib/db";

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
const DEFAULT_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;

export type RateLimitPolicy = {
  key: string;
  limit: number;
  windowMs: number;
};

export type RateLimitDecision =
  | {
      allowed: true;
      remaining: number;
      source: "memory" | "durable";
    }
  | {
      allowed: false;
      remaining: 0;
      retryAfterSeconds: number;
      source: "memory" | "durable" | "unavailable";
    };

export type RateLimitBlockedDecision = Extract<
  RateLimitDecision,
  { allowed: false }
>;

export function resolveRateLimitFailure(
  rateLimit: RateLimitBlockedDecision,
  exhaustedMessage: string,
) {
  if (rateLimit.source === "unavailable") {
    return {
      status: 503,
      error: "Rate limiting is temporarily unavailable.",
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    };
  }

  return {
    status: 429,
    error: exhaustedMessage,
    retryAfterSeconds: rateLimit.retryAfterSeconds,
  };
}

export function rateLimitKeyFromRequest(request: Request, scope: string) {
  // This trusts the app edge/proxy boundary to normalize forwarded headers.
  // Keep this derivation centralized so routes do not each reinterpret client IPs.
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ip =
    forwardedFor?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";

  return `${scope}:${ip}`;
}

function buildAllowedDecision(
  remaining: number,
  source: "memory" | "durable",
): RateLimitDecision {
  return {
    allowed: true,
    remaining,
    source,
  };
}

function buildDeniedDecision(
  retryAfterSeconds: number,
  source: "memory" | "durable" | "unavailable",
): RateLimitDecision {
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds,
    source,
  };
}

function buildRetryAfterSeconds(windowMs: number) {
  return Math.max(1, Math.ceil(windowMs / 1000));
}

function checkInMemoryRateLimit(
  policy: RateLimitPolicy,
  now = Date.now(),
): RateLimitDecision {
  const current = buckets.get(policy.key);

  if (!current || current.resetAt <= now) {
    buckets.set(policy.key, {
      count: 1,
      resetAt: now + policy.windowMs,
    });
    return buildAllowedDecision(Math.max(policy.limit - 1, 0), "memory");
  }

  if (current.count >= policy.limit) {
    return buildDeniedDecision(
      Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      "memory",
    );
  }

  current.count += 1;
  return buildAllowedDecision(
    Math.max(policy.limit - current.count, 0),
    "memory",
  );
}

async function checkWithDurableRateLimit(
  policy: RateLimitPolicy,
): Promise<RateLimitDecision> {
  if (policy.limit <= 0) {
    return buildDeniedDecision(buildRetryAfterSeconds(policy.windowMs), "durable");
  }

  const result = await dbQuery<{
    count: number;
    reset_at: string | Date;
  }>(
    `insert into public.rate_limit_buckets as rate_limit_buckets (
       rate_limit_key,
       count,
       reset_at,
       updated_at
     )
     values (
       $1,
       1,
       now() + ($2::double precision * interval '1 millisecond'),
       now()
     )
     on conflict (rate_limit_key) do update
       set count = case
         when rate_limit_buckets.reset_at <= now() then 1
         else rate_limit_buckets.count + 1
       end,
       reset_at = case
         when rate_limit_buckets.reset_at <= now()
           then now() + ($2::double precision * interval '1 millisecond')
         else rate_limit_buckets.reset_at
       end,
       updated_at = now()
     returning count, reset_at`,
    [policy.key, policy.windowMs],
  );

  const row = result.rows[0];

  if (
    !row ||
    typeof row.count !== "number" ||
    !row.reset_at
  ) {
    throw new Error("Durable rate-limit store returned an invalid payload.");
  }

  if (row.count > policy.limit) {
    const resetAtMs = new Date(row.reset_at).getTime();
    return buildDeniedDecision(
      Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000)),
      "durable",
    );
  }

  return buildAllowedDecision(Math.max(policy.limit - row.count, 0), "durable");
}

function failClosedRateLimit(policy: RateLimitPolicy): RateLimitDecision {
  return buildDeniedDecision(
    buildRetryAfterSeconds(
      Math.max(policy.windowMs, DEFAULT_UNAVAILABLE_RETRY_AFTER_SECONDS * 1000),
    ),
    "unavailable",
  );
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production";
}

export async function checkRateLimit(
  policy: RateLimitPolicy,
  now = Date.now(),
): Promise<RateLimitDecision> {
  if (!isProductionRuntime()) {
    return checkInMemoryRateLimit(policy, now);
  }

  try {
    return await checkWithDurableRateLimit(policy);
  } catch {
    return failClosedRateLimit(policy);
  }
}

export function resetRateLimitForTests() {
  buckets.clear();
}
