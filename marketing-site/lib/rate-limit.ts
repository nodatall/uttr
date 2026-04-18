type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

export type RateLimitPolicy = {
  key: string;
  limit: number;
  windowMs: number;
};

export function rateLimitKeyFromRequest(request: Request, scope: string) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ip =
    forwardedFor?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";

  return `${scope}:${ip}`;
}

export function checkRateLimit(policy: RateLimitPolicy, now = Date.now()) {
  const current = buckets.get(policy.key);

  if (!current || current.resetAt <= now) {
    buckets.set(policy.key, {
      count: 1,
      resetAt: now + policy.windowMs,
    });
    return { allowed: true, remaining: Math.max(policy.limit - 1, 0) };
  }

  if (current.count >= policy.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((current.resetAt - now) / 1000),
      ),
    };
  }

  current.count += 1;
  return {
    allowed: true,
    remaining: Math.max(policy.limit - current.count, 0),
  };
}

export function resetRateLimitForTests() {
  buckets.clear();
}
