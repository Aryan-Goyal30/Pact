"use client";

// Merchant Console — "Needs your attention" (dashboard improvement pass;
// restyled again for Merchant Console 2.0 as the console's most
// important operational section). Real, already-persisted signal only:
// Agreements whose payment status is genuinely actionable
// ("pending_payment" — a real deal with money not yet collected — or
// "failed" — a payment that didn't go through). Both are literal
// Agreement.status values the payment system already writes (see
// PaymentPanel.tsx / paymentUi.ts's own paymentStatusLabel); nothing
// here is inferred, scored, or invented. Reuses RecentDealsList's own
// DealDrawer for the exact same click-to-inspect behavior — no second
// drawer implementation. Pass 9: that drawer now embeds the real,
// unmodified PaymentPanel, so "Review" genuinely leads to Pay Now /
// Resume / Retry — reusing the existing payment architecture, never a
// second one.

import { useState } from "react";
import { formatInr, formatRelativeTime, paymentStatusLabel, PAYMENT_STATUS_TONE } from "./dashboardUi";
import { useNow } from "./useNow";
import { DealDrawer, type RecentDealSummary } from "./RecentDealsList";

const ATTENTION_HEADLINE: Record<string, string> = {
  pending_payment: "Payment awaiting confirmation",
  failed: "Payment failed",
};

export function NeedsAttention({ items, totalCount }: { items: RecentDealSummary[]; totalCount: number }) {
  const [openAgreementId, setOpenAgreementId] = useState<string | null>(null);
  const open = items.find((d) => d.agreementId === openAgreementId) ?? null;
  const now = useNow();

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-3 border-t border-border py-8">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
        <div>
          <p className="text-sm font-medium text-foreground">All caught up.</p>
          <p className="text-xs text-muted">Your agent is handling everything currently in progress.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <ul className="flex flex-col divide-y divide-border border-t border-border">
        {items.map((deal) => (
          <li key={deal.agreementId}>
            <button
              type="button"
              onClick={() => setOpenAgreementId(deal.agreementId)}
              className="grid w-full grid-cols-1 items-center gap-2 bg-amber-500/[.04] px-4 py-4 text-left transition-colors hover:bg-amber-500/[.08] sm:grid-cols-[1fr_auto_auto] sm:gap-6"
            >
              <div className="flex flex-col gap-1">
                <span
                  className={`flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase ${
                    PAYMENT_STATUS_TONE[deal.paymentStatus] ?? "text-muted"
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  {ATTENTION_HEADLINE[deal.paymentStatus] ?? paymentStatusLabel(deal.paymentStatus)}
                </span>
                <span className="text-sm font-medium text-foreground">
                  {deal.quantity} × {deal.productName}
                  <span className="ml-2 tabular-nums text-muted">{formatInr(deal.unitPrice)}/unit</span>
                </span>
              </div>

              <span className="tabular-nums text-lg font-semibold text-foreground sm:text-right">
                {formatInr(deal.totalAmount)}
              </span>

              <span className="flex items-center justify-between gap-3 text-[11px] text-muted sm:flex-col sm:items-end sm:justify-center sm:gap-1">
                <span>{now !== null ? formatRelativeTime(deal.createdAt, now) : ""}</span>
                <span className="flex items-center gap-1 font-medium text-foreground">
                  Review <span aria-hidden>→</span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {totalCount > items.length && (
        <p className="text-xs text-muted">
          Showing {items.length} of {totalCount} deals awaiting payment or needing a retry.
        </p>
      )}

      {open && <DealDrawer deal={open} onClose={() => setOpenAgreementId(null)} />}
    </>
  );
}
