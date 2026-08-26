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
  computeBuyerConcessionPrice,
  resolveBuyerTarget,
  validateMerchantProposal,
  type BuyerConcessionContext,
  type BuyerConstraints,
  type BuyerValidationResult,
} from "@/lib/rules/buyerRules";
import { getLlmProvider, LlmUnavailableError } from "@/lib/llm/provider";

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

/**
 * Opens near the buyer's aspirational target rather than immediately
 * revealing its hard ceiling — only when a round context is supplied
 * AND the item actually supports negotiation. Without a round context
 * (e.g. an existing single-shot caller that predates this option), the
 * opening ask is the buyer's maxUnitPrice, exactly as before. On a
 * non-negotiable item there is nothing to gain by opening low — the
 * merchant only ever fulfills the exact listed price on those, so
 * lowballing would just get a real buyer wrongly rejected instead of
 * matched — so the buyer states its true ceiling there too.
 */
function buildOpeningRequest(
  constraints: BuyerConstraints,
  manifestProduct: PublicManifestProduct,
  concessionContext?: BuyerConcessionContext,
): BuyerAction {
  const aimForTarget = Boolean(concessionContext) && manifestProduct.negotiable;
  return {
    type: "request",
    sku: constraints.sku,
    quantity: constraints.quantity,
    unitPrice: aimForTarget ? resolveBuyerTarget(constraints) : constraints.maxUnitPrice,
    deliveryDays: constraints.deliveryDeadlineDays,
  };
}

function buildResponseToMerchantOffer(
  constraints: BuyerConstraints,
  merchantResult: NegotiationResult,
  concessionContext?: BuyerConcessionContext,
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

  // Not acceptable yet. Adopt whatever quantity/delivery the merchant
  // already offered — no reason to keep re-asking for terms it has
  // already granted — and move the price gradually toward (but never
  // past) the buyer's ceiling. With a round context, that movement is
  // the progressive computeBuyerConcessionPrice strategy; without one
  // (a caller that predates this option), it holds flat at
  // maxUnitPrice, exactly as before.
  return {
    action: {
      type: "counter_offer",
      sku: constraints.sku,
      quantity: proposal.quantity,
      unitPrice: concessionContext
        ? computeBuyerConcessionPrice(constraints, proposal.unitPrice, concessionContext)
        : constraints.maxUnitPrice,
      deliveryDays: proposal.deliveryDays,
    },
    validation,
  };
}

/**
 * Deterministic, non-LLM caption used only when no LLM provider is
 * configured (LlmUnavailableError). Built entirely from the
 * already-decided `action`, so it never fabricates a number or a
 * decision — it's a plain-English rendering of real data.
 */
function buildFallbackBuyerMessage(action: BuyerAction): string {
  switch (action.type) {
    case "request":
      return `I would like ${action.quantity} unit(s) of ${action.sku}, at up to ${action.unitPrice} each, delivered within ${action.deliveryDays} day(s).`;
    case "counter_offer":
      return `I can go up to ${action.unitPrice} per unit for ${action.quantity} unit(s), delivered within ${action.deliveryDays} day(s).`;
    case "accept":
      return `I accept: ${action.quantity} unit(s) at ${action.unitPrice} each, delivered in ${action.deliveryDays} day(s).`;
    case "reject":
      return "I'm unable to proceed with this offer.";
  }
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
  concessionContext?: BuyerConcessionContext,
): Promise<BuyerAgentResponse> {
  const { action, validation } =
    merchantResult === null
      ? { action: buildOpeningRequest(constraints, manifestProduct, concessionContext), validation: null }
      : buildResponseToMerchantOffer(constraints, merchantResult, concessionContext);

  let message: string;
  try {
    message = await getLlmProvider().generateAgentMessage({
      systemPrompt: BUYER_SYSTEM_PROMPT,
      context: {
        // targetUnitPrice is the buyer's OWN aspiration, not private
        // merchant data — safe to share, and helps the LLM phrase a
        // natural-sounding counter instead of a bare number.
        buyerConstraints: {
          sku: constraints.sku,
          quantity: constraints.quantity,
          maxUnitPrice: constraints.maxUnitPrice,
          targetUnitPrice: resolveBuyerTarget(constraints),
          deliveryDeadlineDays: constraints.deliveryDeadlineDays,
          buyerContext: constraints.buyerContext,
        },
        merchantListing: manifestProduct,
        action,
        validation,
      },
      instruction: "Write the buyer's message to the merchant for this action.",
    });
  } catch (error) {
    if (!(error instanceof LlmUnavailableError)) {
      throw error;
    }
    // No LLM provider is configured — fall back to a deterministic
    // caption instead of failing the whole negotiation turn. `action`
    // itself is completely unaffected; only the phrasing differs.
    message = buildFallbackBuyerMessage(action);
  }

  return { action, validation, message };
}
