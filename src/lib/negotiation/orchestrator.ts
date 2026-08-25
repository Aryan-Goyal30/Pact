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
  rejectNegotiation,
  type NegotiationState,
  type NegotiationStatus,
} from "@/lib/rules/negotiationState";
import { runBuyerAgent, type BuyerAction } from "@/lib/agents/buyerAgent";
import { runMerchantAgent } from "@/lib/agents/merchantAgent";
import type { StructuredNegotiationMessage } from "@/lib/negotiation/protocol";

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
}

const TERMINAL_STATUSES: NegotiationStatus[] = ["AGREED", "REJECTED", "EXPIRED"];

function buyerActionToMessage(action: BuyerAction, text: string): StructuredNegotiationMessage {
  return {
    sender: "buyer",
    type: action.type,
    sku: action.sku,
    quantity: action.quantity,
    unitPrice: action.unitPrice,
    deliveryDays: action.deliveryDays,
    message: text,
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
): NegotiationTurnResult {
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
      message: accepted ? "Accepted." : rejectionReasons.join(" ") || "Rejected.",
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
): Promise<NegotiationTurnResult> {
  if (TERMINAL_STATUSES.includes(state.status)) {
    throw new Error(
      `Cannot run another negotiation turn: state is already terminal (${state.status}).`,
    );
  }

  const buyerResponse = await runBuyerAgent(
    context.buyerConstraints,
    context.manifestProduct,
    previousMerchantResult,
  );
  const buyerMessage = buyerActionToMessage(buyerResponse.action, buyerResponse.message);

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
    return closeNegotiation(
      state,
      buyerMessage,
      buyerResponse.action,
      agreementCheck.outcome === "ACCEPTED",
      agreementCheck.reasons,
    );
  }

  // The buyer deterministically decided the merchant already rejected —
  // nothing left to negotiate.
  if (buyerResponse.action.type === "reject") {
    return {
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
    };
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
    },
    {
      round: state.round + 1,
      maxRounds: state.maxRounds,
      previousOfferUnitPrice: previousMerchantResult?.unitPrice ?? undefined,
    },
  );
  const merchantResult = merchantAgentResponse.decision;
  const nextState = advanceNegotiationState(state, merchantResult.outcome);

  return {
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
    },
    nextMerchantResult: nextState.status === "COUNTERED" ? merchantResult : null,
  };
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
    const turn = await runNegotiationTurn(context, state, previousMerchantResult);
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
