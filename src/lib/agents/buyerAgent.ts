// The Buyer Agent — Phase 5A, Part 3.
//
// Symmetric to merchantAgent.ts: a deterministic decision (what action
// to take — request / accept / reject / counter_offer, and with exactly
// which numbers) is made first by plain code, and the LLM is only ever
// asked to phrase that already-decided action as a message. The LLM
// never chooses the action or its numbers, and the system never parses
// its message back into structured data (see negotiation/protocol.ts).
//
// The Buyer Agent only ever sees: the buyer's own constraints, the
// merchant's public manifest listing for the SKU (PublicManifestProduct
// — exactly what GET /api/manifest would return), and the merchant's
// last NegotiationResult (which, like the manifest, never carries
// minPrice or any other private field — see negotiationEngine.ts).
// CatalogItemSnapshot is never imported here.
//
// Objective, mirrored against the merchant's: the buyer seeks the
// LOWEST acceptable price, the merchant seeks the HIGHEST valid price
// (see negotiationEngine.ts's computeMerchantConcessionPrice). The
// buyer enforces its side of that by never conceding upward past its
// own maxUnitPrice (isPriceAcceptable in buyerRules.ts is a hard
// ceiling, not a target) and by holding at that ceiling on every
// counter_offer rather than proposing something higher just to close
// faster — it only ever accepts a specific merchant offer once that
// offer's own price already satisfies the ceiling, never before.

import type { PublicManifestProduct } from "@/types/manifest";
import type { NegotiationResult, ProposedAgreement } from "@/lib/rules/negotiationEngine";
import {
  validateMerchantProposal,
  type BuyerConstraints,
  type BuyerValidationResult,
} from "@/lib/rules/buyerRules";
import { getLlmProvider } from "@/lib/llm/provider";

export type BuyerAction =
  | ({ type: "request" } & ProposedAgreement)
  | ({ type: "counter_offer" } & ProposedAgreement)
  | ({ type: "accept" } & ProposedAgreement)
  | { type: "reject"; sku: string; quantity: null; unitPrice: null; deliveryDays: null };

export interface BuyerAgentResponse {
  action: BuyerAction;
  /** null only for the opening request, where there is no merchant offer yet to validate. */
  validation: BuyerValidationResult | null;
  message: string;
}

const BUYER_SYSTEM_PROMPT = `You are PACT's Buyer Agent, communicating with a merchant's AI agent on behalf of the buyer.

You will be given the buyer's own requirement and an AUTHORITATIVE structured action that has already been decided by deterministic code — what to request, or whether to accept, reject, or counter the merchant's last offer, with exact numbers. You do not decide any of this yourself and must not propose different numbers.

Your only job is to phrase that action as a short, professional message to the merchant. Rules:
- Speak in first person as the buyer (e.g. "I need...", "I can accept...", "That's above my budget...").
- Be concise: 1-3 sentences, plain text only (no markdown, no JSON).
- State only the quantity, unit price, and delivery days EXACTLY as given — never invent, round, or change any number.
- Do not claim a deal is done unless the action type is "accept".
- Never mention a number, product, or constraint that wasn't given to you.`;

function buildOpeningRequest(constraints: BuyerConstraints): BuyerAction {
  return {
    type: "request",
    sku: constraints.sku,
    quantity: constraints.quantity,
    unitPrice: constraints.maxUnitPrice,
    deliveryDays: constraints.deliveryDeadlineDays,
  };
}

function buildResponseToMerchantOffer(
  constraints: BuyerConstraints,
  merchantResult: NegotiationResult,
): { action: BuyerAction; validation: BuyerValidationResult } {
  if (
    merchantResult.outcome === "REJECTED" ||
    merchantResult.offeredQuantity === null ||
    merchantResult.unitPrice === null ||
    merchantResult.deliveryDays === null
  ) {
    return {
      action: { type: "reject", sku: constraints.sku, quantity: null, unitPrice: null, deliveryDays: null },
      validation: { outcome: "UNACCEPTABLE", reasons: merchantResult.reasons },
    };
  }

  const proposal: ProposedAgreement = {
    sku: merchantResult.sku,
    quantity: merchantResult.offeredQuantity,
    unitPrice: merchantResult.unitPrice,
    deliveryDays: merchantResult.deliveryDays,
  };

  const validation = validateMerchantProposal(constraints, proposal);

  if (validation.outcome === "ACCEPTABLE") {
    return { action: { type: "accept", ...proposal }, validation };
  }

  // Not acceptable yet. Hold at the buyer's own price ceiling — it's a
  // hard constraint the buyer cannot exceed (see buyerRules.ts) — while
  // adopting whatever quantity/delivery the merchant already offered,
  // since there's no reason to keep re-asking for terms the merchant
  // has already granted.
  return {
    action: {
      type: "counter_offer",
      sku: constraints.sku,
      quantity: proposal.quantity,
      unitPrice: constraints.maxUnitPrice,
      deliveryDays: proposal.deliveryDays,
    },
    validation,
  };
}

/**
 * Runs the Buyer Agent for one turn. `merchantResult` is null for the
 * buyer's opening move (no merchant response exists yet); otherwise the
 * buyer deterministically decides to accept/reject/counter by checking
 * it against its own constraints (buyerRules.ts) — the LLM only phrases
 * whichever action was decided.
 */
export async function runBuyerAgent(
  constraints: BuyerConstraints,
  manifestProduct: PublicManifestProduct,
  merchantResult: NegotiationResult | null,
): Promise<BuyerAgentResponse> {
  const { action, validation } =
    merchantResult === null
      ? { action: buildOpeningRequest(constraints), validation: null }
      : buildResponseToMerchantOffer(constraints, merchantResult);

  const message = await getLlmProvider().generateAgentMessage({
    systemPrompt: BUYER_SYSTEM_PROMPT,
    context: {
      buyerConstraints: {
        sku: constraints.sku,
        quantity: constraints.quantity,
        maxUnitPrice: constraints.maxUnitPrice,
        deliveryDeadlineDays: constraints.deliveryDeadlineDays,
        buyerContext: constraints.buyerContext,
      },
      merchantListing: manifestProduct,
      action,
      validation,
    },
    instruction: "Write the buyer's message to the merchant for this action.",
  });

  return { action, validation, message };
}
