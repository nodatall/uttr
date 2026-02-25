import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { readCheckoutConfig } from "@/lib/env";
import { getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

async function loadCheckoutSession(sessionId: string) {
  try {
    const { stripeSecretKey } = readCheckoutConfig();
    const stripe = getStripe(stripeSecretKey);

    return await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });
  } catch {
    return null;
  }
}

export default async function SuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const params = await searchParams;
  const sessionId = params.session_id || null;

  const session = sessionId ? await loadCheckoutSession(sessionId) : null;
  const customerEmail = session?.customer_details?.email || "your email";

  return (
    <div className="min-h-screen bg-cosmic-950 text-cosmic-50">
      <SiteNav showPricingLink={false} />

      <main className="mx-auto flex w-full max-w-3xl flex-col px-6 py-12">
        <div className="section-shell rounded-3xl p-8 md:p-10">
          <p className="font-mono text-xs tracking-[0.2em] text-galaxy-blue uppercase">
            Subscription confirmed
          </p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight md:text-5xl">
            You&apos;re in.
          </h1>
          <p className="mt-5 text-cosmic-200">
            Thanks for subscribing to Uttr Pro at <strong>$5/month</strong>.
            A confirmation has been sent to <strong>{customerEmail}</strong>.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/"
              className="rounded-full bg-cosmic-50 px-6 py-3 text-sm font-semibold text-cosmic-950 transition hover:bg-white"
            >
              Back to homepage
            </Link>
            <a
              href="mailto:support@uttr.app"
              className="rounded-full border border-white/25 px-6 py-3 text-sm text-cosmic-100 transition hover:border-white/45 hover:text-cosmic-50"
            >
              Contact support
            </a>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
