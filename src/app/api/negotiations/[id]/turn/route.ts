import { findCatalogItemBySku } from "@/lib/rules/catalogRepository";
import { getPublicManifest } from "@/lib/manifest";
import { runNegotiationTurn } from "@/lib/negotiation/orchestrator";
import {
  loadLatestTurn,
  loadNegotiationSession,
  persistNegotiationTurn,
} from "@/lib/negotiation/negotiationSessionRepository";
import {
  ensureAgreementForSession,
  getAgreementBySessionId,
} from "@/lib/negotiation/agreementRepository";
import { toMessageDTO } from "@/lib/negotiation/negotiationRunResponse";
import { computeLeverage } from "@/lib/rules/leverage";
import type {
  LeverageScoreDTO,
  NegotiationTurnResponse,
  PersistedAgreementDTO,
} from "@/types/negotiation";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toAgreementDTO(persisted: {
  id: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  deliveryDays: number;
  totalAmount: number;
  status: string;
}): PersistedAgreementDTO {
  return {
    id: persisted.id,
    sku: persisted.sku,
    quantity: persisted.quantity,
    unitPrice: persisted.unitPrice,
    deliveryDays: persisted.deliveryDays,
    totalAmount: persisted.totalAmount,
    status: persisted.status,
  };
}

function toLeverageDTO(score: { buyerLeverage: number; merchantLeverage: number; reasons: string[] }): LeverageScoreDTO {
  return { buyer: score.buyerLeverage, merchant: score.merchantLeverage, reasons: score.reasons };
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
      // A repeated POST against an already-AGREED session is a safe,
      // idempotent replay of the same completed negotiation — not an
      // error. Serve it entirely from what's already persisted: no new
      // orchestrator turn, no LLM call, and no write (getAgreementBySessionId
      // only reads; ensureAgreementForSession is never called here). If the
      // Agreement or its closing turn is somehow missing despite the
      // session being AGREED, fall through to the generic 409 below rather
      // than fabricate a response.
      if (loaded.state.status === "AGREED") {
        const [agreement, lastTurn, item] = await Promise.all([
          getAgreementBySessionId(id),
          loadLatestTurn(id, loaded.sku),
          findCatalogItemBySku(loaded.sku),
        ]);
        if (agreement && lastTurn) {
          const leverage: LeverageScoreDTO = item
            ? toLeverageDTO(
                computeLeverage({
                  item,
                  buyerConstraints: loaded.buyerConstraints,
                  currentMerchantUnitPrice: agreement.unitPrice,
                }),
              )
            : { buyer: 50, merchant: 50, reasons: [] };
          const response: NegotiationTurnResponse = {
            sessionId: id,
            turn: lastTurn.turnNumber,
            buyer: lastTurn.buyer,
            merchant: lastTurn.merchant,
            status: loaded.state.status,
            round: loaded.state.round,
            maxRounds: loaded.state.maxRounds,
            agreement: toAgreementDTO(agreement),
            leverage,
          };
          return jsonResponse(response, 200);
        }
      }

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

    // Only ever create an Agreement from the deterministic engine's own
    // AGREED terms (turn.merchant.quantity/unitPrice/deliveryDays) —
    // never from turn.merchant.message, which is LLM-phrased text and
    // is not treated as authoritative data anywhere in this codebase.
    // ensureAgreementForSession is idempotent (Agreement.sessionId is a
    // unique column), so even if this turn were somehow re-entered for
    // an already-AGREED session, no duplicate row would result.
    let agreement: PersistedAgreementDTO | null = null;
    if (
      turn.state.status === "AGREED" &&
      turn.merchant.quantity !== null &&
      turn.merchant.unitPrice !== null &&
      turn.merchant.deliveryDays !== null
    ) {
      const { agreement: persisted } = await ensureAgreementForSession(id, {
        sku: loaded.sku,
        quantity: turn.merchant.quantity,
        unitPrice: turn.merchant.unitPrice,
        deliveryDays: turn.merchant.deliveryDays,
      });
      agreement = toAgreementDTO(persisted);
    }

    const response: NegotiationTurnResponse = {
      sessionId: id,
      turn: turnNumber,
      buyer: toMessageDTO(turn.buyer),
      merchant: toMessageDTO(turn.merchant),
      status: turn.state.status,
      round: turn.state.round,
      maxRounds: turn.state.maxRounds,
      agreement,
      leverage: toLeverageDTO(turn.leverage),
    };
    return jsonResponse(response, 200);
  } catch (error) {
    console.error("Negotiation turn failed:", error);
    return jsonResponse({ error: "Could not advance the negotiation." }, 500);
  }
}
