import { GalaxyCanvas } from "@/components/galaxy-canvas";
import { Logo } from "@/components/logo";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { getDownloadUrl } from "@/lib/download";

const quickPoints = [
  "Fast, accurate transcription",
  "Quiet, minimal interface",
  "Works where you write",
];

const flow = ["Trigger", "Speak", "Insert"];

const glanceItems = [
  ["Instant capture", "fast voice-to-text loop"],
  ["File transcription", "turn audio files into clean text"],
  ["Full-system audio", "record meetings in any app"],
  ["Custom prompts", "edit post-processing instructions"],
];

const expandedFeatures = [
  {
    eyebrow: "Dictation",
    title: "Speak into any text field.",
    body: "Use one shortcut to capture your words and insert the transcript where you were already writing.",
  },
  {
    eyebrow: "Files",
    title: "Transcribe recordings later.",
    body: "Drop in an audio file when the meeting, interview, or voice memo already happened.",
  },
  {
    eyebrow: "System audio",
    title: "Record meetings in any app.",
    body: "Capture microphone and system audio together for calls, demos, and long-form desktop sessions.",
  },
  {
    eyebrow: "Post-processing",
    title: "Control the final text.",
    body: "Edit the prompt that cleans up punctuation, formatting, tone, and structure after transcription.",
  },
];

const plans = [
  {
    name: "Free",
    price: "$0",
    description: "For trying Uttr and lightweight dictation.",
    cta: "Download for macOS",
    features: [
      "Desktop speech-to-text",
      "Quick shortcut capture",
      "Transcript history",
      "Local app experience",
    ],
  },
  {
    name: "Pro",
    price: "$5",
    suffix: "/month",
    description: "For using voice as a serious writing and meeting tool.",
    cta: "Download for macOS",
    featured: true,
    features: [
      "Everything in Free",
      "Full-system audio capture",
      "File transcription",
      "Editable post-processing prompt",
      "Longer recordings and meeting workflows",
    ],
  },
];

export default function Home() {
  const downloadUrl = getDownloadUrl();

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
                  <a
                    href={downloadUrl}
                    className="rounded-full bg-white px-8 py-3.5 text-sm font-semibold !text-cosmic-950 transition hover:bg-cosmic-100"
                  >
                    Download for macOS
                  </a>
                </div>
              </div>

              <div className="justify-self-end">
                <div className="glass-panel w-full max-w-[368px] rounded-2xl p-6 text-cosmic-100">
                  <p className="font-mono text-xs tracking-[0.2em] text-cosmic-300 uppercase">
                    Uttr at a glance
                  </p>

                  <div className="mt-5 space-y-4">
                    {glanceItems.map(([title, body]) => (
                      <div key={title}>
                        <p className="text-2xl font-semibold text-white">
                          {title}
                        </p>
                        <p className="text-sm text-cosmic-200/85">{body}</p>
                      </div>
                    ))}
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

            <div className="mt-4 flex flex-wrap gap-2 text-sm text-cosmic-100/90">
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

        <section id="features" className="relative overflow-hidden px-6 py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
          <div className="pointer-events-none absolute left-[-10%] top-20 h-72 w-72 rounded-full bg-galaxy-blue/10 blur-3xl" />
          <div className="relative mx-auto max-w-6xl">
            <div className="max-w-3xl">
              <p className="font-mono text-xs tracking-[0.28em] text-galaxy-pink uppercase">
                Features
              </p>
              <h2 className="mt-4 text-4xl font-semibold tracking-tight text-white md:text-6xl">
                Built for the moments typing gets in the way.
              </h2>
            </div>

            <div className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-white/12 bg-white/10 md:grid-cols-2">
              {expandedFeatures.map((feature) => (
                <article
                  key={feature.title}
                  className="group bg-cosmic-950/80 p-7 transition hover:bg-cosmic-900/85 md:p-9"
                >
                  <p className="font-mono text-xs tracking-[0.22em] text-galaxy-blue uppercase">
                    {feature.eyebrow}
                  </p>
                  <h3 className="mt-5 text-2xl font-semibold text-white md:text-3xl">
                    {feature.title}
                  </h3>
                  <p className="mt-4 max-w-md text-base leading-relaxed text-cosmic-100/72">
                    {feature.body}
                  </p>
                  <div className="mt-8 h-px w-16 bg-gradient-to-r from-galaxy-pink to-galaxy-blue transition group-hover:w-28" />
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="relative px-6 pb-28">
          <div className="relative mx-auto max-w-6xl rounded-[2rem] border border-white/12 bg-[linear-gradient(150deg,rgba(22,27,49,0.92),rgba(5,6,15,0.96))] p-6 shadow-2xl shadow-black/35 md:p-10">
            <div className="flex flex-col justify-between gap-8 md:flex-row md:items-end">
              <div>
                <p className="font-mono text-xs tracking-[0.28em] text-galaxy-pink uppercase">
                  Pricing
                </p>
                <h2 className="mt-4 text-4xl font-semibold tracking-tight text-white md:text-6xl">
                  Start free. Upgrade when voice becomes your workflow.
                </h2>
              </div>
              <p className="max-w-sm text-base leading-relaxed text-cosmic-100/72">
                Two simple options for macOS. Pro unlocks the deeper capture and
                cleanup tools.
              </p>
            </div>

            <div className="mt-10 grid gap-4 md:grid-cols-2">
              {plans.map((plan) => (
                <div
                  key={plan.name}
                  className={`flex flex-col rounded-3xl border p-6 md:p-8 ${
                    plan.featured
                      ? "border-white/20 bg-white text-cosmic-950"
                      : "border-white/14 bg-black/20 text-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p
                        className={`font-mono text-xs tracking-[0.22em] uppercase ${
                          plan.featured ? "text-cosmic-500" : "text-cosmic-300"
                        }`}
                      >
                        {plan.name}
                      </p>
                      <div className="mt-5 flex items-end gap-2">
                        <span className="text-5xl font-semibold tracking-tight">
                          {plan.price}
                        </span>
                        {plan.suffix ? (
                          <span
                            className={`pb-2 text-sm ${
                              plan.featured
                                ? "text-cosmic-700"
                                : "text-cosmic-100/65"
                            }`}
                          >
                            {plan.suffix}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <p
                    className={`mt-5 text-base leading-relaxed ${
                      plan.featured ? "text-cosmic-700" : "text-cosmic-100/72"
                    }`}
                  >
                    {plan.description}
                  </p>

                  <ul className="mt-7 space-y-3 text-sm">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex gap-3">
                        <span
                          className={`mt-1 h-2 w-2 rounded-full ${
                            plan.featured ? "bg-cosmic-950" : "bg-galaxy-blue"
                          }`}
                        />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-auto pt-8">
                    <a
                      href={downloadUrl}
                      className={`inline-flex w-full justify-center rounded-full px-6 py-3 text-sm font-semibold transition ${
                        plan.featured
                          ? "bg-cosmic-950 !text-white hover:bg-cosmic-800"
                          : "border border-white/30 !text-white hover:border-white/60"
                      }`}
                    >
                      {plan.cta}
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
