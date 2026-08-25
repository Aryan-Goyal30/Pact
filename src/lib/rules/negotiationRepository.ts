import { findCatalogItemBySku } from "@/lib/rules/catalogRepository";
import {
  evaluateNegotiationRequest,
  type NegotiationRequest,
  type NegotiationResult,
} from "@/lib/rules/negotiationEngine";

/**
 * DB-touching entry point: looks up the requested SKU, then delegates to
 * the pure evaluateNegotiationRequest. Kept as a thin wrapper (mirroring
 * catalogRepository.ts) so the actual decision logic stays pure and
 * unit-testable without a database, while still giving future buyer/
 * merchant agent code a single call to make.
 */
export async function negotiateBySku(
  request: NegotiationRequest,
): Promise<NegotiationResult> {
  const item = await findCatalogItemBySku(request.sku);
  return evaluateNegotiationRequest(item, request);
}
