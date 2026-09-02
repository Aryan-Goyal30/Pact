import { prisma } from "@/lib/prisma";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import type { NegotiationResult } from "@/lib/rules/negotiationEngine";
import { ActiveNegotiationsList, type ActiveNegotiationSummary } from "./ActiveNegotiationsList";

function formatInr(amount: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

const ACTIVE_STATUSES = ["OPEN", "COUNTERED"] as const;

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

// Server Component: reads directly from Prisma, same established pattern
// this page already used before this redesign (see catalogItems below) —
// a merchant-only operations console, never exposed to the buyer-facing
// negotiate page. Read-only throughout: no negotiation/economics logic
// lives here, only display of what the existing engine already decided
// and persisted.
export default async function DashboardPage() {
  const [merchant, catalogItems, activeSessions, agreedCount] = await Promise.all([
    prisma.merchant.findFirst(),
    prisma.catalogItem.findMany({ orderBy: { name: "asc" } }),
    prisma.negotiationSession.findMany({
      where: { status: { in: [...ACTIVE_STATUSES] } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    prisma.agreement.count(),
  ]);

  const negotiableCount = catalogItems.filter((item) => item.negotiationEnabled).length;

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
    };
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-6 py-12 sm:px-10">
      <header className="flex flex-col gap-1.5">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">Merchant Console</p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          {merchant?.name ?? "PACT Demo Electronics"}
        </h1>
        {merchant ? (
          <p className="max-w-2xl text-sm leading-6 text-muted">{merchant.description}</p>
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

      {/* Summary metrics */}
      <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
        <Metric label="Products" value={catalogItems.length} />
        <Metric label="Negotiable products" value={negotiableCount} />
        <Metric label="Active negotiations" value={activeSessions.length} />
        <Metric label="Completed deals" value={agreedCount} />
      </section>

      {/* Catalog */}
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-medium text-foreground">Catalog</h2>
          <p className="text-sm text-muted">What buyer agents can see, plus what only you can.</p>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-border text-xs tracking-wide text-muted uppercase">
              <tr>
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 font-medium">Listed price</th>
                <th className="px-4 py-3 font-medium">Private floor</th>
                <th className="px-4 py-3 font-medium">Stock</th>
                <th className="px-4 py-3 font-medium">Delivery</th>
                <th className="px-4 py-3 font-medium">Negotiable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {catalogItems.map((item) => (
                <tr key={item.id} className="transition-colors hover:bg-white/[.02]">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{item.name}</div>
                    <div className="font-mono text-xs text-muted">{item.sku}</div>
                  </td>
                  <td className="px-4 py-3 text-foreground">{formatInr(item.listedPrice)}</td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-white/[.06] px-1.5 py-0.5 font-mono text-xs text-muted">
                      {formatInr(item.minPrice)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-foreground">{item.availableQty}</td>
                  <td className="px-4 py-3 text-foreground">
                    {item.standardDeliveryDays}–{item.maxDeliveryDays}d
                  </td>
                  <td className="px-4 py-3">
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
        <p className="text-xs leading-5 text-muted">
          Private floor prices are used by the Merchant Agent and are never exposed to buyers.
        </p>
      </section>

      {/* Active negotiations */}
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-medium text-foreground">Active negotiations</h2>
          <p className="text-sm text-muted">
            Sessions the Merchant Agent is currently negotiating. Select one to open its detail.
          </p>
        </div>

        <ActiveNegotiationsList sessions={activeNegotiationSummaries} />
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 bg-background px-6 py-5">
      <span className="text-2xl font-semibold tracking-tight text-foreground">{value}</span>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

function StatusPill({ positive, label }: { positive: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
        positive ? "text-emerald-300" : "text-muted"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${positive ? "bg-emerald-400" : "bg-white/20"}`} />
      {label}
    </span>
  );
}
