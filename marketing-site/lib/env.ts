export function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function isProductionRuntime() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL === "1" ||
    process.env.RAILWAY_ENVIRONMENT !== undefined ||
    process.env.FLY_APP_NAME !== undefined
  );
}

export function readSecretEnv(name: string): string {
  const value = readEnv(name);
  if (!isProductionRuntime()) {
    return value;
  }

  const trimmed = value.trim();
  const unsafeValues = new Set([
    "replace-with-a-long-random-secret",
    "install-secret-test",
    "claim-secret-test",
    "test-session-secret-with-enough-entropy",
  ]);
  const unsafePattern =
    /\b(test|example|dummy|placeholder|change-?me|replace)\b/i;

  if (
    trimmed.length < 32 ||
    unsafeValues.has(trimmed) ||
    unsafePattern.test(trimmed)
  ) {
    throw new Error(
      `Environment variable ${name} must be a strong production secret.`,
    );
  }

  return value;
}

export function readOptionalEnv(name: string): string | null {
  return process.env[name] || null;
}

export function readSiteConfig() {
  return {
    siteUrl: readEnv("NEXT_PUBLIC_SITE_URL"),
    supportEmail:
      readOptionalEnv("NEXT_PUBLIC_SUPPORT_EMAIL") || "support@uttr.pro",
  };
}

function readStripeConfig() {
  return {
    stripeSecretKey: readEnv("STRIPE_SECRET_KEY"),
    monthlyPriceId: readEnv("NEXT_PUBLIC_STRIPE_PRICE_ID_MONTHLY"),
    webhookSecret: readEnv("STRIPE_WEBHOOK_SECRET"),
  };
}

export function readCheckoutConfig() {
  const stripeConfig = readStripeConfig();
  const siteConfig = readSiteConfig();

  return {
    stripeSecretKey: stripeConfig.stripeSecretKey,
    monthlyPriceId: stripeConfig.monthlyPriceId,
    siteUrl: siteConfig.siteUrl,
  };
}

export function readWebhookConfig() {
  const stripeConfig = readStripeConfig();

  return {
    stripeSecretKey: stripeConfig.stripeSecretKey,
    webhookSecret: stripeConfig.webhookSecret,
  };
}

export function readEmailConfig() {
  const siteConfig = readSiteConfig();

  return {
    resendApiKey: readOptionalEnv("RESEND_API_KEY"),
    from: readOptionalEnv("EMAIL_FROM") || "Uttr <noreply@uttr.pro>",
    supportEmail: readOptionalEnv("EMAIL_SUPPORT") || siteConfig.supportEmail,
  };
}

export function readCloudProxyConfig() {
  return {
    groqApiKey: readEnv("GROQ_API_KEY"),
    groqModelDefault:
      readOptionalEnv("GROQ_TRANSCRIPTION_MODEL_DEFAULT") || "whisper-large-v3",
  };
}

export function readOpenAiSummaryConfig() {
  return {
    openAiApiKey: readEnv("OPENAI_API_KEY"),
    openAiSummaryModelDefault:
      readOptionalEnv("OPENAI_SUMMARY_MODEL_DEFAULT") || "gpt-4o-mini",
  };
}

export function readAccessTokenConfig() {
  return {
    installTokenSecret: readSecretEnv("UTTR_INSTALL_TOKEN_SECRET"),
    claimTokenSecret: readSecretEnv("UTTR_CLAIM_TOKEN_SECRET"),
  };
}

function readBooleanEnv(name: string, defaultValue = false) {
  const value = readOptionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function readDiagnosticsConfig() {
  const disabled = readBooleanEnv("UTTR_DIAGNOSTICS_DISABLED", false);

  return {
    identitySecret: disabled
      ? readOptionalEnv("UTTR_DIAGNOSTICS_IDENTITY_SECRET") || "diagnostics-disabled"
      : readSecretEnv("UTTR_DIAGNOSTICS_IDENTITY_SECRET"),
    disabled,
  };
}
