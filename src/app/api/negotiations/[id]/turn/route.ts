import { findCatalogItemBySku } from "@/lib/rules/catalogRepository";
import { getPublicManifest } from "@/lib/manifest";
import { runNegotiationTurn } from "@/lib/negotiation/orchestrator";
import {
  loadNegotiationSession,
  persistNegotiationTurn,
} from "@/lib/negotiation/negotiationSessionRepository";
import { toAgreement, toMessageDTO } from "@/lib/negotiation/negotiationRunResponse";
import type { NegotiationTurnResponse } from "@/types/negotiation";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TERMINAL_STATUSES = ["AGREED", "REJECTED", "EXPIRED"];

// POST /api/negotiations/:id/turn — advances one persisted negotiation
// session by exactly ONE buyer -> merchant exchange, using the real
// orchestrator (src/lib/negotiation/orchestrator.ts). Takes no body: the
// next move is entirely determined by the session's persisted state and
// the deterministic buyer/merchant strategies — nothing for a client to
// supply. Call this repeatedly (e.g. once per UI "next turn" action)
// until `status` comes back terminal.
export async function POST(_request: Request, context: RouteContext<"/api/negotiations/[id]/turn">) {
  const { id } = await context.params;

  try {
    const loaded = await loadNegotiationSession(id);
    if (!loaded) {
      return jsonResponse({ error: `No negotiation session found for id "${id}".` }, 404);
    }

    if (TERMINAL_STATUSES.includes(loaded.state.status)) {
      return jsonResponse(
        {
          error: `Negotiation session "${id}" already closed (${loaded.state.status}) and cannot continue.`,
        },
        409,
      );
    }

    const [item, manifest] = await Promise.all([
      findCatalogItemBySku(loaded.sku),
      getPublicManifest(),
    ]);

    if (!item) {
      return jsonResponse({ error: `No catalog item found for SKU "${loaded.sku}".` }, 404);
    }
    const manifestProduct = manifest.products.find((product) => product.sku === loaded.sku);
    if (!manifestProduct) {
      return jsonResponse(
        { error: `SKU "${loaded.sku}" is not present in the public manifest.` },
        404,
      );
    }

    const turn = await runNegotiationTurn(
      { item, manifestProduct, buyerConstraints: loaded.buyerConstraints },
      loaded.state,
      loaded.previousMerchantResult,
    );

    const { turnNumber } = await persistNegotiationTurn(id, turn);

    const response: NegotiationTurnResponse = {
      sessionId: id,
      turn: turnNumber,
      buyer: toMessageDTO(turn.buyer),
      merchant: toMessageDTO(turn.merchant),
      status: turn.state.status,
      round: turn.state.round,
      maxRounds: turn.state.maxRounds,
      agreement: toAgreement(loaded.sku, turn.state.status, turn),
    };
    return jsonResponse(response, 200);
  } catch (error) {
    console.error("Negotiation turn failed:", error);
    return jsonResponse({ error: "Could not advance the negotiation." }, 500);
  }
}
