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
    sku: "MONITOR-24-FHD",
    // Catalog/preset recalibration: moved off LAPTOP-14-I5 (whose stock
    // was lowered 100 -> 10, making almost any meaningful quantity there
    // exceed the real ~₹5,00,000 Razorpay transaction ceiling) onto
    // MONITOR-24-FHD, the new general-purpose "workhorse" product — its
    // price band gives roughly 5x the safe-quantity headroom. Verified
    // against the real orchestrator and the real seeded catalog: R1
    // buyer opens 8550, merchant counters 9025 (CONCEDE); R2 buyer HOLDS
    // at 8550 (a real, comparison-won strategic move — never forced),
    // merchant concedes to 8847; R3 accepts at 8847. A genuinely
    // multi-round negotiation, not an instant accept. Final Agreement:
    // 20 x 8847 = ₹1,76,940 — comfortably under the transaction ceiling.
    values: {
      sku: "MONITOR-24-FHD",
      quantity: "20",
      maxUnitPrice: "9000",
      deliveryDeadlineDays: "7",
      urgency: "medium",
      deliveryFlexible: false,
    },
  },
  {
    id: "bulk-buyer",
    label: "Bulk buyer",
    description: "The buyer offers a bigger order in exchange for a better price — genuine quantity-for-price bargaining.",
    sku: "KEYBOARD-WIRELESS",
    // Catalog/preset recalibration: moved onto KEYBOARD-WIRELESS, now
    // negotiable (negotiationEnabled flipped true — a pure demo/business
    // data decision, no new negotiation logic). Its low unit price
    // (₹1,400 listed) is what makes a genuinely large quantity payable:
    // 300 x 1234 = ₹3,70,200, comfortably under the transaction ceiling
    // even though 300 == LARGE_ORDER_QUANTITY_THRESHOLD exactly.
    //
    // Verified live against the real orchestrator: requesting exactly
    // 300 (rather than trading UP to it from a smaller opening request)
    // is the configuration that actually exercises a genuine
    // quantity-driven discount for this product — the MERCHANT's own
    // evaluateMerchantTrade recognizes the bulk order (hasQuantityLeverage
    // becomes true at >=300) and counters with move=QUANTITY_FOR_PRICE
    // at a real discount off its baseline, accepted round 2. Several
    // smaller starting quantities (80/150/250, at multiple price
    // ceilings and urgency levels) were also tried, specifically to
    // trigger the BUYER's own escalation trade (a smaller opening
    // request doubling up toward 300) — none won: KEYBOARD's abundant
    // stock (500) keeps the buyer's fulfillability-leverage component
    // strongly favorable from round 1 regardless of quantity in that
    // range, which pushes buyerLeverageScore above HOLD_LEVERAGE_THRESHOLD
    // immediately; decideBuyerQuantityTrade's own price floor (clamped to
    // resolveBuyerTarget, the SAME floor a plain HOLD already repeats)
    // means the trade can at best TIE a HOLD that's already available
    // every round, never beat it. This preset instead demonstrates the
    // MERCHANT-side half of "large order -> lower price," which is an
    // equally genuine, arguably cleaner exercise of the same
    // LARGE_ORDER_QUANTITY_THRESHOLD mechanic — see this milestone's own
    // final report, regression checks A/E, for the full trace.
    values: {
      sku: "KEYBOARD-WIRELESS",
      quantity: "300",
      maxUnitPrice: "1270",
      deliveryDeadlineDays: "5",
      urgency: "high",
      deliveryFlexible: false,
    },
  },
  {
    id: "buyer-bulk-request",
    label: "Buyer bulk request",
    description: "The buyer offers to buy more in exchange for a lower unit price.",
    sku: "MONITOR-24-FHD",
    // Deliberately separate from "bulk-buyer" above, not a replacement
    // for it — that preset demonstrates the MERCHANT's own
    // evaluateMerchantTrade bulk discount / LARGE_ORDER_QUANTITY_THRESHOLD
    // behavior; this one demonstrates the BUYER's own
    // decideBuyerQuantityTrade escalation (buyerQuantityTrade.ts), which
    // is a genuinely different mechanism that KEYBOARD-WIRELESS's own
    // abundant stock (500) structurally could never exercise — see the
    // "bulk-buyer" preset's own comment on why (buyer leverage there
    // saturates past HOLD_LEVERAGE_THRESHOLD before the trade can ever
    // beat a plain HOLD).
    //
    // This is the center of an empirically verified robust winning
    // region (negotiation demo calibration probe) — quantity ∈
    // {15,20,25} x ceiling ≈ ₹8,500–9,000 x urgency=high x
    // deliveryFlexible=false all produced a genuine buyer-side
    // QUANTITY_FOR_PRICE win against the real orchestrator, not one
    // hand-picked fixture. HIGH urgency is not incidental here — it is
    // what actually pulls round-1 buyer leverage down near 54 (LOW and
    // MEDIUM both leave it well above the 60 HOLD threshold for this
    // exact fixture, at which point HOLD wins instead and the trade
    // never surfaces at all — verified live). deliveryFlexible=false
    // keeps this a clean, single-dimension quantity trade, never
    // DELIVERY_FOR_PRICE / the combined package.
    //
    // Buyer Quantity-for-Price Redesign — re-verified live, SAME input
    // values (no recalibration needed; the existing preset already
    // demonstrates the redesigned invariant correctly): R1 buyer opens
    // 20 @ 8265, merchant CONCEDEs to 20 @ 8883; R2 an ordinary
    // concession, buyer 20 @ 8698 (the trade's own previous-price
    // invariant correctly has nothing to improve on yet immediately
    // after the opening round); R3 the buyer's own comparison genuinely
    // selects QUANTITY_FOR_PRICE — 20 -> 27 units @ 8265, a REAL
    // decrease from its own round-2 ask (8698), never an increase — and
    // the merchant's own bulk evaluation independently agrees, countering
    // 27 @ 8571; R3 accepts. Final Agreement: 27 x 8571 = ₹2,31,417 —
    // comfortably under the transaction ceiling. This is exactly the
    // "buy more, pay no more than I already offered" story the redesign
    // exists to guarantee — documentation of the calibration result
    // only, not hardcoded anywhere in the app; the actual trajectory is
    // always computed live by the real, unmodified orchestrator.
    values: {
      sku: "MONITOR-24-FHD",
      quantity: "20",
      maxUnitPrice: "8700",
      deliveryDeadlineDays: "7",
      urgency: "high",
      deliveryFlexible: false,
    },
  },
  {
    id: "low-stock",
    label: "Low-stock merchant",
    description: "The order exceeds available stock — expect partial fulfillment and merchant leverage.",
    sku: "LAPTOP-14-I5",
    // Catalog/preset recalibration: LAPTOP-14-I5 is now the dedicated
    // scarce-inventory / partial-fulfillment product (availableQty
    // lowered 100 -> 10 specifically for this purpose — see prisma/seed.ts).
    // Requesting 12 against a 10-unit stock produces a genuine partial
    // fulfillment (offered quantity = 10, the entire available stock),
    // and crosses MERCHANT_STOCK_LOW (30) for the first time in this
    // catalog, exercising the merchant's scarce-inventory posture —
    // neither of which any preset could previously reach.
    //
    // Verified live: a 15-unit request (a 33% shortfall against the
    // 10-unit stock) was tried first and genuinely walked away — the
    // buyer's own quantity-shortfall tolerance (medium urgency: 20%,
    // resolveQuantityShortfallTolerance) was exceeded and the offered
    // price didn't compensate enough, a real, correct REJECT, not a
    // bug. 12 units (a 17% shortfall, within tolerance) reaches a real
    // AGREED in 2 rounds: offered quantity 10, price 46828, total
    // ₹4,68,280 — safely under the transaction ceiling.
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "12",
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
    // Catalog/preset recalibration: quantity lowered 20 -> 5 (well under
    // LAPTOP-14-I5's new 10-unit stock) so this exercises urgency
    // independently of stock/bulk effects — the previous qty=20 would
    // now itself exceed the new stock and be a partial-fulfillment
    // scenario, conflating the two concepts this preset is meant to keep
    // separate. Deadline (5) is exactly standardDeliveryDays, i.e. zero
    // slack. Worst case 5 x 47500 = ₹2,37,500 — comfortably under the
    // transaction ceiling.
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "5",
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
    // Catalog/preset recalibration: MONITOR-24-FHD was tried FIRST (per
    // this milestone's own instruction to prefer it here), extensively —
    // several quantities (20 up to 275, including deliberately
    // over-requesting past its 250-unit stock, the same technique the
    // ORIGINAL pre-recalibration version of this preset used on LAPTOP)
    // and both urgency levels, all verified against the real
    // orchestrator. None reproduced a genuine DELIVERY_FOR_PRICE: merely
    // FLAGGING deliveryFlexible=true adds a flat +0.3 to buyer leverage
    // (leverage.ts's deliveryFlexComponent, independent of whether the
    // deliberate trade actually fires) on top of MONITOR's own abundant-
    // stock fulfillability pull — together enough to push buyer leverage
    // past HOLD_LEVERAGE_THRESHOLD (60) from round 1, at which point
    // decideBuyerConcessionMove locks into HOLD every round, and
    // buyerDeliveryTrade.ts's own price floor (clamped to the SAME
    // resolveBuyerTarget a plain HOLD already repeats) can at best tie a
    // HOLD that's already available, never beat it. The one technique
    // that broke this (deliberately over-requesting past available
    // stock, suppressing fulfillability toward neutral) requires a
    // fulfilled quantity large enough to matter, which for MONITOR's
    // price band means exceeding the ₹5,00,000 ceiling — the exact
    // conflict this whole recalibration exists to avoid.
    //
    // Falling back to LAPTOP-14-I5 (now with its own small, deliberately
    // constrained 10-unit stock) reproduces the SAME technique at a
    // price-safe scale.
    //
    // Buyer Quantity-for-Price Redesign — re-verified live, SAME input
    // values: R1 ordinary exchange, buyer 6 @ 43700, merchant CONCEDEs to
    // 6 @ 46415; R2 the buyer's own comparison now selects the SOLO
    // DELIVERY_FOR_PRICE trade (not the combined package) — quantity
    // stays 6 (never increases), delivery extends 7 -> 9 days, price
    // 43700 -> 44798; merchant's own response agrees, countering 6 @
    // 45484 / 9 days; R2 accepts. Final Agreement: 6 x 45484 = ₹2,72,904
    // — comfortably under the transaction ceiling.
    //
    // Root cause of the combined-package no longer winning here, verified
    // directly: the redesigned quantity-driven price-improvement fraction
    // alone already floor-clamps to the buyer's own target on this
    // fixture, so stacking the delivery discount on top of it cannot go
    // any lower — the two tie on price, and the existing, unmodified
    // comparator's first-encountered-wins tie-break (DELIVERY_FOR_PRICE
    // is generated before QUANTITY_AND_DELIVERY_FOR_PRICE) favors the
    // solo trade. This preset was searched for alternate input values
    // that restore the combined package winning outright — none were
    // found within a reasonable search on this catalog (every fixture
    // tried either closed instantly or walked away) — see the redesign's
    // own final report for the recommendation to revisit
    // QUANTITY_TRADE_MIN_PRICE_IMPROVEMENT_FRACTION if demonstrating the
    // combined move specifically becomes a priority. The preset still
    // demonstrates a genuine, real delivery-for-price exchange — a
    // legitimate, still-coherent "trade time for price" story, just not
    // the combined one.
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "6",
      maxUnitPrice: "46000",
      deliveryDeadlineDays: "7",
      urgency: "high",
      deliveryFlexible: true,
    },
  },
  {
    id: "walk-away",
    label: "Impossible budget",
    description: "The buyer's ceiling is below the merchant's floor — expect no agreement.",
    sku: "LAPTOP-14-I5",
    // Unchanged (per this recalibration's own explicit instruction): a
    // ceiling below the merchant's floor never reaches Agreement
    // regardless of quantity or the catalog's stock level, so this
    // preset was already, and remains, fully compatible with the
    // transaction ceiling — no Agreement is ever created for it to apply to.
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
