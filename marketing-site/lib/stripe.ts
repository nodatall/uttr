import Stripe from "stripe";

let stripeClient: Stripe | null = null;

export function getStripe(secretKey: string) {
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey, {
      apiVersion: "2026-01-28.clover",
    });
  }

  return stripeClient;
}
