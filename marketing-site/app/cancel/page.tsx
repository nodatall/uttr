import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { getDownloadUrl } from "@/lib/download";

export default function CancelPage() {
  const downloadUrl = getDownloadUrl();

  return (
    <div className="min-h-screen bg-cosmic-950 text-cosmic-50">
      <SiteNav showPricingLink={false} />

      <main className="mx-auto flex w-full max-w-3xl flex-col px-6 py-12">
        <div className="section-shell rounded-3xl p-8 md:p-10">
          <p className="font-mono text-xs tracking-[0.2em] text-galaxy-blue uppercase">
            Checkout canceled
          </p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight md:text-5xl">
            No worries.
          </h1>
          <p className="mt-5 text-cosmic-200">
            Your subscription was not started. Open Uttr to try again whenever
            you want.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href={downloadUrl}
              className="rounded-full bg-cosmic-50 px-6 py-3 text-sm font-semibold !text-cosmic-950 transition hover:bg-white"
            >
              Download for macOS
            </a>
            <Link
              href="/"
              className="rounded-full border border-white/25 px-6 py-3 text-sm text-cosmic-100 transition hover:border-white/45 hover:text-cosmic-50"
            >
              Back to homepage
            </Link>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
