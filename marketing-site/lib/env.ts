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

export function readCheckoutConfig() {
  return {
    stripeSecretKey: readEnv("STRIPE_SECRET_KEY"),
    monthlyPriceId: readEnv("NEXT_PUBLIC_STRIPE_PRICE_ID_MONTHLY"),
    siteUrl: readEnv("NEXT_PUBLIC_SITE_URL"),
  };
}

export function readWebhookConfig() {
  return {
    stripeSecretKey: readEnv("STRIPE_SECRET_KEY"),
    webhookSecret: readEnv("STRIPE_WEBHOOK_SECRET"),
  };
}

export function readEmailConfig() {
  return {
    resendApiKey: readOptionalEnv("RESEND_API_KEY"),
    from: readOptionalEnv("EMAIL_FROM") || "Uttr <noreply@uttr.app>",
    supportEmail: readOptionalEnv("EMAIL_SUPPORT") || "support@uttr.app",
  };
}
