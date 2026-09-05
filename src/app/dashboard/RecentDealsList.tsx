"use client";

// Merchant Console — Recent Deals (correction pass, section 2; restyled
// again for Merchant Console 2.0). Mirrors ActiveNegotiationsList.tsx's
// own established pattern exactly: a Server Component (page.tsx) reads
// Prisma directly and hands down plain, already-parsed data; this file
// owns only which row's detail drawer is open. Opening a deal never
// calls anything beyond the EXISTING GET
// /api/negotiations/:id/audit-trail (AuditTrailPanel, reused verbatim)
// — no new backend behavior, no second audit-trail implementation.

import { useState } from "react";
import { AuditTrailPanel } from "@/app/negotiate/AuditTrailPanel";
import { PaymentPanel } from "@/app/negotiate/PaymentPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { formatInr, formatRelativeTime, paymentStatusLabel, PAYMENT_STATUS_DOT, PAYMENT_STATUS_TONE } from "./dashboardUi";
import { useNow } from "./useNow";

export interface RecentDealSummary {
  agreementId: string;
  /** The originating negotiation session — what AuditTrailPanel needs to fetch its detail. */
  sessionId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  /** Agreement.status — "pending_payment" | "paid" | "failed" | "recovered" | "closed". Real persisted payment state, never inferred. */
  paymentStatus: string;
  /** ISO 8601 — Agreement.createdAt, i.e. the moment the negotiation reached AGREED. */
  createdAt: string;
}

/** A short absolute date, alongside the relative label — history should read like history, not just "Xm ago" forever. Real Agreement.createdAt, formatted, nothing derived. */
function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Every payment status actually present in this batch of real deals, in a fixed display order — never a status the data doesn't genuinely contain, so the filter row never offers a dead option. */
function distinctStatuses(deals: RecentDealSummary[]): string[] {
  const order = ["paid", "recovered", "pending_payment", "failed", "closed"];
  const present = new Set(deals.map((d) => d.paymentStatus));
  return order.filter((s) => present.has(s));
}

export function RecentDealsList({ deals }: { deals: RecentDealSummary[] }) {
  const [openAgreementId, setOpenAgreementId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const open = deals.find((d) => d.agreementId === openAgreementId) ?? null;
  const now = useNow();

  if (deals.length === 0) {
    return (
      <div className="flex flex-col gap-1 border-t border-border py-8 text-center">
        <p className="text-sm font-medium text-foreground">No deals yet.</p>
        <p className="text-xs text-muted">Your completed negotiations will appear here.</p>
      </div>
    );
  }

  // Lightweight, presentation-only filtering over the deals this page
  // already fetched — never a new query, never fetched fresh per
  // keystroke. Only shown once there's a genuinely worthwhile amount of
  // real history to filter through.
  const statuses = distinctStatuses(deals);
  const showFilters = deals.length > 5;
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = deals.filter((deal) => {
    if (statusFilter && deal.paymentStatus !== statusFilter) return false;
    if (normalizedQuery && !deal.productName.toLowerCase().includes(normalizedQuery)) return false;
    return true;
  });

  return (
    <>
      {showFilters && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by product…"
            className="h-8 w-full max-w-[220px] rounded-full border border-border bg-transparent px-3.5 text-xs text-foreground placeholder:text-muted focus:border-border-strong focus:outline-none"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setStatusFilter(null)}
              className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                statusFilter === null
                  ? "border-border-strong text-foreground"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              All
            </button>
            {statuses.map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setStatusFilter((prev) => (prev === status ? null : status))}
                className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                  statusFilter === status
                    ? "border-border-strong text-foreground"
                    : "border-border text-muted hover:text-foreground"
                }`}
              >
                {paymentStatusLabel(status)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className={`hidden px-1 pt-3 text-[10px] font-semibold tracking-widest text-muted uppercase sm:grid sm:grid-cols-[auto_1fr_auto_auto] sm:gap-4 ${
          showFilters ? "" : "border-t border-border"
        }`}
      >
        <span>Status</span>
        <span>Product</span>
        <span>Unit · total</span>
        <span className="text-right">Agreed</span>
      </div>

      {filtered.length === 0 ? (
        <p className="border-t border-border py-8 text-center text-sm text-muted">No deals match this filter.</p>
      ) : (
      <ul className="flex flex-col divide-y divide-border">
        {filtered.map((deal) => (
          <li key={deal.agreementId}>
            <button
              type="button"
              onClick={() => setOpenAgreementId(deal.agreementId)}
              className="grid w-full grid-cols-1 items-center gap-2 px-1 py-3.5 text-left transition-colors hover:bg-white/[.03] sm:grid-cols-[auto_1fr_auto_auto] sm:gap-4"
            >
              <span
                className={`flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase ${
                  PAYMENT_STATUS_TONE[deal.paymentStatus] ?? "text-muted"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${PAYMENT_STATUS_DOT[deal.paymentStatus] ?? "bg-white/30"}`} />
                {paymentStatusLabel(deal.paymentStatus)}
              </span>

              <span className="font-medium text-foreground">
                {deal.quantity} × {deal.productName}
              </span>

              <span className="tabular-nums text-sm text-muted">
                {formatInr(deal.unitPrice)} / unit
                <span className="ml-3 font-medium text-foreground">{formatInr(deal.totalAmount)}</span>
              </span>

              <span className="tabular-nums text-right text-[11px] text-muted">
                {now !== null ? formatRelativeTime(deal.createdAt, now) : ""}
                <span className="mx-1 text-muted/40">·</span>
                {formatShortDate(deal.createdAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      )}

      {open && <DealDrawer deal={open} onClose={() => setOpenAgreementId(null)} />}
    </>
  );
}

/** Exported so NeedsAttention.tsx (same underlying Agreement shape, a different filtered/prioritized list) can open the exact same drawer rather than duplicating it. */
export function DealDrawer({ deal, onClose }: { deal: RecentDealSummary; onClose: () => void }) {
  return (
    <InspectorPanel eyebrow="Deal detail" title={`${deal.quantity} × ${deal.productName}`} onClose={onClose} wide>
      <dl className="grid grid-cols-2 gap-4 rounded-xl border border-border p-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Payment status</dt>
          <dd className={`font-medium ${PAYMENT_STATUS_TONE[deal.paymentStatus] ?? "text-foreground"}`}>
            {paymentStatusLabel(deal.paymentStatus)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Unit price</dt>
          <dd className="tabular-nums font-medium text-foreground">{formatInr(deal.unitPrice)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Total</dt>
          <dd className="tabular-nums font-medium text-foreground">{formatInr(deal.totalAmount)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Agreed</dt>
          <dd className="font-medium text-foreground">{new Date(deal.createdAt).toLocaleString()}</dd>
        </div>
      </dl>

      {/*
        Pass 9, Part B — the actionable path out of "pending_payment"/
        "failed" this drawer previously had none of. PaymentPanel is the
        EXACT same, already-fully-self-contained component /negotiate
        uses after an agreement — it fetches its own real status
        (GET .../payment), decides Pay Now vs Resume vs Retry vs a
        settled completion card vs a dead-end message ENTIRELY from that
        real server state, and every action still goes through the
        existing, unmodified order/verify/recover routes. No second
        payment flow, no client-side "mark as paid," nothing invented
        here — this is pure reuse. Rendered for every status (its own
        `isSettled` branch already renders a real completion card for
        paid/recovered, so there is nothing to gate here).
      */}
      <PaymentPanel
        agreementId={deal.agreementId}
        productName={deal.productName}
        quantity={deal.quantity}
        unitPrice={deal.unitPrice}
        totalAmount={deal.totalAmount}
      />

      {/* The exact same persisted audit trail /negotiate and the live
          negotiation drawer already use — reused verbatim. */}
      <AuditTrailPanel sessionId={deal.sessionId} productName={deal.productName} />
    </InspectorPanel>
  );
}
