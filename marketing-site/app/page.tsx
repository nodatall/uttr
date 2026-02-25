import { CheckoutButton } from "@/components/checkout-button";
import { GalaxyCanvas } from "@/components/galaxy-canvas";
import { Logo } from "@/components/logo";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";

const quickPoints = [
  "One shortcut to start",
  "Fast, accurate transcription",
  "Quiet, minimal interface",
  "Works where you already write",
];

const flow = ["Trigger", "Speak", "Insert"];

export default function Home() {
  return (
    <div className="relative overflow-hidden bg-cosmic-950">
      <div className="noise-mask" />
      <SiteNav overlay />

      <main className="relative z-10">
        <section className="relative min-h-screen overflow-hidden">
          <GalaxyCanvas />
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_58%_42%,rgba(10,14,36,0.08)_0%,rgba(5,7,14,0.54)_58%,rgba(3,5,11,0.8)_100%)]" />
          <Logo
            variant="watermark"
            className="pointer-events-none absolute right-8 top-24 hidden md:flex"
          />

          <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 pb-10 pt-24 md:pt-28">
            <div className="grid flex-1 items-center gap-12 lg:grid-cols-[1.25fr_0.75fr]">
              <div className="max-w-3xl">
                <p className="mb-5 inline-flex rounded-full border border-white/30 bg-black/25 px-3 py-1 text-xs tracking-[0.22em] text-cosmic-100 uppercase backdrop-blur">
                  Speech-to-text for desktop
                </p>

                <h1 className="text-5xl leading-[1.02] font-semibold tracking-tight text-white md:text-7xl lg:text-8xl">
                  Type less.
                  <span className="block">Say more.</span>
                </h1>

                <p className="mt-6 max-w-2xl text-lg leading-relaxed text-cosmic-100/90 md:text-2xl">
                  Press a shortcut. Speak. Your words appear instantly.
                </p>

                <div className="mt-8 flex flex-wrap items-center gap-4">
                  <CheckoutButton
                    source="landing-hero"
                    className="rounded-full bg-white px-8 py-3.5 text-sm font-semibold text-cosmic-950 transition hover:bg-cosmic-100"
                  />
                  <a
                    href="#flow"
                    className="rounded-full border border-white/35 bg-black/20 px-8 py-3.5 text-sm font-medium text-white transition hover:border-white/55"
                  >
                    See how Uttr works
                  </a>
                </div>

              </div>

              <div className="justify-self-end">
                <div className="glass-panel w-full max-w-[320px] rounded-2xl p-6 text-cosmic-100">
                  <p className="font-mono text-xs tracking-[0.2em] text-cosmic-300 uppercase">
                    Uttr at a glance
                  </p>

                  <div className="mt-5 space-y-4">
                    <div>
                      <p className="text-3xl font-semibold text-white">$5/mo</p>
                      <p className="text-sm text-cosmic-200/85">single monthly plan</p>
                    </div>
                    <div>
                      <p className="text-3xl font-semibold text-white">Instant capture</p>
                      <p className="text-sm text-cosmic-200/85">fast voice-to-text loop</p>
                    </div>
                    <div id="pricing">
                      <p className="text-3xl font-semibold text-white">3-step flow</p>
                      <p className="text-sm text-cosmic-200/85">trigger, speak, insert</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div id="flow" className="mt-6 flex flex-wrap items-center gap-3">
              {flow.map((item, index) => (
                <span
                  key={item}
                  className="rounded-full border border-white/28 bg-black/24 px-4 py-2 text-xs tracking-[0.16em] text-cosmic-100 uppercase backdrop-blur"
                >
                  0{index + 1} {item}
                </span>
              ))}
            </div>

            <div id="features" className="mt-4 flex flex-wrap gap-2 text-sm text-cosmic-100/90">
              {quickPoints.map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-white/20 bg-black/20 px-4 py-2 backdrop-blur"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
