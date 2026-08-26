// Pure helper functions extracted out of NegotiationDemo.tsx so the
// non-trivial logic (form validation, status display) is unit-testable
// without a browser/DOM test environment. The component itself stays
// thin and presentational.

import type { NegotiationStatus } from "@/lib/rules/negotiationState";
import type { NegotiationMessageType } from "@/lib/negotiation/protocol";

export interface BuyerRequestFormValues {
  sku: string;
  quantity: string;
  maxUnitPrice: string;
  deliveryDeadlineDays: string;
}

export interface ParsedBuyerRequest {
  sku: string;
  quantity: number;
  maxUnitPrice: number;
  deliveryDeadlineDays: number;
}

/**
 * Validates and parses the buyer request form. Returns the parsed
 * request on success, or a human-readable error string on failure — the
 * form never submits invalid data to the API, and the API independently
 * re-validates anyway (defense in depth, not a trust boundary here).
 */
export function parseBuyerRequestForm(
  values: BuyerRequestFormValues,
): ParsedBuyerRequest | string {
  if (values.sku.trim().length === 0) {
    return "Choose a product.";
  }

  const quantity = Number(values.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return "Quantity must be a positive number.";
  }

  const maxUnitPrice = Number(values.maxUnitPrice);
  if (!Number.isFinite(maxUnitPrice) || maxUnitPrice <= 0) {
    return "Maximum unit price must be a positive number.";
  }

  const deliveryDeadlineDays = Number(values.deliveryDeadlineDays);
  if (!Number.isFinite(deliveryDeadlineDays) || deliveryDeadlineDays <= 0) {
    return "Delivery deadline must be a positive number of days.";
  }

  return { sku: values.sku, quantity, maxUnitPrice, deliveryDeadlineDays };
}

const STATUS_LABELS: Record<NegotiationStatus, string> = {
  OPEN: "Open",
  COUNTERED: "In progress",
  AGREED: "Agreed",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
};

export function negotiationStatusLabel(status: NegotiationStatus): string {
  return STATUS_LABELS[status];
}

const STATUS_BADGE_CLASSES: Record<NegotiationStatus, string> = {
  OPEN: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  COUNTERED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  AGREED: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  EXPIRED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

export function negotiationStatusBadgeClass(status: NegotiationStatus): string {
  return STATUS_BADGE_CLASSES[status];
}

// ---------------------------------------------------------------------------
// Turn staging labels — these are plain UI status text shown while a turn
// is in flight (or between the buyer/merchant halves of an already-fetched
// turn being revealed with a short delay). They are NOT hidden
// chain-of-thought: the negotiation turn is computed server-side by the
// real deterministic engine + agents before any of this text is shown; the
// label is chosen from the already-known result to pace how it's revealed.
// ---------------------------------------------------------------------------

/** What to show while the Buyer Agent's turn is in flight, before its message is revealed. */
export function buyerThinkingLabel(turnNumber: number): string {
  return turnNumber <= 1 ? "Evaluating request…" : "Considering offer…";
}

/** What to show while the Merchant Agent's response is being revealed, based on what it already decided. */
export function merchantThinkingLabel(messageType: NegotiationMessageType): string {
  switch (messageType) {
    case "accept":
      return "Accepting offer…";
    case "reject":
      return "Rejecting offer…";
    case "counter_offer":
      return "Preparing counter-offer…";
    case "offer":
    case "request":
      return "Checking constraints…";
  }
}

const MESSAGE_TYPE_LABELS: Record<NegotiationMessageType, string> = {
  request: "Request",
  offer: "Offer",
  counter_offer: "Counter-offer",
  accept: "Accept",
  reject: "Reject",
};

export function negotiationMessageTypeLabel(type: NegotiationMessageType): string {
  return MESSAGE_TYPE_LABELS[type];
}

const MESSAGE_TYPE_BADGE_CLASSES: Record<NegotiationMessageType, string> = {
  request: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  offer: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  counter_offer: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  accept: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  reject: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

export function negotiationMessageTypeBadgeClass(type: NegotiationMessageType): string {
  return MESSAGE_TYPE_BADGE_CLASSES[type];
}
