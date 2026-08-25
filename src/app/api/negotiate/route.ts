import { findCatalogItemBySku } from "@/lib/rules/catalogRepository";
import { runMerchantAgent } from "@/lib/agents/merchantAgent";
import type { NegotiationRequest } from "@/lib/rules/negotiationEngine";
import { MissingApiKeyError } from "@/lib/llm/claude";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseNegotiationRequest(body: unknown): NegotiationRequest | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { sku, quantity, maxUnitPrice, deliveryDeadlineDays, buyerContext } =
    body as Record<string, unknown>;

  if (typeof sku !== "string" || sku.trim().length === 0) {
    return null;
  }
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    return null;
  }
  if (maxUnitPrice !== undefined && typeof maxUnitPrice !== "number") {
    return null;
  }
  if (deliveryDeadlineDays !== undefined && typeof deliveryDeadlineDays !== "number") {
    return null;
  }
  if (buyerContext !== undefined && typeof buyerContext !== "string") {
    return null;
  }

  return {
    sku,
    quantity,
    maxUnitPrice: maxUnitPrice as number | undefined,
    deliveryDeadlineDays: deliveryDeadlineDays as number | undefined,
    buyerContext: buyerContext as string | undefined,
  };
}

// POST /api/negotiate — the smallest possible endpoint exercising the
// Merchant Agent. Accepts one structured buyer request for one SKU,
// evaluates it with the deterministic engine, and returns that
// engine's authoritative result alongside Claude's phrasing of it.
//
// This is deliberately not a negotiation loop: one request in, one
// merchant-agent response out. The multi-round buyer/merchant exchange
// is a later phase.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const negotiationRequest = parseNegotiationRequest(body);
  if (!negotiationRequest) {
    return jsonResponse(
      {
        error:
          "Invalid request body. Expected { sku: string, quantity: number, maxUnitPrice?: number, deliveryDeadlineDays?: number, buyerContext?: string }.",
      },
      400,
    );
  }

  try {
    const item = await findCatalogItemBySku(negotiationRequest.sku);
    const agentResponse = await runMerchantAgent(item, negotiationRequest);
    return jsonResponse(agentResponse, 200);
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return jsonResponse({ error: error.message }, 503);
    }
    console.error("Merchant Agent request failed:", error);
    return jsonResponse({ error: "Merchant Agent is unavailable." }, 500);
  }
}
