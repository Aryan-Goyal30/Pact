// Pure helper functions extracted out of NegotiationDemo.tsx so the
// non-trivial logic (form validation, status/label/copy display) is
// unit-testable without a browser/DOM test environment. The component
// itself stays thin and presentational.

import type { NegotiationStatus } from "@/lib/rules/negotiationState";
import type { NegotiationMessageType } from "@/lib/negotiation/protocol";
import type { PublicManifestProduct } from "@/types/manifest";
import type { CandidateMoveType } from "@/lib/rules/candidateMove";

export type UrgencyFormValue = "low" | "medium" | "high";

export interface BuyerRequestFormValues {
  sku: string;
  quantity: string;
  maxUnitPrice: string;
  deliveryDeadlineDays: string;
  urgency: UrgencyFormValue;
  deliveryFlexible: boolean;
}

export interface ParsedBuyerRequest {
  sku: string;
  quantity: number;
  maxUnitPrice: number;
  deliveryDeadlineDays: number;
  urgency: UrgencyFormValue;
  deliveryFlexible: boolean;
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

  return {
    sku: values.sku,
    quantity,
    maxUnitPrice,
    deliveryDeadlineDays,
    urgency: values.urgency,
    deliveryFlexible: values.deliveryFlexible,
  };
}

// ---------------------------------------------------------------------------
// Scenario presets — pure form prefills, nothing more. Each one just
// fills the same fields a person could type in by hand; the actual
// scenario behavior (bulk leverage, scarcity, urgency, flexibility,
// walk-away) comes entirely from the real deterministic engine once
// submitted — see negotiationStrategy.ts / leverage.ts / orchestrator.ts
// and their tests for where that behavior is proven. This exists only
// to make the different situations quick to demonstrate without typing
// numbers by hand each time.
// ---------------------------------------------------------------------------

export interface ScenarioPreset {
  id: string;
  label: string;
  description: string;
  sku: string;
  values: BuyerRequestFormValues;
}

const SCENARIO_PRESET_DEFINITIONS: ScenarioPreset[] = [
  {
    id: "balanced",
    label: "Balanced negotiation",
    description: "Neither side has a dominant advantage — a gradual, ordinary back-and-forth.",
    sku: "LAPTOP-14-I5",
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "50",
      maxUnitPrice: "46000",
      deliveryDeadlineDays: "7",
      urgency: "medium",
      deliveryFlexible: false,
    },
  },
  {
    id: "bulk-buyer",
    label: "Bulk buyer",
    description: "A large order against ample stock — buyer leverage should be strong.",
    sku: "MONITOR-24-FHD",
    values: {
      sku: "MONITOR-24-FHD",
      quantity: "200",
      maxUnitPrice: "9000",
      deliveryDeadlineDays: "8",
      urgency: "medium",
      deliveryFlexible: false,
    },
  },
  {
    id: "low-stock",
    label: "Low-stock merchant",
    description: "The order exceeds available stock — expect partial fulfillment and merchant leverage.",
    sku: "LAPTOP-14-I5",
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "150",
      maxUnitPrice: "47000",
      deliveryDeadlineDays: "10",
      urgency: "medium",
      deliveryFlexible: false,
    },
  },
  {
    id: "urgent-delivery",
    label: "Urgent delivery",
    description: "No slack on delivery — the merchant can hold a firmer price.",
    sku: "LAPTOP-14-I5",
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "20",
      maxUnitPrice: "47500",
      deliveryDeadlineDays: "5",
      urgency: "high",
      deliveryFlexible: false,
    },
  },
  {
    id: "flexible-delivery",
    label: "Flexible delivery",
    description: "The buyer trades a later delivery date for a better price.",
    sku: "LAPTOP-14-I5",
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "20",
      maxUnitPrice: "46000",
      deliveryDeadlineDays: "12",
      urgency: "low",
      deliveryFlexible: true,
    },
  },
  {
    id: "walk-away",
    label: "Impossible budget",
    description: "The buyer's ceiling is below the merchant's floor — expect no agreement.",
    sku: "LAPTOP-14-I5",
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "10",
      maxUnitPrice: "40000",
      deliveryDeadlineDays: "10",
      urgency: "medium",
      deliveryFlexible: false,
    },
  },
];

/** Only returns presets whose product SKU actually exists in the current catalog — never references a product the manifest doesn't have. */
export function getScenarioPresets(products: PublicManifestProduct[]): ScenarioPreset[] {
  const available = new Set(products.map((p) => p.sku));
  return SCENARIO_PRESET_DEFINITIONS.filter((preset) => available.has(preset.sku));
}

/** Shared INR currency formatter for every price shown on the negotiate page. */
export function formatInr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * The maximum this order could ever cost — quantity × the buyer's own
 * ceiling price, purely a client-side preview of what's about to be
 * requested. Never sent to the API and never confused with a
 * negotiation result: the actual agreed total (if any) always comes
 * from NegotiationAgreementDTO.totalAmount, a real server-computed value.
 */
export function computeMaxOrderValue(quantity: number, maxUnitPrice: number): number {
  return quantity * maxUnitPrice;
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

/**
 * Why a closed negotiation didn't reach AGREED — a REJECTED vs EXPIRED
 * distinction the UI can show without leaning on the (private-safe, but
 * still just one specific merchant message) text of the closing turn.
 * Never mentions minPrice or any other private constraint.
 */
export function negotiationFailureExplanation(status: "REJECTED" | "EXPIRED"): string {
  return status === "EXPIRED"
    ? "The maximum number of negotiation rounds was reached before both sides could agree on terms."
    : "The negotiation could not find terms that satisfied both sides' requirements.";
}

// ---------------------------------------------------------------------------
// Turn staging sentences — plain UI status text shown while a turn is in
// flight (or between the buyer/merchant halves of an already-fetched turn
// being revealed with a short delay). This is NOT hidden chain-of-thought:
// the negotiation turn is computed server-side by the real deterministic
// engine + agents before any of this text is shown; the sentence is
// chosen from the already-known result only to pace how it's revealed.
// ---------------------------------------------------------------------------

/** What to show while the Buyer Agent's turn is in flight, before its message is revealed. */
export function buyerThinkingLabel(turnNumber: number): string {
  return turnNumber <= 1
    ? "Buyer Agent is evaluating the request…"
    : "Buyer Agent is considering the merchant's offer…";
}

/** What to show while the Merchant Agent's response is being revealed, based on what it already decided. */
export function merchantThinkingLabel(messageType: NegotiationMessageType): string {
  switch (messageType) {
    case "accept":
      return "Merchant Agent is accepting the offer…";
    case "reject":
      return "Merchant Agent is rejecting the offer…";
    case "counter_offer":
      return "Merchant Agent is preparing a counter-offer…";
    case "offer":
    case "request":
      return "Merchant Agent is considering the offer…";
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

// ---------------------------------------------------------------------------
// Milestone 10: strategic move label — the smallest possible UI surface
// for the deterministic move already selected server-side (see
// candidateMove.ts / buyerMoveSelection.ts / merchantMoveSelection.ts).
// Purely a label lookup, same shape as negotiationMessageTypeLabel/
// negotiationMessageTypeBadgeClass above — never infers or recomputes a
// move from price/quantity/delivery numbers itself.
// ---------------------------------------------------------------------------

const MOVE_LABELS: Record<CandidateMoveType, string> = {
  HOLD: "Hold",
  CONCEDE: "Concede",
  QUANTITY_FOR_PRICE: "Quantity for Price",
  DELIVERY_FOR_PRICE: "Delivery for Price",
};

/** Human-readable label for a strategic move. */
export function negotiationMoveLabel(move: CandidateMoveType): string {
  return MOVE_LABELS[move];
}

const MOVE_BADGE_CLASSES: Record<CandidateMoveType, string> = {
  HOLD: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  CONCEDE: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  QUANTITY_FOR_PRICE: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
  DELIVERY_FOR_PRICE: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
};

/** Badge color class for a strategic move — same convention as negotiationMessageTypeBadgeClass. */
export function negotiationMoveBadgeClass(move: CandidateMoveType): string {
  return MOVE_BADGE_CLASSES[move];
}
