import Image from "next/image";
import { cn } from "@/lib/utils";

type LogoProps = {
  variant?: "nav" | "watermark" | "footer";
  className?: string;
};

export function Logo({ variant = "nav", className }: LogoProps) {
  if (variant === "watermark") {
    return (
      <div
        className={cn(
          "pointer-events-none select-none opacity-28",
          "flex items-center gap-5",
          className,
        )}
        aria-hidden="true"
      >
        <Image
          src="/uttr-icon.png"
          alt=""
          width={112}
          height={112}
          className="h-24 w-24 rounded-2xl object-cover"
        />
        <span className="text-7xl font-semibold tracking-[0.22em] text-cosmic-100/80">
          UTTR
        </span>
      </div>
    );
  }

  if (variant === "footer") {
    return (
      <div className={cn("flex items-center gap-3", className)}>
        <Image
          src="/uttr-icon.png"
          alt="Uttr"
          width={34}
          height={34}
          className="h-8 w-8 rounded-lg object-cover"
        />
        <span className="text-xl font-medium tracking-[0.18em] text-cosmic-100">
          UTTR
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Image
        src="/uttr-icon.png"
        alt="Uttr"
        width={42}
        height={42}
        className="h-10 w-10 rounded-xl object-cover"
        priority
      />
      <span className="text-xl font-semibold tracking-[0.16em] text-cosmic-50">
        UTTR
      </span>
    </div>
  );
}
