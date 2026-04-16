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
    <div className="flex min-h-screen flex-col bg-cosmic-950 text-cosmic-50">
      <SiteNav showPricingLink={false} />

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center px-6 py-12">
        <div className="section-shell w-full rounded-3xl p-8 text-center md:p-10">
          <p className="font-mono text-xs tracking-[0.2em] text-galaxy-blue uppercase">
            Account
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
