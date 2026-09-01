// Deterministic negotiation orchestrator — Phase 5A, Part 5.
//
//   Buyer structured proposal
//         v
//   Merchant deterministic evaluation
//         v
//   Merchant structured response
//         v
//   Buyer validation (drives the next call's proposal)
//         v
//   next turn
//
// runNegotiationTurn executes exactly one buyer -> merchant exchange.
// Every decision about whose turn it is, whether the negotiation is
// over, and what the actual offer terms are comes from deterministic
// code (buyerAgent's action-selection, the Phase 3 rule engine, and
// negotiationState's round/status machine). The LLM only ever supplies
// the natural-language `message` on each structured message — it is
// never consulted about, and cannot change, whose turn it is, the round
// count, or any structured field.

import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import type { PublicManifestProduct } from "@/types/manifest";
import {
  validateProposedAgreement,
  type NegotiationResult,
} from "@/lib/rules/negotiationEngine";
import type { BuyerConstraints } from "@/lib/rules/buyerRules";
import {
  acceptNegotiation,
  advanceNegotiationState,
  createNegotiationState,
  expireNegotiation,
  rejectNegotiation,
  type NegotiationState,
  type NegotiationStatus,
} from "@/lib/rules/negotiationState";
import { runBuyerAgent, runBuyerWalkAway, type BuyerAction, type BuyerAgentResponse } from "@/lib/agents/buyerAgent";
import { runMerchantAgent, runMerchantWalkAway } from "@/lib/agents/merchantAgent";
import type { StructuredNegotiationMessage } from "@/lib/negotiation/protocol";
import { computeLeverage, type LeverageScore } from "@/lib/rules/leverage";
import { arePositionsRepeated, isPriceGapUnbridgeable, type WalkAwayReason } from "@/lib/rules/walkAway";
import type { CandidateMoveType } from "@/lib/rules/candidateMove";

export interface NegotiationContext {
  item: CatalogItemSnapshot;
  manifestProduct: PublicManifestProduct;
  buyerConstraints: BuyerConstraints;
}

export interface NegotiationTurnResult {
  state: NegotiationState;
  buyer: StructuredNegotiationMessage;
  merchant: StructuredNegotiationMessage;
  /** Feed this into the next call's `previousMerchantResult`; null once the negotiation has closed. */
  nextMerchantResult: NegotiationResult | null;
  /** Live buyer-vs-merchant leverage score for this turn — see leverage.ts. Recomputed fresh every turn from the same deterministic factors driving the price/quantity/delivery math; never derived from or shown to the LLM. */
  leverage: LeverageScore;
}

/** The turn result shape before its leverage score is attached — see attachLeverage. */
type NegotiationTurnResultCore = Omit<NegotiationTurnResult, "leverage">;

const TERMINAL_STATUSES: NegotiationStatus[] = ["AGREED", "REJECTED", "EXPIRED"];

/**
 * Milestone 10: combines BuyerAgentResponse's two already-computed move
 * fields (move / tradeMove — see buyerAgent.ts) into the single public
 * CandidateMoveType this message carries. This is NOT a new decision —
 * buildResponseToMerchantOffer (buyerAgent.ts) already guarantees at most
 * one of the two carries a real value whenever a genuine candidate
 * selection happened this round (a trade winning sets tradeMove and
 * nulls move; the ordinary candidate winning sets move and leaves
 * tradeMove as "NO_TRADE"), and both are null whenever no selection was
 * made at all (opening request, ordinary accept, ordinary reject, or a
 * caller without a round context) — this function only picks whichever
 * of the two is actually populated.
 */
function resolveBuyerMove(response: Pick<BuyerAgentResponse, "move" | "tradeMove">): CandidateMoveType | undefined {
  if (
    response.tradeMove === "QUANTITY_FOR_PRICE" ||
    response.tradeMove === "DELIVERY_FOR_PRICE" ||
    response.tradeMove === "QUANTITY_AND_DELIVERY_FOR_PRICE"
  ) {
    return response.tradeMove;
  }
  if (response.move === "HOLD" || response.move === "CONCEDE") {
    return response.move;
  }
  return undefined;
}

function buyerActionToMessage(
  action: BuyerAction,
  text: string,
  move: CandidateMoveType | undefined,
): StructuredNegotiationMessage {
  return {
    sender: "buyer",
    type: action.type,
    sku: action.sku,
    quantity: action.quantity,
    unitPrice: action.unitPrice,
    deliveryDays: action.deliveryDays,
    message: text,
    move,
  };
}

function outcomeToMessageType(
  outcome: NegotiationResult["outcome"],
): StructuredNegotiationMessage["type"] {
  switch (outcome) {
    case "EXACT_MATCH":
      return "offer";
    case "COUNTER_OFFER":
    case "PARTIAL_FULFILLMENT":
      return "counter_offer";
    case "REJECTED":
      return "reject";
  }
}

function closeNegotiation(
  state: NegotiationState,
  buyerMessage: StructuredNegotiationMessage,
  terms: { sku: string; quantity: number; unitPrice: number; deliveryDays: number },
  accepted: boolean,
  rejectionReasons: string[],
  acceptMessage = "Accepted.",
): NegotiationTurnResultCore {
  return {
    state: accepted ? acceptNegotiation(state) : rejectNegotiation(state),
    buyer: buyerMessage,
    merchant: {
      sender: "merchant",
      type: accepted ? "accept" : "reject",
      sku: terms.sku,
      quantity: accepted ? terms.quantity : null,
      unitPrice: accepted ? terms.unitPrice : null,
      deliveryDays: accepted ? terms.deliveryDays : null,
      message: accepted ? acceptMessage : rejectionReasons.join(" ") || "Rejected.",
    },
    nextMerchantResult: null,
  };
}

/**
 * Executes exactly one buyer -> merchant exchange. Does not loop —
 * callers decide whether/when to run the next turn. See
 * runNegotiationToCompletion for a bounded convenience loop built on
 * top of this primitive.
 */
export async function runNegotiationTurn(
  context: NegotiationContext,
  state: NegotiationState,
  previousMerchantResult: NegotiationResult | null,
  /**
   * The buyer's own previous-round unit price, if any — used for
   * repeated-position deadlock detection (walkAway.ts) AND, as of
   * Milestone 3, as the price buyerMoveSelector.ts's HOLD move repeats.
   * Optional and additive: every existing caller that predates this
   * parameter behaves exactly as before, since omitting it simply means
   * the repeated-position check can never fire and the buyer's HOLD
   * falls back to its own aspirational target instead.
   */
  previousBuyerUnitPrice?: number | null,
  /**
   * The merchant's unit price from ONE ROUND BEFORE previousMerchantResult
   * — Milestone 3: lets the buyer's move selector detect whether the
   * merchant's most recent offer was genuine forward progress or a
   * repeat, without the buyer ever seeing item.minPrice. Optional and
   * additive: omitting it makes the buyer treat every offer as "the
   * merchant moved" (today's pre-Milestone-3 behavior — always concede).
   */
  priorMerchantUnitPrice?: number | null,
  /**
   * Milestone 5: the buyer's own quantity from ONE ROUND BEFORE this
   * one — lets the merchant recognize a genuine round-over-round
   * quantity increase (buyerAgent.ts's quantity-for-price trade) even
   * below the flat bulk-order threshold. Optional and additive: omitting
   * it reproduces exactly today's (pre-Milestone-5) trigger condition.
   */
  previousBuyerQuantity?: number | null,
  /**
   * Milestone 5: whether the buyer has already used its quantity-for-price
   * bargaining chip earlier in this same negotiation — derived by the
   * caller from actual negotiation history (see
   * runNegotiationToCompletion below / negotiationSessionRepository.ts),
   * never guessed here. Omitted (or false) leaves the chip available,
   * exactly as if this option didn't exist.
   */
  quantityTradeAlreadyUsed?: boolean,
  /**
   * Milestone 7: the buyer's own delivery-day ask from ONE ROUND BEFORE
   * this one — lets the merchant recognize a genuine round-over-round
   * delivery extension (buyerAgent.ts's delivery-for-price trade), and
   * lets the buyer's own acceptance ceiling widen when the merchant
   * mirrors back a later date the buyer itself already offered. Optional
   * and additive: omitting it reproduces exactly today's (pre-Milestone-7)
   * behavior. Tracked entirely independently from previousBuyerQuantity /
   * quantityTradeAlreadyUsed.
   */
  previousBuyerDeliveryDays?: number | null,
  /**
   * Milestone 7: whether the buyer has already used its delivery-for-price
   * bargaining chip earlier in this same negotiation — derived by the
   * caller from actual negotiation history, mirroring
   * quantityTradeAlreadyUsed exactly, for the delivery dimension.
   */
  deliveryTradeAlreadyUsed?: boolean,
): Promise<NegotiationTurnResult> {
  if (TERMINAL_STATUSES.includes(state.status)) {
    throw new Error(
      `Cannot run another negotiation turn: state is already terminal (${state.status}).`,
    );
  }

  // Attaches this turn's live leverage score, computed fresh from the
  // same deterministic factors (stock, quantity, urgency, delivery
  // flexibility, and this turn's own price position) driving the real
  // negotiation math — see leverage.ts. Wraps every return path below so
  // no branch can forget it.
  function finish(core: NegotiationTurnResultCore): NegotiationTurnResult {
    const leverage = computeLeverage({
      item: context.item,
      buyerConstraints: context.buyerConstraints,
      currentMerchantUnitPrice: core.merchant.unitPrice,
    });
    return { ...core, leverage };
  }

  // Milestone 2: closes the negotiation as a legitimate walk-away
  // (EXPIRED — a real outcome, not a system failure) instead of another
  // round of negotiation. Both buyer and merchant explain why through
  // the same LLM -> integrity -> fallback pipeline every other message
  // in this codebase already goes through; walkAway.ts never decides
  // price/quantity/delivery, only whether to stop.
  async function buildWalkAwayTurn(
    reason: WalkAwayReason,
    merchantOfferUnitPrice: number,
    buyerAskUnitPrice: number,
  ): Promise<NegotiationTurnResultCore> {
    const [buyerWalkAway, merchantWalkAway] = await Promise.all([
      runBuyerWalkAway(context.buyerConstraints, merchantOfferUnitPrice, reason),
      runMerchantWalkAway(buyerAskUnitPrice, reason),
    ]);

    const walkAwayMessage = (
      sender: "buyer" | "merchant",
      message: string,
    ): StructuredNegotiationMessage => ({
      sender,
      type: "reject",
      sku: context.buyerConstraints.sku,
      quantity: null,
      unitPrice: null,
      deliveryDays: null,
      message,
    });

    return {
      state: expireNegotiation(state),
      buyer: walkAwayMessage("buyer", buyerWalkAway.message),
      merchant: walkAwayMessage("merchant", merchantWalkAway.message),
      nextMerchantResult: null,
    };
  }

  // Structural impossibility: the buyer's ceiling is below the
  // merchant's floor, so no further round could ever succeed. Checked
  // only from the second call onward (previousMerchantResult !== null)
  // so the merchant's real, floor-clamped opening counter is still
  // visible in the transcript first — this closes on the NEXT turn
  // instead of repeating that same offer for the remaining rounds.
  if (
    previousMerchantResult !== null &&
    previousMerchantResult.unitPrice !== null &&
    isPriceGapUnbridgeable(context.item, context.buyerConstraints)
  ) {
    return finish(
      await buildWalkAwayTurn(
        "price_gap_unbridgeable",
        previousMerchantResult.unitPrice,
        context.buyerConstraints.maxUnitPrice,
      ),
    );
  }

  // Milestone 3: the buyer's own pre-round leverage score, computed from
  // the LAST round's merchant price (this round's hasn't been decided
  // yet) — only the aggregate 0-100 number crosses into buyerAgent.ts,
  // never context.item itself, preserving buyerAgent.ts's existing
  // invariant that it never sees item.minPrice or any other private
  // catalog field.
  //
  // Negotiation Engine V2: this SAME computeLeverage call already
  // produces the merchant's own complementary score (buyer + merchant
  // === 100, leverage.ts unchanged) — captured here too so it can be
  // threaded into runMerchantAgent below, making leverage causal for
  // both sides from the exact same, single, per-round computation
  // rather than a second call or a re-derivation.
  const preRoundLeverage = computeLeverage({
    item: context.item,
    buyerConstraints: context.buyerConstraints,
    currentMerchantUnitPrice: previousMerchantResult?.unitPrice ?? null,
  });
  const buyerLeverageScore = preRoundLeverage.buyerLeverage;

  const buyerResponse = await runBuyerAgent(
    context.buyerConstraints,
    context.manifestProduct,
    previousMerchantResult,
    { round: state.round + 1, maxRounds: state.maxRounds },
    {
      priorMerchantUnitPrice,
      previousBuyerUnitPrice,
      leverageScore: buyerLeverageScore,
      quantityTradeAlreadyUsed,
      previousBuyerQuantity,
      deliveryTradeAlreadyUsed,
      previousBuyerDeliveryDays,
    },
  );
  const buyerMessage = buyerActionToMessage(
    buyerResponse.action,
    buyerResponse.message,
    resolveBuyerMove(buyerResponse),
  );

  // The buyer deterministically decided (buyerRules.ts) to accept the
  // merchant's previous offer — close on those terms. No new merchant
  // round is needed; validateProposedAgreement is still run as a final
  // defensive check before turning this into an agreement.
  if (buyerResponse.action.type === "accept") {
    const agreementCheck = validateProposedAgreement(context.item, {
      sku: buyerResponse.action.sku,
      quantity: buyerResponse.action.quantity,
      unitPrice: buyerResponse.action.unitPrice,
      deliveryDays: buyerResponse.action.deliveryDays,
    });
    return finish(
      closeNegotiation(
        state,
        buyerMessage,
        buyerResponse.action,
        agreementCheck.outcome === "ACCEPTED",
        agreementCheck.reasons,
      ),
    );
  }

  // The buyer deterministically decided the merchant already rejected —
  // nothing left to negotiate.
  if (buyerResponse.action.type === "reject") {
    return finish({
      state: rejectNegotiation(state),
      buyer: buyerMessage,
      merchant: {
        sender: "merchant",
        type: "reject",
        sku: context.buyerConstraints.sku,
        quantity: null,
        unitPrice: null,
        deliveryDays: null,
        message: "Negotiation closed without an agreement.",
      },
      nextMerchantResult: null,
    });
  }

  // Buyer sent a genuine ask ("request" or "counter_offer"). The
  // merchant does NOT accept just because the ask clears its private
  // floor — minPrice is an absolute floor, not a target. It evaluates
  // the request deterministically and, when a price concession is
  // actually in play, prices its response with the round-aware
  // concession strategy (computeMerchantConcessionPrice) so it keeps
  // trying for the highest valid price across rounds instead of
  // caving to the buyer's number the first time it's technically
  // acceptable. The negotiation only ever closes when the BUYER
  // explicitly decides (via buyerRules.ts, in the branches above) that
  // a specific merchant offer is good enough to accept.
  const merchantAgentResponse = await runMerchantAgent(
    context.item,
    {
      sku: buyerResponse.action.sku,
      quantity: buyerResponse.action.quantity,
      maxUnitPrice: buyerResponse.action.unitPrice,
      deliveryDeadlineDays: buyerResponse.action.deliveryDays,
      deliveryFlexible: context.buyerConstraints.deliveryFlexible,
    },
    {
      round: state.round + 1,
      maxRounds: state.maxRounds,
      previousOfferUnitPrice: previousMerchantResult?.unitPrice ?? undefined,
    },
    // Milestone 4: previousBuyerUnitPrice is already threaded into this
    // function for walk-away/HOLD purposes — reused here, unchanged, so
    // the merchant can now react to whether the buyer's CURRENT ask
    // (buyerResponse.action.unitPrice, above) is a genuine concession
    // from its own prior ask, a hold, or a withdrawal.
    previousBuyerUnitPrice,
    // Milestone 5: lets the merchant recognize a genuine round-over-round
    // quantity increase (buyerResponse.action.quantity, above) even
    // below the flat bulk-order threshold.
    previousBuyerQuantity,
    // Milestone 7: lets the merchant recognize a genuine round-over-round
    // delivery extension (buyerResponse.action.deliveryDays, above).
    previousBuyerDeliveryDays,
    // Negotiation Engine V2: the same pre-round leverage snapshot the
    // buyer's own decision above already used, in {buyer, merchant} form.
    { buyer: preRoundLeverage.buyerLeverage, merchant: preRoundLeverage.merchantLeverage },
  );
  const merchantResult = merchantAgentResponse.decision;

  // EXACT_MATCH means the buyer's current ask already fully satisfies
  // the merchant — full quantity, standard delivery, and a price at or
  // above listed — with no concession needed at all (this is also what
  // stops the merchant from ever charging above its own listed price
  // just because a buyer's ceiling happens to be much higher: the
  // engine's price resolution already caps at listedPrice, so there is
  // nothing left to negotiate). Rather than present that as a
  // wishy-washy "offer" awaiting further confirmation, the merchant
  // accepts outright — this is its ACCEPT action, symmetric to the
  // buyer's.
  if (merchantResult.outcome === "EXACT_MATCH") {
    const terms = {
      sku: merchantResult.sku,
      quantity: merchantResult.offeredQuantity as number,
      unitPrice: merchantResult.unitPrice as number,
      deliveryDays: merchantResult.deliveryDays as number,
    };
    const agreementCheck = validateProposedAgreement(context.item, terms);
    return finish(
      closeNegotiation(
        state,
        buyerMessage,
        terms,
        agreementCheck.outcome === "ACCEPTED",
        agreementCheck.reasons,
        merchantAgentResponse.message,
      ),
    );
  }

  const nextState = advanceNegotiationState(state, merchantResult.outcome);

  // Repeated-position deadlock: only relevant when the negotiation would
  // otherwise continue as COUNTERED (never overrides an already-accepted
  // or already-rejected round) — both sides' prices exactly matching
  // their own previous round is treated as sufficient evidence that
  // neither has anything left to concede.
  if (
    nextState.status === "COUNTERED" &&
    arePositionsRepeated(
      { buyerUnitPrice: buyerResponse.action.unitPrice, merchantUnitPrice: merchantResult.unitPrice },
      { buyerUnitPrice: previousBuyerUnitPrice, merchantUnitPrice: previousMerchantResult?.unitPrice },
    )
  ) {
    return finish(
      await buildWalkAwayTurn(
        "repeated_positions",
        merchantResult.unitPrice as number,
        buyerResponse.action.unitPrice as number,
      ),
    );
  }

  return finish({
    state: nextState,
    buyer: buyerMessage,
    merchant: {
      sender: "merchant",
      type: outcomeToMessageType(merchantResult.outcome),
      sku: merchantResult.sku,
      quantity: merchantResult.offeredQuantity,
      unitPrice: merchantResult.unitPrice,
      deliveryDays: merchantResult.deliveryDays,
      message: merchantAgentResponse.message,
      move: merchantAgentResponse.move,
    },
    nextMerchantResult: nextState.status === "COUNTERED" ? merchantResult : null,
  });
}

export interface NegotiationRunResult {
  transcript: NegotiationTurnResult[];
  finalState: NegotiationState;
}

/**
 * Bounded convenience loop over runNegotiationTurn: keeps calling it
 * until the state machine reaches a terminal status. This is NOT an
 * unlimited autonomous loop — negotiationState.ts's own round/maxRounds
 * bookkeeping guarantees termination (the round limit forces EXPIRED),
 * and this function stops the instant that happens. A generous
 * iteration cap is still enforced defensively in case of a future logic
 * bug elsewhere in the chain.
 */
export async function runNegotiationToCompletion(
  context: NegotiationContext,
  maxRounds?: number,
): Promise<NegotiationRunResult> {
  let state = createNegotiationState(maxRounds);
  let previousMerchantResult: NegotiationResult | null = null;
  const transcript: NegotiationTurnResult[] = [];
  const safetyLimit = state.maxRounds + 3;

  while (!TERMINAL_STATUSES.includes(state.status)) {
    const previousBuyerUnitPrice = transcript[transcript.length - 1]?.buyer.unitPrice ?? null;
    // The merchant's price from ONE ROUND BEFORE previousMerchantResult
    // — i.e. two turns back in the transcript — see runNegotiationTurn's
    // priorMerchantUnitPrice parameter.
    const priorMerchantUnitPrice = transcript[transcript.length - 2]?.merchant.unitPrice ?? null;
    // Milestone 5: the buyer's own quantity one round back, and whether
    // the quantity-for-price chip has EVER been used across the WHOLE
    // transcript so far (not just the immediately previous round) —
    // scanning the full history, rather than a single-round lookback,
    // is what makes this reliable: a single-round comparison could
    // "forget" a trade used two rounds ago if the buyer's mirrored
    // quantity later drops back down (e.g. a subsequent partial-fulfillment
    // offer), which would wrongly let the chip fire again.
    const previousBuyerQuantity = transcript[transcript.length - 1]?.buyer.quantity ?? null;
    const quantityTradeAlreadyUsed = transcript.some(
      (t) => t.buyer.quantity !== null && t.buyer.quantity > context.buyerConstraints.quantity,
    );
    // Milestone 7: same full-history-scan discipline as the quantity
    // chip, tracked entirely independently — see
    // hasBuyerProposedDeliveryDaysAbove's own doc comment
    // (negotiationSessionRepository.ts) for why a single-round lookback
    // would be unreliable here too.
    const previousBuyerDeliveryDays = transcript[transcript.length - 1]?.buyer.deliveryDays ?? null;
    const deliveryTradeAlreadyUsed = transcript.some(
      (t) => t.buyer.deliveryDays !== null && t.buyer.deliveryDays > context.buyerConstraints.deliveryDeadlineDays,
    );
    const turn = await runNegotiationTurn(
      context,
      state,
      previousMerchantResult,
      previousBuyerUnitPrice,
      priorMerchantUnitPrice,
      previousBuyerQuantity,
      quantityTradeAlreadyUsed,
      previousBuyerDeliveryDays,
      deliveryTradeAlreadyUsed,
    );
    transcript.push(turn);
    state = turn.state;
    previousMerchantResult = turn.nextMerchantResult;

    if (transcript.length > safetyLimit) {
      throw new Error(
        "Negotiation exceeded its bounded round safety limit — this indicates a logic bug, not normal operation.",
      );
    }
  }

  return { transcript, finalState: state };
}
