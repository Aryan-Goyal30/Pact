// Pure helper functions extracted out of NegotiationDemo.tsx so the
// non-trivial logic (form validation, status display) is unit-testable
// without a browser/DOM test environment. The component itself stays
// thin and presentational.

import type { NegotiationStatus } from "@/lib/rules/negotiationState";

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
