import Link from "next/link";

const FEATURES = [
  {
    title: "Autonomous negotiation",
    body: "A Buyer Agent and a Merchant Agent negotiate price, quantity, and delivery on their own, turn by turn, until they converge.",
  },
  {
    title: "Bounded decisions",
    body: "Every move is chosen by a deterministic rule engine within explicit business constraints — never a free-form model call.",
  },
  {
    title: "Auditable transactions",
    body: "Every observation, decision, and outcome is persisted and can be inspected after the fact, from intent to payment.",
  },
] as const;

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-10 px-6 py-24 text-center sm:py-32">
        <span className="animate-fade-in inline-flex items-center gap-2 rounded-full border border-border px-3.5 py-1 text-xs font-medium tracking-wide text-muted uppercase">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          PACT — Agentic Commerce
        </span>

        <h1
          className="animate-fade-in text-balance text-5xl font-semibold tracking-tight text-foreground sm:text-6xl md:text-7xl"
          style={{ animationDelay: "60ms" }}
        >
          Let AI negotiate the deal.
        </h1>

        <p
          className="animate-fade-in max-w-2xl text-pretty text-lg leading-8 text-muted"
          style={{ animationDelay: "120ms" }}
        >
          Tell PACT what you want to buy. A Buyer Agent negotiates directly with a
          merchant&rsquo;s Agent — bounded by explicit price, quantity, and delivery
          rules — until they reach a deal. Every decision along the way stays
          fully auditable.
        </p>

        <div
          className="animate-fade-in flex flex-col gap-3 sm:flex-row"
          style={{ animationDelay: "180ms" }}
        >
          <Link
            href="/negotiate"
            className="flex h-12 items-center justify-center rounded-full bg-accent px-7 text-base font-medium text-accent-foreground transition-colors hover:brightness-110"
          >
            Start a negotiation
          </Link>
          <Link
            href="/dashboard"
            className="flex h-12 items-center justify-center rounded-full border border-border-strong px-7 text-base font-medium text-foreground transition-colors hover:bg-white/[.04]"
          >
            Merchant console
          </Link>
        </div>

        {/* Minimal buyer <-> merchant agent visual */}
        <div
          className="animate-fade-in mt-6 flex w-full max-w-md items-center justify-between gap-3"
          style={{ animationDelay: "240ms" }}
          aria-hidden
        >
          <AgentBadge label="Buyer Agent" tone="blue" />
          <div className="relative h-px flex-1 bg-border-strong">
            <span className="absolute top-1/2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full bg-accent" />
          </div>
          <AgentBadge label="Merchant Agent" tone="amber" />
        </div>
        <p
          className="animate-fade-in -mt-4 text-xs text-muted"
          style={{ animationDelay: "260ms" }}
        >
          Constraints in. A negotiated, auditable deal out.
        </p>
      </section>

      {/* Feature strip */}
      <section className="border-t border-border">
        <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-px overflow-hidden rounded-none sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-border">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="flex flex-col gap-2 px-8 py-12">
              <h2 className="text-sm font-medium text-foreground">{feature.title}</h2>
              <p className="text-sm leading-6 text-muted">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function AgentBadge({ label, tone }: { label: string; tone: "blue" | "amber" }) {
  const toneClass = tone === "blue" ? "border-blue-500/30 text-blue-300" : "border-yellow-500/30 text-yellow-300";
  return (
    <span className={`rounded-full border bg-surface px-3.5 py-1.5 text-xs font-medium whitespace-nowrap ${toneClass}`}>
      {label}
    </span>
  );
}
