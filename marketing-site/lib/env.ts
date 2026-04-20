export function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

export function readOptionalEnv(name: string): string | null {
  return process.env[name] || null;
}

export function readSiteConfig() {
  return {
    siteUrl: readEnv("NEXT_PUBLIC_SITE_URL"),
    supportEmail: readOptionalEnv("NEXT_PUBLIC_SUPPORT_EMAIL") || "support@uttr.app",
  };
}

export function readStripeConfig() {
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
    from: readOptionalEnv("EMAIL_FROM") || "Uttr <noreply@uttr.app>",
    supportEmail: readOptionalEnv("EMAIL_SUPPORT") || siteConfig.supportEmail,
  };
}

export function readCloudProxyConfig() {
  return {
    groqApiKey: readEnv("GROQ_API_KEY"),
    groqModelDefault: readOptionalEnv("GROQ_TRANSCRIPTION_MODEL_DEFAULT") || "whisper-large-v3",
  };
}

export function readAccessTokenConfig() {
  return {
    installTokenSecret: readEnv("UTTR_INSTALL_TOKEN_SECRET"),
    claimTokenSecret: readEnv("UTTR_CLAIM_TOKEN_SECRET"),
  };
}

export function readSessionConfig() {
  return {
    sessionSecret: readEnv("UTTR_SESSION_SECRET"),
  };
}
