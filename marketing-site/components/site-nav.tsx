import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";

type SectionLinkTarget = "current" | "home";

function SectionLink({
  hash,
  target,
  children,
}: {
  hash: string;
  target: SectionLinkTarget;
  children: ReactNode;
}) {
  const className =
    "hidden cursor-pointer transition hover:text-cosmic-50 md:inline";

  if (target === "home") {
    return (
      <Link href={`/#${hash}`} className={className}>
        {children}
      </Link>
    );
  }

  return (
    <a href={`#${hash}`} className={className}>
      {children}
    </a>
  );
}

export function SiteNav({
  sectionLinks = "current",
  overlay = false,
}: {
  sectionLinks?: SectionLinkTarget;
  overlay?: boolean;
}) {
  const headerClass = overlay
    ? "fixed top-0 left-0 right-0 z-40 border-b border-white/10 bg-cosmic-950/35 backdrop-blur-xl"
    : "sticky top-0 z-40 border-b border-white/10 bg-cosmic-950/65 backdrop-blur-xl";

  return (
    <header className={headerClass}>
      <div className="mx-auto flex h-20 w-full max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          aria-label="Uttr home"
          className="cursor-pointer transition hover:opacity-90"
        >
          <Logo variant="nav" />
        </Link>

        <nav className="flex items-center gap-4 text-sm text-cosmic-100/90">
          <SectionLink hash="features" target={sectionLinks}>
            Features
          </SectionLink>
          <SectionLink hash="pricing" target={sectionLinks}>
            Pricing
          </SectionLink>
          <Link
            href="/account"
            className="hidden cursor-pointer transition hover:text-cosmic-50 md:inline"
          >
            Account
          </Link>
        </nav>
      </div>
    </header>
  );
}
