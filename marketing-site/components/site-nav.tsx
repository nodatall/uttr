import Link from "next/link";
import { Logo } from "@/components/logo";

export function SiteNav({
  showPricingLink = true,
  overlay = false,
}: {
  showPricingLink?: boolean;
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
          {showPricingLink ? (
            <>
              <a
                href="#features"
                className="hidden cursor-pointer transition hover:text-cosmic-50 md:inline"
              >
                Features
              </a>
              <a
                href="#pricing"
                className="hidden cursor-pointer transition hover:text-cosmic-50 md:inline"
              >
                Pricing
              </a>
              <Link
                href="/account"
                className="hidden cursor-pointer transition hover:text-cosmic-50 md:inline"
              >
                Account
              </Link>
            </>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
