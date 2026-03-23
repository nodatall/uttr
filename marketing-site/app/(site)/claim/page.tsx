import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { readSupabaseConfig } from "@/lib/env";
import { ClaimFlow } from "./claim-flow";

export const dynamic = "force-dynamic";

export default async function ClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ claim_token?: string; source?: string }>;
}) {
  const params = await searchParams;
  const { url, anonKey } = readSupabaseConfig();

  return (
    <div className="min-h-screen bg-cosmic-950 text-cosmic-50">
      <SiteNav showPricingLink={false} />

      <main className="mx-auto flex w-full max-w-4xl flex-col px-6 py-12">
        <div className="section-shell rounded-3xl p-8 md:p-10">
          <p className="font-mono text-xs tracking-[0.2em] text-galaxy-blue uppercase">
            Account handoff
          </p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight md:text-5xl">
            Sign in, link your install, and continue.
          </h1>
          <p className="mt-5 max-w-2xl text-cosmic-200">
            Create an account or sign in with your existing one. If you opened
            this from the desktop app, we will redeem the claim token and keep
            the blocked install attached to your account before checkout.
          </p>

          <ClaimFlow
            supabaseUrl={url}
            supabaseAnonKey={anonKey}
            initialClaimToken={params.claim_token || null}
            initialSource={params.source || "direct"}
          />
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
