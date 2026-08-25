// The Merchant Agent — Phase 4.
//
// Wraps the Phase 3 deterministic negotiation engine with an LLM-phrased
// explanation. The engine's NegotiationResult is the sole source of
// truth for every number in the response; Claude is only ever asked to
// turn that already-decided result into a sentence. It cannot change
// `decision` or `offer` — both are built directly from the engine's
// output before the LLM is even called.

import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import {
  evaluateNegotiationRequest,
  type NegotiationRequest,
  type NegotiationResult,
} from "@/lib/rules/negotiationEngine";
import {
  generateMerchantMessage,
  type MerchantMessageContext,
} from "@/lib/llm/claude";

export interface MerchantAgentOffer {
  sku: string;
  quantity: number;
  unitPrice: number;
  deliveryDays: number;
}

export interface MerchantAgentResponse {
  /** The authoritative deterministic result. The LLM never sees or touches this directly. */
  decision: NegotiationResult;
  /** Convenience view of the offer terms, or null when there's nothing to offer (REJECTED). */
  offer: MerchantAgentOffer | null;
  /** LLM-generated natural-language explanation of `decision`. */
  message: string;
}

/**
 * Strips a NegotiationResult down to exactly the fields Claude is
 * allowed to see. NegotiationResult itself never carries minPrice or
 * any other private catalog field (see negotiationEngine.ts), so this
 * is a safe 1:1 field mapping rather than a filter that could miss
 * something — there is nothing private left to accidentally forward.
 */
function toPublicContext(result: NegotiationResult): MerchantMessageContext {
  return {
    outcome: result.outcome,
    sku: result.sku,
    requestedQuantity: result.requestedQuantity,
    offeredQuantity: result.offeredQuantity,
    unitPrice: result.unitPrice,
    deliveryDays: result.deliveryDays,
    reasons: result.reasons,
  };
}

function toOffer(result: NegotiationResult): MerchantAgentOffer | null {
  if (
    result.offeredQuantity === null ||
    result.unitPrice === null ||
    result.deliveryDays === null
  ) {
    return null;
  }
  return {
    sku: result.sku,
    quantity: result.offeredQuantity,
    unitPrice: result.unitPrice,
    deliveryDays: result.deliveryDays,
  };
}

/**
 * Runs the Merchant Agent for one buyer request: evaluate with the
 * deterministic engine, then have Claude phrase the result. `item` is
 * whatever the caller's catalog lookup returned — pass null for "SKU
 * not found" (see catalogRepository.findCatalogItemBySku), the engine
 * handles it the same way it does everywhere else in the codebase.
 */
export async function runMerchantAgent(
  item: CatalogItemSnapshot | null,
  request: NegotiationRequest,
): Promise<MerchantAgentResponse> {
  const decision = evaluateNegotiationRequest(item, request);
  const message = await generateMerchantMessage(toPublicContext(decision));

  return {
    decision,
    offer: toOffer(decision),
    message,
  };
}
