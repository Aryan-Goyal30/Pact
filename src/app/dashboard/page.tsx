import { prisma } from "@/lib/prisma";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import type { NegotiationResult } from "@/lib/rules/negotiationEngine";
import { ActiveNegotiationsList, type ActiveNegotiationSummary } from "./ActiveNegotiationsList";
import { RecentDealsList, type RecentDealSummary } from "./RecentDealsList";
import { NeedsAttention } from "./NeedsAttention";
import { formatInr } from "./dashboardUi";

// Dashboard improvement pass — real bug found during live verification:
// without this, Next.js statically prerenders this route AT BUILD TIME
// (confirmed via `next build`'s own route list showing "○ /dashboard"),
// so every Prisma read on this page ran exactly once, ever, and every
// negotiation/payment that happened after that build was invisible here
// — the merchant console silently served a frozen snapshot forever. This
// forces a fresh server render (and fresh Prisma reads) on every
// request, which is the entire point of an operational "what's
// happening right now" console. No query, schema, or business logic
// changed — purely a rendering-mode fix.
export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = ["OPEN", "COUNTERED"] as const;
// Agreement.status values that genuinely need merchant awareness — real
// money on an already-agreed deal, not yet collected ("pending_payment")
// or a payment that didn't go through ("failed"). Both are literal
// values the payment system already writes (paymentUi.ts's own
// paymentStatusLabel already has copy for each) — nothing inferred.
const ATTENTION_STATUSES = ["pending_payment", "failed"] as const;

// Correction pass — investigation found 31 sessions sitting in OPEN/
// COUNTERED, every one last updated between ~13 hours and ~4.7 days ago
// (queried directly against dev.db): accumulated test/demo negotiations
// that were started and then abandoned (browser closed, script killed)
// before ever reaching a terminal status. There is no time-based
// expiry anywhere in the negotiation status lifecycle
// (negotiationState.ts's own EXPIRED transition only ever fires from
// INSIDE a live turn call — round-exhaustion or a structural walk-away
// — never from a background sweep), so an abandoned session stays
// OPEN/COUNTERED forever and is otherwise indistinguishable at the data
// layer from a session someone is genuinely mid-negotiation on right
// now. A real in-flight negotiation (the /negotiate page's own
// turn-by-turn auto-pacing — see NegotiationDemo.tsx's REVEAL_DELAY_MS
// etc.) completes in well under a minute even at the full 6-round
// budget, so 30 minutes of no activity is a safe, generous bound for
// "no longer genuinely in progress" without ever misclassifying a real
// live session. This does NOT change what "active" MEANS (still
// exactly OPEN/COUNTERED — see ACTIVE_STATUSES) — it only excludes rows
// that have gone stale, applied as one more Prisma where-clause on the
// existing query below, not a rewrite of the negotiation lifecycle.
const ACTIVE_SESSION_STALE_AFTER_MINUTES = 30;

// Merchant Console 2.0 — a session updated within this window is shown
// with a brief "just moved" highlight (ActiveNegotiationsList's own
// `recentlyUpdated` flag). Purely a real-timestamp comparison made once,
// server-side, at the moment of this exact request — never a fabricated
// "live" signal, never a client-side timer pretending something changed
// that didn't.
const RECENTLY_UPDATED_WITHIN_MINUTES = 2;

/** Best-effort read of the buyer's original ask — never trusted for anything transactional, only display; a malformed row is shown as "—" rather than crashing the console. */
function parseBuyerRequest(raw: string): BuyerConstraints | null {
  try {
    return JSON.parse(raw) as BuyerConstraints;
  } catch {
    return null;
  }
}

function parsePendingOffer(raw: string | null): NegotiationResult | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NegotiationResult;
  } catch {
    return null;
  }
}

/** Extracted so the impure Date.now() read happens inside a plain helper, not directly in the Server Component's own body — see eslint's react-hooks/purity rule. */
function staleCutoffDate(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60 * 1000);
}

/** Same purity concern as staleCutoffDate above — this request's own "now", read once, used to derive `recentlyUpdated` per session below. */
function currentRequestTime(): number {
  return Date.now();
}

// Server Component: reads directly from Prisma, same established pattern
// this page already used before this redesign (see catalogItems below) —
// a merchant-only operations console, never exposed to the buyer-facing
// negotiate page. Read-only throughout: no negotiation/economics logic
// lives here, only display of what the existing engine already decided
// and persisted.
export default async function DashboardPage() {
  const requestTime = currentRequestTime();
  const staleCutoff = staleCutoffDate(ACTIVE_SESSION_STALE_AFTER_MINUTES);

  const [
    merchant,
    catalogItems,
    activeSessions,
    agreedCount,
    awaitingPaymentCount,
    recentAgreements,
    attentionAgreements,
    attentionTotalCount,
  ] = await Promise.all([
    prisma.merchant.findFirst(),
    prisma.catalogItem.findMany({ orderBy: { name: "asc" } }),
    prisma.negotiationSession.findMany({
      where: { status: { in: [...ACTIVE_STATUSES] }, updatedAt: { gte: staleCutoff } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    prisma.agreement.count(),
    // "Awaiting payment" KPI — a direct count of the real, already-
    // written Agreement.status value, the same one PaymentPanel.tsx
    // itself branches on to show "Pay Now". Deliberately just this one
    // exact status (not also "failed") so the metric's label stays
    // literally true to what it counts; "failed" surfaces separately
    // below in Needs Attention instead of being folded in here.
    prisma.agreement.count({ where: { status: "pending_payment" } }),
    // Recent/completed deals — the real persisted Agreement rows this
    // section 2 correction asks for, already created the moment a
    // negotiation reaches AGREED (agreementRepository.ts) regardless of
    // payment status; `catalogItem` is included so the product name is
    // real, not re-derived from the session's raw request JSON.
    prisma.agreement.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { catalogItem: true },
    }),
    // Needs Attention — a dedicated query (not just filtering the 12
    // most-recent deals above) so an attention-worthy deal that's fallen
    // out of the "recent" window still surfaces here.
    prisma.agreement.findMany({
      where: { status: { in: [...ATTENTION_STATUSES] } },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { catalogItem: true },
    }),
    prisma.agreement.count({ where: { status: { in: [...ATTENTION_STATUSES] } } }),
  ]);

  // Plain, already-parsed data only — a Client Component boundary
  // cannot receive the raw Prisma rows (their module graph pulls in
  // server-only code), so this is built once, here, from real persisted
  // fields exactly like the JSON-parsing helpers above already do.
  const activeNegotiationSummaries: ActiveNegotiationSummary[] = activeSessions.map((session) => {
    const request = parseBuyerRequest(session.buyerRequestRaw);
    const pendingOffer = parsePendingOffer(session.pendingMerchantResultRaw);
    return {
      sessionId: session.id,
      sku: session.sku,
      quantity: request?.quantity ?? null,
      buyerTarget: request?.maxUnitPrice ?? null,
      currentOffer: pendingOffer?.unitPrice ?? null,
      statusLabel: session.status === "OPEN" ? "Opening" : "Negotiating",
      round: session.roundCount,
      maxRounds: session.maxRounds,
      updatedAt: session.updatedAt.toISOString(),
      recentlyUpdated: requestTime - session.updatedAt.getTime() < RECENTLY_UPDATED_WITHIN_MINUTES * 60 * 1000,
    };
  });

  function toDealSummary(agreement: (typeof recentAgreements)[number]): RecentDealSummary {
    return {
      agreementId: agreement.id,
      sessionId: agreement.sessionId,
      productName: agreement.catalogItem.name,
      sku: agreement.catalogItem.sku,
      quantity: agreement.quantity,
      unitPrice: agreement.pricePerUnit,
      totalAmount: agreement.totalAmount,
      paymentStatus: agreement.status,
      createdAt: agreement.createdAt.toISOString(),
    };
  }

  const recentDealSummaries: RecentDealSummary[] = recentAgreements.map(toDealSummary);
  const attentionDealSummaries: RecentDealSummary[] = attentionAgreements.map(toDealSummary);
  const liveCount = activeSessions.length;

  return (
    <div className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col gap-14 px-6 py-12 sm:px-10 lg:px-16">
      <header className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-widest text-accent uppercase">Merchant Console</p>
          <h1 className="text-display-1 font-semibold text-foreground">Your agent is handling commerce.</h1>
        </div>

        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span
            className={`h-1.5 w-1.5 rounded-full ${liveCount > 0 ? "animate-pulse bg-emerald-400" : "bg-white/25"}`}
            aria-hidden
          />
          {liveCount > 0
            ? `Agent active · ${liveCount} negotiation${liveCount === 1 ? "" : "s"} in progress`
            : "Agent standing by · No live negotiations"}
        </p>

        {merchant ? (
          <p className="max-w-2xl text-sm leading-6 text-muted">
            <span className="font-medium text-foreground">{merchant.name}</span> — {merchant.description}
          </p>
        ) : (
          <p className="text-sm text-muted">
            No merchant profile found. Run{" "}
            <code className="rounded bg-white/[.06] px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
              npx prisma db seed
            </code>{" "}
            to load demo data.
          </p>
        )}
      </header>

      {/* Summary metrics — one typographic strip, not four separate
          cards: thin vertical dividers between columns, no outer box. */}
      <section className="flex flex-wrap gap-x-10 gap-y-6 border-y border-border py-6">
        <Metric label="Catalog" value={catalogItems.length} />
        <Metric label="Live" value={activeSessions.length} />
        <Metric label="Awaiting payment" value={awaitingPaymentCount} />
        {/* Counts every Agreement ever created — i.e. every negotiation
            that reached AGREED terms — regardless of payment status. An
            agreement still "Awaiting payment" above is counted in BOTH
            tiles: this one for having completed negotiation, the other
            for not yet being paid. Together they give the honest full
            picture rather than one metric silently conflating the two. */}
        <Metric label="Completed" value={agreedCount} />
      </section>

      {/* Needs your attention */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-muted uppercase">Needs your attention</h2>
          <p className="mt-1 text-sm text-muted">Agreed deals with payment pending or a failed attempt.</p>
        </div>
        <NeedsAttention items={attentionDealSummaries} totalCount={attentionTotalCount} />
      </section>

      {/* Live negotiations */}
      <section className="flex flex-col gap-4 border-t border-border pt-14">
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-muted uppercase">Live negotiations</h2>
          <p className="mt-1 text-sm text-muted">
            Merchant Agent operates within each product&rsquo;s configured price, stock, and delivery constraints —
            select a negotiation to open its detail.
          </p>
        </div>

        <ActiveNegotiationsList sessions={activeNegotiationSummaries} />

        <p className="text-xs leading-5 text-muted">
          Only sessions updated in the last {ACTIVE_SESSION_STALE_AFTER_MINUTES} minutes are shown here —
          negotiations left mid-session with no further activity (an abandoned test run, a closed tab)
          age out of this list rather than being counted as live indefinitely.
        </p>
      </section>

      {/* Deal history — deliberately distinct framing from Live negotiations
          above: past tense, dates, no "live" language. Same real Agreement
          rows either way. */}
      <section className="flex flex-col gap-4 border-t border-border pt-14">
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-muted uppercase">Deal history</h2>
          <p className="mt-1 text-sm text-muted">Negotiations your agent has already completed.</p>
        </div>

        <RecentDealsList deals={recentDealSummaries} />
      </section>

      {/* Catalog */}
      <section className="flex flex-col gap-4 border-t border-border pt-14">
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-muted uppercase">Catalog</h2>
          <p className="mt-1 text-sm text-muted">Products your merchant agent can negotiate for.</p>
        </div>

        {/* Desktop/tablet: a real table. Below sm, a table forces
            horizontal scroll on the whole page's primary content —
            replaced with stacked cards instead (see design brief's own
            "tables become usable cards ... where appropriate"). Same
            data, same fields, both driven by the one `catalogItems`
            query above. */}
        <div className="hidden overflow-x-auto border-t border-border sm:block">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-border text-xs tracking-wide text-muted uppercase">
              <tr>
                <th className="py-3 pr-4 font-medium">Product</th>
                <th className="px-4 py-3 font-medium">Listed price</th>
                <th className="px-4 py-3 font-medium">Private floor</th>
                <th className="px-4 py-3 font-medium">Stock</th>
                <th className="px-4 py-3 font-medium">Delivery</th>
                <th className="py-3 pl-4 text-right font-medium">Negotiable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {catalogItems.map((item) => (
                <tr key={item.id} className="transition-colors hover:bg-white/[.02]">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-foreground">{item.name}</div>
                    <div className="font-mono text-xs text-muted">{item.sku}</div>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-foreground">{formatInr(item.listedPrice)}</td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-white/[.06] px-1.5 py-0.5 font-mono text-xs tabular-nums text-muted">
                      {formatInr(item.minPrice)}
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-foreground">{item.availableQty}</td>
                  <td className="px-4 py-3 tabular-nums text-foreground">
                    {item.standardDeliveryDays}–{item.maxDeliveryDays}d
                  </td>
                  <td className="py-3 pl-4 text-right">
                    <StatusPill positive={item.negotiationEnabled} label={item.negotiationEnabled ? "Yes" : "No"} />
                  </td>
                </tr>
              ))}
              {catalogItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted">
                    No catalog items yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <ul className="flex flex-col gap-2 sm:hidden">
          {catalogItems.map((item) => (
            <li key={item.id} className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-foreground">{item.name}</p>
                  <p className="font-mono text-xs text-muted">{item.sku}</p>
                </div>
                <StatusPill positive={item.negotiationEnabled} label={item.negotiationEnabled ? "Negotiable" : "Fixed"} />
              </div>
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-[11px] text-muted">Listed</dt>
                  <dd className="tabular-nums font-medium text-foreground">{formatInr(item.listedPrice)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted">Floor</dt>
                  <dd>
                    <span className="rounded bg-white/[.06] px-1.5 py-0.5 font-mono text-xs tabular-nums text-muted">
                      {formatInr(item.minPrice)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted">Stock</dt>
                  <dd className="tabular-nums font-medium text-foreground">{item.availableQty}</dd>
                </div>
              </dl>
              <p className="text-xs text-muted">
                Delivery {item.standardDeliveryDays}–{item.maxDeliveryDays} days
              </p>
            </li>
          ))}
          {catalogItems.length === 0 && (
            <li className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted">
              No catalog items yet.
            </li>
          )}
        </ul>

        <p className="text-xs leading-5 text-muted">
          Private floor prices are used by the Merchant Agent and are never exposed to buyers.
        </p>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold tracking-widest text-muted uppercase">{label}</span>
      <span className="text-display-3 tabular-nums font-semibold text-foreground">{value}</span>
    </div>
  );
}

function StatusPill({ positive, label }: { positive: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${positive ? "text-emerald-300" : "text-muted"}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${positive ? "bg-emerald-400" : "bg-white/20"}`} />
      {label}
    </span>
  );
}
