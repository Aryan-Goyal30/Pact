import { findCatalogItemBySku } from "@/lib/rules/catalogRepository";
import { getPublicManifest } from "@/lib/manifest";
import { createNegotiationSession } from "@/lib/negotiation/negotiationSessionRepository";
import { DEFAULT_MAX_ROUNDS } from "@/lib/rules/negotiationState";
import type { NegotiationSessionCreateRequest, NegotiationSessionResponse } from "@/types/negotiation";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseCreateRequest(body: unknown): NegotiationSessionCreateRequest | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { sku, quantity, maxUnitPrice, deliveryDeadlineDays, maxRounds } =
    body as Record<string, unknown>;

  if (typeof sku !== "string" || sku.trim().length === 0) {
    return null;
  }
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }
  if (typeof maxUnitPrice !== "number" || !Number.isFinite(maxUnitPrice) || maxUnitPrice <= 0) {
    return null;
  }
  if (
    typeof deliveryDeadlineDays !== "number" ||
    !Number.isFinite(deliveryDeadlineDays) ||
    deliveryDeadlineDays <= 0
  ) {
    return null;
  }
  if (maxRounds !== undefined && (typeof maxRounds !== "number" || maxRounds <= 0)) {
    return null;
  }

  return { sku, quantity, maxUnitPrice, deliveryDeadlineDays, maxRounds };
}

// POST /api/negotiations — creates a negotiation session and returns its
// initial (OPEN, round 0) state. Does NOT execute any turn — the caller
// drives the negotiation forward one exchange at a time via
// POST /api/negotiations/:id/turn. This is the turn-based counterpart
// to the single-shot POST /api/negotiate, which is untouched.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const createRequest = parseCreateRequest(body);
  if (!createRequest) {
    return jsonResponse(
      {
        error:
          "Invalid request body. Expected { sku: string, quantity: number, maxUnitPrice: number, deliveryDeadlineDays: number, maxRounds?: number }, all positive.",
      },
      400,
    );
  }

  try {
    const [item, manifest] = await Promise.all([
      findCatalogItemBySku(createRequest.sku),
      getPublicManifest(),
    ]);

    if (!item) {
      return jsonResponse({ error: `No catalog item found for SKU "${createRequest.sku}".` }, 404);
    }
    if (!manifest.products.some((product) => product.sku === createRequest.sku)) {
      return jsonResponse(
        { error: `SKU "${createRequest.sku}" is not present in the public manifest.` },
        404,
      );
    }

    const maxRounds = createRequest.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const session = await createNegotiationSession(
      createRequest.sku,
      {
        sku: createRequest.sku,
        quantity: createRequest.quantity,
        maxUnitPrice: createRequest.maxUnitPrice,
        deliveryDeadlineDays: createRequest.deliveryDeadlineDays,
      },
      maxRounds,
    );

    const response: NegotiationSessionResponse = {
      sessionId: session.id,
      sku: createRequest.sku,
      status: "OPEN",
      round: 0,
      maxRounds,
      buyerConstraints: {
        quantity: createRequest.quantity,
        maxUnitPrice: createRequest.maxUnitPrice,
        deliveryDeadlineDays: createRequest.deliveryDeadlineDays,
      },
    };
    return jsonResponse(response, 201);
  } catch (error) {
    console.error("Failed to create negotiation session:", error);
    return jsonResponse({ error: "Could not start negotiation." }, 500);
  }
}
