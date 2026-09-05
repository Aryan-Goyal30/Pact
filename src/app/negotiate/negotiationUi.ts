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
    // against the real orchestrator (maxRounds=6 — see
    // NegotiationDemo.tsx) and the real seeded catalog: R1 buyer opens
    // 8550, merchant counters 9025 (CONCEDE); R2 buyer HOLDS at 8550 (a
    // real, comparison-won strategic move — never forced), merchant
    // concedes to 8841; R3 accepts at 8841. A genuinely multi-round
    // negotiation, not an instant accept. Final Agreement:
    // 20 x 8841 = ₹1,76,820 — comfortably under the transaction ceiling.
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
    // Verified live against the real orchestrator (maxRounds=6 — see
    // NegotiationDemo.tsx): requesting exactly 300 (rather than trading
    // UP to it from a smaller opening request) is the configuration that
    // actually exercises a genuine quantity-driven discount for this
    // product — the MERCHANT's own evaluateMerchantTrade recognizes the
    // bulk order (hasQuantityLeverage becomes true at >=300) and counters
    // with move=QUANTITY_FOR_PRICE at a real discount off its baseline.
    // R1 buyer opens 1171, merchant counters 1234 (QUANTITY_FOR_PRICE);
    // R2 the buyer — genuinely strongly leveraged here — holds firm at
    // 1171 rather than reflexively accepting, and the merchant concedes
    // further to 1181 (also QUANTITY_FOR_PRICE); R3 accepts. A real,
    // visible, multi-round volume-bargaining exchange, not an instant
    // accept. Several smaller starting quantities (80/150/250, at multiple price
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
    // Re-verified live against the real orchestrator (maxRounds=6 — see
    // NegotiationDemo.tsx), same input values: R1 buyer opens 20 @ 8265,
    // merchant CONCEDEs to 20 @ 8883; R2 an ordinary concession, buyer 20
    // @ 8639, merchant 20 @ 8752; R3 the buyer's own comparison genuinely
    // selects QUANTITY_FOR_PRICE — 20 -> 28 units @ 8265, a REAL decrease
    // from its own round-2 ask (8639), never an increase — and the
    // merchant's own bulk evaluation independently agrees, countering 28
    // @ 8544; R4 accepts. Final Agreement: 28 x 8544 = ₹2,39,232 —
    // comfortably under the transaction ceiling. This is exactly the
    // "buy more, pay no more than I already offered" story the buyer
    // quantity-trade invariant exists to guarantee — documentation of the
    // calibration result only, not hardcoded anywhere in the app; the
    // actual trajectory is always computed live by the real, unmodified
    // orchestrator.
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
    // Scenario-behavior fix: maxUnitPrice lowered 47000 -> 46000. At
    // 47000, the merchant's very first counter (46828) already cleared
    // both the buyer's ceiling and its quantity-shortfall tolerance, so
    // the negotiation closed in a single round — no visible bargaining
    // at all, despite the merchant genuinely holding real leverage here.
    // At 46000, the merchant's opening counter (46495) is now above the
    // buyer's ceiling, so a real negotiation follows: the merchant holds
    // its price firm for several rounds (real scarcity leverage — it
    // does not need to chase the buyer's small concessions) before
    // finally meeting the buyer's ceiling once the round budget is
    // nearly spent. Verified live against the real orchestrator (the UI
    // always requests maxRounds=6 — see NegotiationDemo.tsx): 6 rounds,
    // offered quantity 10 throughout (the hard stock constraint is
    // never violated), final price 46000, total ₹4,60,000 — safely
    // under the transaction ceiling.
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "12",
      maxUnitPrice: "46000",
      deliveryDeadlineDays: "10",
      urgency: "medium",
      deliveryFlexible: false,
    },
  },
  {
    id: "urgent-delivery",
    label: "Urgent delivery",
    description: "The buyer needs it faster than standard delivery — expect a real price premium for the rush.",
    sku: "LAPTOP-14-I5",
    // Scenario-behavior fix: the deadline (5) previously equaled
    // LAPTOP-14-I5's own standardDeliveryDays (5), so there was zero
    // actual urgency to negotiate — the outcome was indistinguishable
    // from an ordinary price negotiation. A deadline faster than
    // standard now genuinely means something: the merchant can expedite
    // to meet it, but at a real price premium (checkDeliveryAchievable /
    // resolveDeliveryRushPremiumFraction, negotiationStrategy.ts) — the
    // merchant's own effective price band is raised for this
    // negotiation, so its counters visibly exceed the item's normal
    // listed price (48000). Deadline lowered 5 -> 2 days (materially
    // faster than the 5-day standard); quantity lowered 5 -> 3 and
    // maxUnitPrice raised 47500 -> 49500 so a real deal is still
    // reachable within the buyer's budget once the rush premium is
    // applied, without accidentally also engaging the quantity-trade
    // dimension (verified live — quantity 5 at this same price point
    // does, muddying the delivery-only story this preset is meant to
    // isolate).
    //
    // Verified live against the real orchestrator (maxRounds=6): 6
    // rounds, delivery honored at 2 days throughout, merchant's opening
    // counter (50467) already well above the raw listed price (48000),
    // final price 49500 (still above listed) — total ₹1,48,500, safely
    // under the transaction ceiling. Comparing this against the SAME
    // fixture at a 5-day (non-rush) deadline settles at 47659 in a
    // single round — a direct, visible ~₹1,800/unit cost for the 3
    // days saved.
    values: {
      sku: "LAPTOP-14-I5",
      quantity: "3",
      maxUnitPrice: "49500",
      deliveryDeadlineDays: "2",
      urgency: "high",
      deliveryFlexible: false,
    },
  },
  {
    id: "flexible-delivery",
    label: "Flexible delivery",
    description: "The buyer trades a later delivery date for a better price.",
    sku: "LAPTOP-14-I5",
    // LAPTOP-14-I5 (not MONITOR-24-FHD) is deliberately used here: on
    // MONITOR's abundant stock, deliveryFlexible=true alone pushes buyer
    // leverage past HOLD_LEVERAGE_THRESHOLD from round 1, so the buyer
    // locks into HOLD every round and the delivery-for-price trade can
    // at best tie an already-available HOLD, never beat it — no genuine
    // trade ever fires. LAPTOP's own constrained stock avoids that.
    //
    // Preserved behavior, re-verified live against the real orchestrator
    // (maxRounds=6 — see NegotiationDemo.tsx): R1 ordinary exchange,
    // buyer 6 @ 43700, merchant CONCEDEs to 6 @ 46415; R2 the buyer's own
    // comparison selects the solo DELIVERY_FOR_PRICE trade (quantity
    // stays 6, delivery extends 7 -> 9 days, price stays at 43700 — its
    // own previous price, D5's invariant, see buyerDeliveryTrade.ts);
    // merchant's own response agrees, countering 6 @ 45851 / 9 days; R2
    // accepts. Final Agreement: 6 x 45851 = ₹2,75,106 — comfortably
    // under the transaction ceiling.
    //
    // Scenario-behavior fix: the buyer's own message on the trade round
    // now explicitly states the tradeoff ("I can accept delivery in 9
    // day(s) if you can bring the price down to 43700 each.") instead of
    // a generic "I can go up to X" caption that didn't distinguish a
    // deliberate delivery-for-price trade from an ordinary concession —
    // see buildFallbackBuyerMessage, buyerAgent.ts (used whenever no LLM
    // is configured, or the LLM's own message fails the integrity check;
    // the LLM prompt itself already asked for this framing separately).
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
/**
 * The real, positive rupee distance between the buyer's own stated
 * maximum and the merchant's final offer — null whenever either number
 * is unknown, or the merchant's final offer was actually at/below the
 * buyer's maximum (in which case price wasn't the reason this
 * negotiation failed to reach AGREED, so no gap is reported). Built
 * entirely from two numbers already public to the buyer themselves
 * (their own stated ceiling, and an offer the merchant already made
 * out loud) — never touches, derives, or implies the merchant's private
 * floor (Pass 11 addendum, "impossible-budget failure explanation").
 */
export function negotiationPriceGap(
  buyerMaxPrice: number | undefined,
  merchantFinalPrice: number | undefined,
): number | null {
  if (buyerMaxPrice === undefined || merchantFinalPrice === undefined) return null;
  const gap = merchantFinalPrice - buyerMaxPrice;
  return gap > 0 ? gap : null;
}

export function negotiationFailureExplanation(
  status: "REJECTED" | "EXPIRED",
  rounds?: number,
  maxRounds?: number,
  buyerMaxPrice?: number,
  merchantFinalPrice?: number,
): string {
  if (status === "REJECTED") {
    return "The negotiation could not find terms that satisfied both sides' requirements.";
  }
  // Pass 11 addendum: when the buyer's own stated max and the
  // merchant's own already-public final offer show a genuine remaining
  // price gap, that's a more useful and equally safe explanation than
  // the generic "positions could not be reconciled" — still never
  // mentions or implies the merchant's private floor, only restates two
  // numbers the buyer already knows.
  if (negotiationPriceGap(buyerMaxPrice, merchantFinalPrice) !== null) {
    return "The merchant made a final concession, but the resulting price was still above your maximum budget. PACT could not authorize a lower offer while staying within the merchant's pricing constraints, so the Buyer Agent walked away.";
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

/**
 * Redesign 2.0.1 (D2) — a concise "what actually changed" line for a
 * genuine non-price trade round, e.g. "8 → 12 days in exchange for a
 * better price". Purely a comparison of two already-persisted buyer
 * terms (this round's vs. the immediately preceding round's) — never a
 * new computation, never invented: a dimension that didn't actually
 * change (or for which one of the two rounds has no data) is simply
 * left out. Returns null whenever `move` isn't one of the three real
 * trade types, or the comparison yields nothing to report — the caller
 * must never fabricate an annotation for an ordinary HOLD/CONCEDE round.
 */
export function describeTradeAnnotation(
  move: CandidateMoveType | undefined,
  previousBuyer: { quantity: number | null; deliveryDays: number | null } | null,
  currentBuyer: { quantity: number | null; deliveryDays: number | null },
): string | null {
  if (!previousBuyer) return null;
  if (move !== "QUANTITY_FOR_PRICE" && move !== "DELIVERY_FOR_PRICE" && move !== "QUANTITY_AND_DELIVERY_FOR_PRICE") {
    return null;
  }

  const parts: string[] = [];
  if (
    (move === "QUANTITY_FOR_PRICE" || move === "QUANTITY_AND_DELIVERY_FOR_PRICE") &&
    previousBuyer.quantity !== null &&
    currentBuyer.quantity !== null &&
    previousBuyer.quantity !== currentBuyer.quantity
  ) {
    parts.push(`${previousBuyer.quantity} → ${currentBuyer.quantity} units`);
  }
  if (
    (move === "DELIVERY_FOR_PRICE" || move === "QUANTITY_AND_DELIVERY_FOR_PRICE") &&
    previousBuyer.deliveryDays !== null &&
    currentBuyer.deliveryDays !== null &&
    previousBuyer.deliveryDays !== currentBuyer.deliveryDays
  ) {
    parts.push(`${previousBuyer.deliveryDays} → ${currentBuyer.deliveryDays} day(s)`);
  }

  if (parts.length === 0) return null;
  return `${parts.join(" and ")} in exchange for a better price`;
}

// ---------------------------------------------------------------------
// ConvergenceChart's own data mapping (Pass 11, Objective B, item 12) —
// pulled out of the component into a pure, DOM-free function so the
// numeric side of the chart (round filtering, gap math, x/y scaling,
// trade-round flagging) is directly testable, the same discipline
// describeTradeAnnotation above already follows. The component itself
// stays a thin renderer of whatever this returns; nothing here decides
// negotiation outcomes, only reads already-persisted round data.
// ---------------------------------------------------------------------

export interface ConvergenceChartPoint {
  x: number;
  y: number;
}

export interface ConvergenceChartRound {
  turn: number;
  buyerPrice: number;
  merchantPrice: number;
  gap: number;
  isTradeRound: boolean;
  buyerPoint: ConvergenceChartPoint;
  merchantPoint: ConvergenceChartPoint;
}

export interface ConvergenceChartData {
  rounds: ConvergenceChartRound[];
  buyerPath: string;
  merchantPath: string;
  gapPolygonPoints: string;
  /** Always a real number when this object exists at all — computeConvergenceChartData only ever returns non-null once there are >= 2 priced rounds, so there is always a latest gap to report. */
  currentGap: number;
  gapDirection: "narrowing" | "widening" | "holding" | null;
  /** True only when this negotiation ended in a real, persisted Agreement — a failed negotiation with a genuine remaining gap never gets a manufactured convergence point (Pass 11 addendum: "Failure = unresolved separation"). */
  converged: boolean;
}

const TRADE_MOVES = new Set(["DELIVERY_FOR_PRICE", "QUANTITY_FOR_PRICE", "QUANTITY_AND_DELIVERY_FOR_PRICE"]);

/** The minimal shape ConvergenceChart's data mapping actually reads off one transcript turn — deliberately structural rather than importing NegotiationDemo.tsx's own local TranscriptTurn type, so this stays a plain, standalone function. */
export interface ConvergenceChartTurnInput {
  turn: number;
  buyer: { unitPrice: number | null; move?: string | null } | null;
  merchant: { unitPrice: number | null; move?: string | null } | null;
}

/**
 * Every number ConvergenceChart draws, computed once as plain data — x/y
 * points on a fixed 0–100 (width) by 0–`viewHeight` (height) coordinate
 * system, real per-round gaps, and which rounds were a genuine trade
 * move. Returns null when there are fewer than 2 priced rounds (nothing
 * to draw a trajectory between yet — the chart itself only renders once
 * this is non-null, exactly mirroring the component's own prior
 * `rounds.length >= 2` gate).
 */
export function computeConvergenceChartData(
  transcript: ConvergenceChartTurnInput[],
  hasAgreement: boolean,
  isTerminal: boolean,
  viewHeight = 42,
): ConvergenceChartData | null {
  const rounds = transcript.filter(
    (t): t is ConvergenceChartTurnInput & { buyer: { unitPrice: number; move?: string | null }; merchant: { unitPrice: number; move?: string | null } } =>
      t.buyer?.unitPrice != null && t.merchant?.unitPrice != null,
  );
  if (rounds.length < 2) return null;

  const gaps = rounds.map((r) => Math.abs(r.merchant.unitPrice - r.buyer.unitPrice));
  const currentGap = gaps[gaps.length - 1];
  const prevGap = gaps.length >= 2 ? gaps[gaps.length - 2] : null;
  const gapDirection: ConvergenceChartData["gapDirection"] =
    prevGap !== null ? (currentGap < prevGap ? "narrowing" : currentGap > prevGap ? "widening" : "holding") : null;

  const allPrices = rounds.flatMap((r) => [r.buyer.unitPrice, r.merchant.unitPrice]);
  const rawMin = Math.min(...allPrices);
  const rawMax = Math.max(...allPrices);
  const rawRange = rawMax - rawMin || 1;
  const pad = rawRange * 0.12;
  const min = rawMin - pad;
  const max = rawMax + pad;
  const range = max - min || 1;

  const topMargin = 6;
  const bottomMargin = 6;
  const sideMargin = 4;
  const xFor = (i: number) => sideMargin + (i / Math.max(1, rounds.length - 1)) * (100 - 2 * sideMargin);
  const yFor = (price: number) => topMargin + (1 - (price - min) / range) * (viewHeight - topMargin - bottomMargin);

  const chartRounds: ConvergenceChartRound[] = rounds.map((r, i) => {
    const move = r.merchant?.move ?? r.buyer?.move ?? null;
    return {
      turn: r.turn,
      buyerPrice: r.buyer.unitPrice,
      merchantPrice: r.merchant.unitPrice,
      gap: gaps[i],
      isTradeRound: move !== null && TRADE_MOVES.has(move),
      buyerPoint: { x: xFor(i), y: yFor(r.buyer.unitPrice) },
      merchantPoint: { x: xFor(i), y: yFor(r.merchant.unitPrice) },
    };
  });

  const toPath = (points: ConvergenceChartPoint[]) => points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const buyerPoints = chartRounds.map((r) => r.buyerPoint);
  const merchantPoints = chartRounds.map((r) => r.merchantPoint);
  const gapPolygonPoints = `${buyerPoints.map((p) => `${p.x},${p.y}`).join(" ")} ${[...merchantPoints]
    .reverse()
    .map((p) => `${p.x},${p.y}`)
    .join(" ")}`;

  return {
    rounds: chartRounds,
    buyerPath: toPath(buyerPoints),
    merchantPath: toPath(merchantPoints),
    gapPolygonPoints,
    currentGap,
    gapDirection,
    converged: isTerminal && hasAgreement,
  };
}
