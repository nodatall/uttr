import Stripe from "stripe";

let stripeClient: Stripe | null = null;

export const STRIPE_API_VERSION = "2026-03-25.dahlia";

export function getStripe(secretKey: string) {
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION,
    });
  }

  return stripeClient;
}

type BuildCheckoutMetadataInput = {
  source: string;
  userId: string;
  anonymousTrialId?: string | null;
  installId?: string | null;
};

export function buildCheckoutMetadata({
  source,
  userId,
  anonymousTrialId = null,
  installId = null,
}: BuildCheckoutMetadataInput) {
  const metadata: Record<string, string> = {
    source,
    user_id: userId,
  };

  if (anonymousTrialId) {
    metadata.anonymous_trial_id = anonymousTrialId;
  }

  if (installId) {
    metadata.install_id = installId;
  }

  return metadata;
}
