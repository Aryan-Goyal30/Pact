import { findCatalogItemBySku } from "@/lib/rules/catalogRepository";
import { getPublicManifest } from "@/lib/manifest";
import { runNegotiationToCompletion } from "@/lib/negotiation/orchestrator";
import { buildNegotiationRunResponse } from "@/lib/negotiation/negotiationRunResponse";
import type { NegotiationRunRequest } from "@/types/negotiation";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseRunRequest(body: unknown): NegotiationRunRequest | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { sku, quantity, maxUnitPrice, deliveryDeadlineDays } = body as Record<string, unknown>;

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

  return { sku, quantity, maxUnitPrice, deliveryDeadlineDays };
}

// POST /api/negotiations — runs the FULL bounded Buyer Agent <-> Merchant
// Agent negotiation (src/lib/negotiation/orchestrator.ts) for one buyer
// request and returns the resulting transcript, final status, and (when
// AGREED) agreement summary. This is the multi-round counterpart to the
// existing single-shot POST /api/negotiate — that route is untouched.
//
// The response is built exclusively by buildNegotiationRunResponse,
// which explicitly whitelists fields from the orchestrator's output.
// CatalogItemSnapshot (which carries minPrice) is only ever used
// server-side, inside the orchestrator/rule engine — it never appears
// in anything returned from this handler.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const runRequest = parseRunRequest(body);
  if (!runRequest) {
    return jsonResponse(
      {
        error:
          "Invalid request body. Expected { sku: string, quantity: number, maxUnitPrice: number, deliveryDeadlineDays: number }, all positive.",
      },
      400,
    );
  }

  try {
    const [item, manifest] = await Promise.all([
      findCatalogItemBySku(runRequest.sku),
      getPublicManifest(),
    ]);

    if (!item) {
      return jsonResponse({ error: `No catalog item found for SKU "${runRequest.sku}".` }, 404);
    }

    const manifestProduct = manifest.products.find((product) => product.sku === runRequest.sku);
    if (!manifestProduct) {
      return jsonResponse(
        { error: `SKU "${runRequest.sku}" is not present in the public manifest.` },
        404,
      );
    }

    const { transcript, finalState } = await runNegotiationToCompletion({
      item,
      manifestProduct,
      buyerConstraints: {
        sku: runRequest.sku,
        quantity: runRequest.quantity,
        maxUnitPrice: runRequest.maxUnitPrice,
        deliveryDeadlineDays: runRequest.deliveryDeadlineDays,
      },
    });

    return jsonResponse(
      buildNegotiationRunResponse(runRequest.sku, transcript, finalState),
      200,
    );
  } catch (error) {
    console.error("Negotiation run failed:", error);
    return jsonResponse({ error: "Negotiation is unavailable." }, 500);
  }
}
