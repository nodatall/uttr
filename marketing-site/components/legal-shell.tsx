import { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";

export function LegalShell({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-cosmic-950 text-cosmic-50">
      <SiteNav sectionLinks="home" />

      <main className="mx-auto flex w-full max-w-4xl flex-col px-6 py-12">
        <article className="section-shell rounded-3xl p-8 md:p-10">
          <p className="font-mono text-xs tracking-[0.2em] text-cosmic-300 uppercase">
            Last updated {updated}
          </p>
          <h1 className="mt-4 text-4xl font-semibold md:text-5xl">{title}</h1>
          <div className="mt-8 space-y-6 text-base leading-relaxed text-cosmic-200 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-cosmic-50 [&_h3]:text-lg [&_h3]:font-medium [&_h3]:text-cosmic-100 [&_a]:text-galaxy-blue [&_ul]:list-disc [&_ul]:pl-6">
            {children}
          </div>
        </article>
      </main>

      <SiteFooter />
    </div>
  );
}
