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
    // Milestone 12.5: maxUnitPrice lowered from 46000 -> 45000 — the only
    // change. At 46000, round 1's anchored-midpoint merchant counter
    // (45850) already cleared the buyer's ceiling, so the buyer accepted
    // on round 2 with nothing else to observe. At 45000, that same
    // counter (45375) does not clear the ceiling, so the negotiation
    // genuinely continues — verified against the real orchestrator and
    // the real seeded catalog: R1 counter, R2 buyer HOLD (a real,
    // comparison-won strategic move — never forced), merchant concedes,
    // R3 accept. Nothing about the buyer's decision logic changed; this
    // preset simply no longer opens right on top of an instant accept.
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "50",
      maxUnitPrice: "45000",
      deliveryDeadlineDays: "7",
      urgency: "medium",
      deliveryFlexible: false,
    },
  },
  {
    id: "bulk-buyer",
    label: "Bulk buyer",
    description: "The buyer offers a bigger order in exchange for a better price — genuine quantity-for-price bargaining.",
    sku: "LAPTOP-14-I5",
    // Milestone 12.5: replaces the old MONITOR-24-FHD/200-unit shape.
    // That preset's own large quantity pushed buyer leverage past 60
    // almost immediately (quantityLeverageComponent + fulfillability
    // alone contribute ~0.28 toward the leverage total at 200 units) —
    // once leverage crosses that threshold, HOLD becomes the buyer's
    // ordinary move, and HOLD (which repeats an earlier, lower round's
    // price) structurally outprices any same-round QUANTITY_FOR_PRICE
    // candidate, so the trade never won regardless of whether it fired.
    // These values instead reuse the shape of an already-verified
    // orchestrator fixture where the quantity trade genuinely wins a
    // real price comparison (not a HOLD-favoring leverage band) —
    // re-verified here against the REAL seeded LAPTOP-14-I5 catalog
    // (availableQty 100, not the fixture's own 150): R1 opens 50 units,
    // R2 the buyer's own comparison selects QUANTITY_FOR_PRICE, trading
    // up to exactly 100 units (== all available stock, confirmed never
    // exceeded / never partially fulfilled), for a materially better
    // price than a plain concession would have given; R3 accepts.
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "50",
      maxUnitPrice: "45500",
      deliveryDeadlineDays: "10",
      urgency: "high",
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
    // Milestone 12.5: the old shape (deadline 12) already sat exactly at
    // this item's real maxDeliveryDays (12) — zero genuine slack existed
    // to trade before the preset even opened. The primary replacement
    // proposed for this milestone (quantity 40, ceiling 45500, deadline
    // 8) was tried first and found NOT to reproduce live: against the
    // real catalog's stock of 100 (unlike the reference fixture, which
    // used a deliberately-constrained stock of 30 specifically to
    // suppress the competing quantity chip), 40 units never triggers
    // partial fulfillment, so round 1's ordinary counter already cleared
    // the buyer's ceiling and the negotiation accepted immediately —
    // no round ever reached a point where any trade could fire. Two
    // further adjustments were probed against the real orchestrator:
    // tightening the ceiling alone (still qty 40) reopened a real
    // negotiation, but buyer leverage still crossed 60 by round 2, so
    // HOLD won instead of DELIVERY_FOR_PRICE, matching the exact
    // mechanism already found in the bulk-buyer preset above. Raising
    // quantity to 110 (creating a genuine, real partial-fulfillment
    // shortfall against the real 100-unit stock — which also suppresses
    // the competing quantity-for-price chip, mirroring the reference
    // fixture's own isolation technique) alongside the tighter ceiling
    // is what actually worked: re-verified against the real seeded
    // catalog, R1 partial-fulfillment counter (100 of 110) does not
    // clear the ceiling, R2 the buyer's own comparison genuinely selects
    // DELIVERY_FOR_PRICE (never forced), R3 accepts.
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "110",
      maxUnitPrice: "45000",
      deliveryDeadlineDays: "8",
      urgency: "high",
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
 *
 * Milestone 12.5: EXPIRED itself is further distinguished, UI-only, using
 * data the DTO already carries (`rounds`/`maxRounds` — see
 * NegotiationRunResponse / NegotiationTurnResponse) rather than a new
 * status enum or WalkAwayReason field: a walk-away (structural price-gap
 * impossibility, or a repeated-position deadlock — see walkAway.ts) can
 * close well before the round limit, while genuine round-exhaustion
 * always has rounds === maxRounds. Deliberately never derived from the
 * closing turn's own LLM-phrased `message` text — nothing in this
 * codebase parses agent messages to recover structured meaning (see
 * negotiation/protocol.ts's own header comment), and this is no
 * exception. `rounds`/`maxRounds` are optional and additive: omitting
 * either reproduces the exact pre-Milestone-12.5 generic EXPIRED text,
 * so every existing single-argument call site is unaffected.
 */
export function negotiationFailureExplanation(
  status: "REJECTED" | "EXPIRED",
  rounds?: number,
  maxRounds?: number,
): string {
  if (status === "REJECTED") {
    return "The negotiation could not find terms that satisfied both sides' requirements.";
  }
  if (rounds !== undefined && maxRounds !== undefined && rounds < maxRounds) {
    return "Negotiation ended early — the two sides' positions could not be reconciled.";
  }
  return "The maximum number of negotiation rounds was reached before both sides could agree on terms.";
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
  // Milestone 12: the first combined move — same lookup-table pattern,
  // not a UI redesign.
  QUANTITY_AND_DELIVERY_FOR_PRICE: "Quantity + Delivery for Price",
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
  QUANTITY_AND_DELIVERY_FOR_PRICE: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
};

/** Badge color class for a strategic move — same convention as negotiationMessageTypeBadgeClass. */
export function negotiationMoveBadgeClass(move: CandidateMoveType): string {
  return MOVE_BADGE_CLASSES[move];
}
