import Link from "next/link";
import { HeroField } from "./HeroField";

const FEATURES = [
  {
    index: "01",
    title: "Autonomous negotiation",
    body: "A Buyer Agent and a Merchant Agent negotiate price, quantity, and delivery on their own, turn by turn, until they converge — no human in the loop.",
  },
  {
    index: "02",
    title: "Bounded decisions",
    body: "Every move is chosen by a deterministic rule engine within explicit business constraints — never a free-form model call, never an unbounded price.",
  },
  {
    index: "03",
    title: "Auditable transactions",
    body: "Every observation, decision, and outcome is persisted and can be inspected after the fact, from intent to Razorpay settlement.",
  },
] as const;

// Purely illustrative, static example numbers — this page never calls
// the negotiation API. It exists to show the SHAPE of a completed
// negotiation (what each agent knew, what they converged on), not to
// simulate one running live. See AgentSnapshot's own doc comment for
// why the merchant side never shows a private floor here either.
const HERO_EXAMPLE = {
  buyer: {
    rows: [
      ["Budget", "₹46,000"],
      ["Quantity", "10 units"],
      ["Delivery", "≤ 6 days"],
      ["Current offer", "₹45,000"],
    ],
  },
  merchant: {
    rows: [
      ["Listed price", "₹48,000"],
      ["Stock", "10 units"],
      ["Max delivery", "12 days"],
      ["Current offer", "₹47,373"],
    ],
  },
  round: "Round 6 of 6",
  deal: { total: "₹46,000", terms: "10 units · 6 days delivery" },
} as const;

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      {/* Hero — deliberately NOT animated: this is the critical,
          above-the-fold content, rendered instantly on first paint as
          plain server-rendered HTML with zero JS dependency. Only the
          decorative background (HeroField, a small client island) needs
          hydration — the headline/copy/CTAs never wait on it. */}
      <section className="relative flex min-h-[88vh] flex-col overflow-hidden">
        <HeroField />
        <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center gap-16 px-6 py-20 lg:flex-row lg:items-center lg:justify-between lg:gap-16">
          <div className="flex max-w-xl flex-col items-start gap-7 text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-border px-3.5 py-1 text-xs font-medium tracking-wide text-muted uppercase">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              PACT · Autonomous Commerce
            </span>

            <h1 className="text-display-1 text-balance font-semibold text-foreground">Let AI negotiate the deal.</h1>

            <p className="max-w-lg text-pretty text-lg leading-8 text-muted">
              A Buyer Agent negotiates directly with a Merchant Agent — bounded by explicit
              price, quantity, and delivery constraints — until they reach a deal. Every
              decision along the way stays fully auditable, through settlement.
            </p>

            <div className="flex flex-col gap-3 sm:flex-row">
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
          </div>

          <FlowStory />
        </div>
      </section>

      {/* Illustrative negotiation snapshot — static example data, never
          fetched, never claimed to be a live/real transaction. Purpose
          is to show the SHAPE of what the two agents know and converge
          on, using only publicly-safe fields (see AgentSnapshot). */}
      {/* No animate-fade-in here — see the hero's own comment above.
          Below-the-fold content should still just be there, not gated
          behind a mount animation racing the page's own setup cost. */}
      <section className="border-t border-border">
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 px-6 py-16">
          <p className="text-xs font-semibold tracking-widest text-muted uppercase">Illustrative example</p>
          <div className="grid w-full grid-cols-1 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <AgentSnapshot tone="blue" label="Buyer Agent" rows={HERO_EXAMPLE.buyer.rows} />
            <AgentSnapshot tone="yellow" label="Merchant Agent" rows={HERO_EXAMPLE.merchant.rows} />
          </div>

          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
            {HERO_EXAMPLE.round} · converging
          </div>

          <div className="flex flex-col items-center gap-1 rounded-2xl border border-emerald-500/25 bg-emerald-400/[.06] px-10 py-6">
            <span className="text-[11px] font-semibold tracking-widest text-emerald-300 uppercase">Deal agreed</span>
            <span className="text-display-3 font-semibold text-foreground">{HERO_EXAMPLE.deal.total}</span>
            <span className="text-xs text-muted">{HERO_EXAMPLE.deal.terms}</span>
          </div>

          <p className="text-xs text-muted">Every real request is negotiated live, start to finish — this panel is a fixed example, not a live feed.</p>
        </div>
      </section>

      {/* Product story */}
      <section className="border-t border-border">
        <div className="mx-auto flex w-full max-w-5xl flex-col divide-y divide-border sm:flex-row sm:divide-x sm:divide-y-0">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="flex flex-1 flex-col gap-3 px-8 py-14">
              <span className="text-display-3 font-semibold text-accent">{feature.index}</span>
              <h2 className="text-base font-medium text-foreground">{feature.title}</h2>
              <p className="text-sm leading-6 text-muted">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** A compact, original Buyer -> Negotiation <- Merchant -> Agreement -> Payment -> Audit trail story diagram — static, decorative, never copying any third party's exact layout/assets. */
function FlowStory() {
  return (
    <div aria-hidden className="flex w-full max-w-[220px] flex-col items-center gap-2">
      <svg viewBox="0 0 200 90" className="w-full" fill="none">
        <line x1="20" y1="14" x2="100" y2="76" stroke="#60a5fa" strokeWidth="1.5" />
        <line x1="180" y1="14" x2="100" y2="76" stroke="#facc15" strokeWidth="1.5" />
        <circle cx="20" cy="14" r="4" fill="#60a5fa" />
        <circle cx="180" cy="14" r="4" fill="#facc15" />
        <circle cx="100" cy="76" r="5" fill="var(--accent)" />
      </svg>
      <div className="-mt-3 flex w-full items-start justify-between text-[11px] font-medium tracking-wide text-blue-300 uppercase">
        <span>Buyer Agent</span>
        <span className="text-yellow-300">Merchant Agent</span>
      </div>
      <span className="mt-2 rounded-full border border-accent/40 bg-accent/10 px-3.5 py-1.5 text-xs font-semibold tracking-wide text-accent uppercase">
        Negotiation
      </span>
      <span className="h-6 w-px bg-border-strong" />
      <FlowStep label="Agreement" tone="emerald" />
      <span className="h-6 w-px bg-border-strong" />
      <FlowStep label="Payment" />
      <span className="h-6 w-px bg-border-strong" />
      <FlowStep label="Audit trail" />
    </div>
  );
}

function FlowStep({ label, tone }: { label: string; tone?: "emerald" }) {
  const toneClass = tone === "emerald" ? "border-emerald-500/30 text-emerald-300" : "border-border text-foreground";
  return <span className={`rounded-full border px-3.5 py-1.5 text-xs font-medium ${toneClass}`}>{label}</span>;
}

function AgentSnapshot({
  tone,
  label,
  rows,
}: {
  tone: "blue" | "yellow";
  label: string;
  /** Deliberately never includes the merchant's private floor — this is a public-facing marketing page, and PACT's own negotiate page holds the same line (see NegotiationDemo.tsx's ContextPanel). */
  rows: readonly (readonly [string, string])[];
}) {
  const toneClass = tone === "blue" ? "text-blue-300" : "text-yellow-300";
  return (
    <div className="flex flex-col gap-3 p-5 text-left">
      <span className={`text-[11px] font-semibold tracking-widest uppercase ${toneClass}`}>{label}</span>
      <dl className="flex flex-col gap-2">
        {rows.map(([key, value]) => (
          <div key={key} className="flex items-baseline justify-between gap-3 text-sm">
            <dt className="text-muted">{key}</dt>
            <dd className="tabular-nums font-medium text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
