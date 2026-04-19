import { readEnv } from "@/lib/env";

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

type DurableRateLimitRow = {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
};

async function checkWithDurableRateLimit(
  policy: RateLimitPolicy,
): Promise<RateLimitDecision> {
  const url = readEnv("SUPABASE_URL");
  const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(new URL("/rest/v1/rpc/consume_rate_limit", url), {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_rate_limit_key: policy.key,
      p_limit: policy.limit,
      p_window_ms: policy.windowMs,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Supabase rate-limit RPC failed (${response.status}): ${body || response.statusText}`,
    );
  }

  const payload = (await response.json()) as DurableRateLimitRow | DurableRateLimitRow[];
  const row = Array.isArray(payload) ? payload[0] : payload;

  if (
    !row ||
    typeof row.allowed !== "boolean" ||
    typeof row.remaining !== "number" ||
    typeof row.retry_after_seconds !== "number"
  ) {
    throw new Error("Supabase rate-limit RPC returned an invalid payload.");
  }

  if (!row.allowed) {
    return buildDeniedDecision(
      Math.max(1, Math.ceil(row.retry_after_seconds)),
      "durable",
    );
  }

  return buildAllowedDecision(Math.max(0, Math.floor(row.remaining)), "durable");
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
