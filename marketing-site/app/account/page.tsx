import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { readSupabaseConfig } from "@/lib/env";
import { AccountFlow } from "./account-flow";

export const dynamic = "force-dynamic";

export default function AccountPage() {
  const { url, anonKey } = readSupabaseConfig();

  return (
    <div className="flex min-h-screen flex-col bg-cosmic-950 text-cosmic-50">
      <SiteNav showPricingLink={false} />

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center px-6 py-12">
        <div className="section-shell relative w-full rounded-3xl p-8 text-center md:p-10">
          <p className="font-mono text-xs tracking-[0.2em] text-galaxy-blue uppercase">
            Account
          </p>
          <h1 className="mx-auto mt-4 max-w-2xl text-4xl font-semibold leading-tight md:text-5xl">
            Manage your Uttr subscription.
          </h1>

          <AccountFlow supabaseUrl={url} supabaseAnonKey={anonKey} />
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
