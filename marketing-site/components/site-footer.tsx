import Link from "next/link";
import { Logo } from "@/components/logo";

const supportEmail =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@uttr.pro";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/12 py-9">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 md:flex-row md:items-center md:justify-between">
        <Link href="/" aria-label="Uttr home">
          <Logo variant="footer" />
        </Link>

        <div className="flex flex-wrap items-center gap-5 text-sm text-cosmic-300/90">
          <Link href="/legal" className="transition hover:text-cosmic-50">
            Terms & Privacy
          </Link>
          <a
            href={`mailto:${supportEmail}`}
            className="transition hover:text-cosmic-50"
          >
            {supportEmail}
          </a>
        </div>
      </div>
    </footer>
  );
}
