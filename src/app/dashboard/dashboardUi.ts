// Pure presentation helpers shared by the Merchant Console's client
// islands (ActiveNegotiationsList, RecentDealsList, NeedsAttention) —
// extracted once a third consumer needed the same formatting, same
// discipline as negotiationUi.ts/paymentUi.ts elsewhere in the app.
// No data fetching, no negotiation/payment logic — display only.
//
// Deliberately NO react import here (see useNow.ts for the one hook
// that needs it, split into its own module): page.tsx (a Server
// Component) imports formatInr from this file directly, and a module
// containing React hooks cannot be safely bundled for both a Server
// Component's own graph and the client at once — confirmed live via a
// real Next.js build error before this split existed.

import { paymentStatusLabel } from "@/app/negotiate/paymentUi";

export function formatInr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Compact recency label relative to an EXPLICIT `now`, never read
 * internally — see useNow.ts for why. Falls back to a plain date once
 * "Xm/Xh/Xd ago" stops being more useful than the actual date.
 */
export function formatRelativeTime(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffMs = now - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return date.toLocaleDateString();
}

/** Agreement.status — "pending_payment" | "paid" | "failed" | "recovered" | "closed". Real persisted payment state, never inferred. */
export const PAYMENT_STATUS_TONE: Record<string, string> = {
  paid: "text-emerald-300",
  recovered: "text-emerald-300",
  pending_payment: "text-amber-300",
  failed: "text-red-300",
  closed: "text-muted",
};

export const PAYMENT_STATUS_DOT: Record<string, string> = {
  paid: "bg-emerald-400",
  recovered: "bg-emerald-400",
  pending_payment: "bg-amber-400 animate-pulse",
  failed: "bg-red-400",
  closed: "bg-white/30",
};

export { paymentStatusLabel };
