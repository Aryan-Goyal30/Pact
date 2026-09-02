// Natural-language buyer intent parsing — Roadmap Step 1.
//
// Converts a buyer's free-form text into the SAME structured request
// shape the existing manual form already produces (see negotiationUi.ts's
// ParsedBuyerRequest / types/negotiation.ts's NegotiationSessionCreateRequest).
// This module makes NO negotiation decision itself, never talks to the
// negotiation engine, and is not a conversational agent — it is a single
// extraction step: freeform text in, a validated structured request (or
// a clear "what's missing" report) out.
//
// The LLM here is used ONLY to propose candidate field values. Nothing
// it proposes is trusted directly:
//  - the product must resolve to a REAL catalog SKU passed in by the
//    caller (see PublicManifestProduct) — the model can never invent a
//    product; an unmatched name is reported back to the user, never
//    guessed at or silently dropped.
//  - every numeric/enum field is independently type- and range-checked
//    before being used for anything.
//  - a field the model could not confidently determine (null/absent, or
//    fails validation) is reported as MISSING — never filled in with an
//    invented default. The only two fields that DO get a default when
//    unstated are `urgency` ("medium") and `deliveryFlexible` (false) —
//    the exact same defaults BuyerConstraints itself already applies
//    when those optional fields are omitted (see buyerRules.ts), so this
//    never invents a preference the buyer didn't express; it only
//    reproduces the system's own pre-existing "no preference stated"
//    behavior.
//
// A successful parse produces exactly the fields a person could have
// typed into the existing structured form by hand — see
// buyerIntentToSessionRequest below for the (trivial, renaming-only)
// mapping onto NegotiationSessionCreateRequest, which is what actually
// starts a negotiation via the existing, unmodified POST /api/negotiations.

import { getLlmProvider, LlmUnavailableError } from "@/lib/llm/provider";
import type { PublicManifestProduct } from "@/types/manifest";
import type { UrgencyLevel } from "@/lib/rules/negotiationStrategy";
import type { NegotiationSessionCreateRequest } from "@/types/negotiation";

/**
 * The structured buyer intent this module extracts — the same fields
 * the existing form collects (sku/quantity/maxUnitPrice/
 * deliveryDeadlineDays/urgency/deliveryFlexible), plus an optional
 * aspirational `targetPrice`. `targetPrice` maps onto
 * BuyerConstraints.targetUnitPrice (buyerRules.ts) — a field the
 * deterministic buyer strategy already supports, just not previously
 * reachable through the manual form or the session-create API.
 */
export interface BuyerIntent {
  sku: string;
  productName: string;
  quantity: number;
  targetPrice?: number;
  maxPrice: number;
  deliveryDeadlineDays: number;
  urgency: UrgencyLevel;
  deliveryFlexible: boolean;
}

/** A required field the parser could not confidently determine. */
export type BuyerIntentField = "product" | "quantity" | "maxPrice" | "deliveryDeadlineDays";

export type BuyerIntentParseResult =
  | { status: "ok"; intent: BuyerIntent }
  | {
      /** Some required field(s) could not be confidently determined. */
      status: "missing_fields";
      /** Whatever WAS confidently understood — used to pre-fill the fallback form so the user only has to supply what's missing, never re-enter what was already understood. */
      understood: Partial<BuyerIntent>;
      missingFields: BuyerIntentField[];
      message: string;
    }
  | {
      /** The text named a product, but it doesn't match anything in the real catalog — never guessed at. */
      status: "unknown_product";
      understood: Partial<BuyerIntent>;
      message: string;
    }
  | {
      /** The LLM was unavailable, or its output could not be read as the expected structure at all. */
      status: "unparseable";
      message: string;
    };

const VALID_URGENCY_LEVELS = new Set<string>(["low", "medium", "high"]);

function buildSystemPrompt(): string {
  return [
    "You extract STRUCTURED PURCHASE INTENT from one buyer's free-form message.",
    "You are not a chatbot and you do not converse — you output exactly one JSON object and nothing else, no markdown fences, no commentary.",
    "Never invent a product, price, quantity, or delivery deadline the message does not support — use null for anything not clearly stated or not confidently inferable.",
    "The product MUST be chosen from the provided catalog by its exact sku string — never invent a sku or a product name that isn't in the catalog.",
  ].join(" ");
}

function buildInstruction(catalog: PublicManifestProduct[]): string {
  const catalogLines = catalog
    .map((product) => `- sku: "${product.sku}", name: "${product.name}", description: "${product.description}"`)
    .join("\n");

  return [
    `Catalog (choose the single sku the buyer most likely means, or null if nothing plausibly matches):\n${catalogLines}`,
    "",
    "Return ONLY a single JSON object with exactly these keys:",
    "{",
    '  "sku": string | null,',
    '  "quantity": number | null,',
    '  "targetPrice": number | null,',
    '  "maxPrice": number | null,',
    '  "deliveryDeadlineDays": number | null,',
    '  "urgency": "low" | "medium" | "high" | null,',
    '  "deliveryFlexible": boolean | null',
    "}",
    "",
    '"maxPrice" is the buyer\'s hard ceiling per unit. If the buyer mentions a preferred/target number AND a higher number they could stretch to, the higher one is maxPrice and the lower one is targetPrice. If only one price is stated, use it as maxPrice and leave targetPrice null.',
    '"deliveryFlexible" is true only if the buyer explicitly signals willingness to accept a later delivery date in exchange for a better price.',
    '"urgency" reflects how time-pressured the buyer sounds — use "medium" only when genuinely unclear, "high" when the buyer stresses speed, "low" when the buyer says they can wait.',
  ].join("\n");
}

/** Strips markdown code fences (if any) and extracts the first balanced-looking `{...}` object, then parses it. Returns null on anything that doesn't parse as a plain JSON object. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toPositiveNumber(value: unknown, round: boolean): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return round ? Math.round(value) : value;
}

const MISSING_FIELD_LABELS: Record<BuyerIntentField, string> = {
  product: "which product you'd like",
  quantity: "how many you need",
  maxPrice: "your maximum budget",
  deliveryDeadlineDays: "your delivery deadline",
};

function joinWithAnd(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function buildMissingFieldsMessage(missingFields: BuyerIntentField[]): string {
  const list = joinWithAnd(missingFields.map((field) => MISSING_FIELD_LABELS[field]));
  return missingFields.length < 4
    ? `I understood part of your request, but I still need to know ${list} before I can negotiate.`
    : "I couldn't confidently understand your request — please fill in the details below.";
}

/** Never trusts the model's proposed values directly — every field is independently re-validated, and the product is matched against the real catalog, not the model's own claim. */
function normalizeCandidate(
  candidate: Record<string, unknown>,
  catalog: PublicManifestProduct[],
): BuyerIntentParseResult {
  const quantity = toPositiveNumber(candidate.quantity, true);
  const maxPrice = toPositiveNumber(candidate.maxPrice, false);
  const targetPrice = toPositiveNumber(candidate.targetPrice, false);
  const deliveryDeadlineDays = toPositiveNumber(candidate.deliveryDeadlineDays, true);
  const urgency: UrgencyLevel =
    typeof candidate.urgency === "string" && VALID_URGENCY_LEVELS.has(candidate.urgency)
      ? (candidate.urgency as UrgencyLevel)
      : "medium";
  const deliveryFlexible = candidate.deliveryFlexible === true;

  const rawSku = typeof candidate.sku === "string" ? candidate.sku.trim() : "";
  const matchedProduct = rawSku
    ? catalog.find((product) => product.sku.toLowerCase() === rawSku.toLowerCase())
    : undefined;

  const understood: Partial<BuyerIntent> = {
    ...(matchedProduct ? { sku: matchedProduct.sku, productName: matchedProduct.name } : {}),
    ...(quantity !== null ? { quantity } : {}),
    ...(targetPrice !== null ? { targetPrice } : {}),
    ...(maxPrice !== null ? { maxPrice } : {}),
    ...(deliveryDeadlineDays !== null ? { deliveryDeadlineDays } : {}),
    urgency,
    deliveryFlexible,
  };

  // The model named something, but it isn't a real product — reported
  // back directly rather than guessed at further, per the "never let
  // the LLM invent a product" requirement.
  if (rawSku.length > 0 && !matchedProduct) {
    return {
      status: "unknown_product",
      understood,
      message:
        catalog.length > 0
          ? `I couldn't match your request to a product we sell. We currently offer: ${catalog.map((p) => p.name).join(", ")}.`
          : "I couldn't match your request to a product we sell.",
    };
  }

  const missingFields: BuyerIntentField[] = [];
  if (!matchedProduct) missingFields.push("product");
  if (quantity === null) missingFields.push("quantity");
  if (maxPrice === null) missingFields.push("maxPrice");
  if (deliveryDeadlineDays === null) missingFields.push("deliveryDeadlineDays");

  if (missingFields.length > 0) {
    return {
      status: "missing_fields",
      understood,
      missingFields,
      message: buildMissingFieldsMessage(missingFields),
    };
  }

  return {
    status: "ok",
    intent: {
      sku: matchedProduct!.sku,
      productName: matchedProduct!.name,
      quantity: quantity!,
      targetPrice: targetPrice ?? undefined,
      maxPrice: maxPrice!,
      deliveryDeadlineDays: deliveryDeadlineDays!,
      urgency,
      deliveryFlexible,
    },
  };
}

/**
 * Parses one buyer's free-form text into a BuyerIntent, or a report of
 * what's missing/unclear. `catalog` is the caller-supplied, real,
 * authoritative product list (see getPublicManifest()) — the only
 * source of truth for what a "product" can resolve to. Never throws for
 * an LLM failure or malformed output; those become `status: "unparseable"`
 * so the caller can gracefully fall back to the existing structured form.
 */
export async function parseBuyerIntent(
  text: string,
  catalog: PublicManifestProduct[],
): Promise<BuyerIntentParseResult> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { status: "unparseable", message: "Please describe what you'd like to buy." };
  }

  let raw: string;
  try {
    const provider = getLlmProvider();
    raw = await provider.generateAgentMessage({
      systemPrompt: buildSystemPrompt(),
      instruction: buildInstruction(catalog),
      context: { buyerMessage: trimmed },
    });
  } catch (error) {
    if (error instanceof LlmUnavailableError) {
      return {
        status: "unparseable",
        message: "Automatic understanding isn't available right now — please fill in the details below.",
      };
    }
    throw error;
  }

  const candidate = extractJsonObject(raw);
  if (!candidate) {
    return {
      status: "unparseable",
      message: "I couldn't understand that request — please fill in the details below.",
    };
  }

  return normalizeCandidate(candidate, catalog);
}

/**
 * Maps a fully-resolved BuyerIntent onto the exact request shape the
 * existing structured form already sends to POST /api/negotiations (see
 * negotiationUi.ts's parseBuyerRequestForm / ParsedBuyerRequest) — pure
 * renaming, no negotiation decision of any kind. `targetUnitPrice` is
 * the one field the manual form doesn't collect today; it is optional
 * everywhere it flows (types/negotiation.ts, the session-create route,
 * BuyerConstraints), so omitting it here reproduces the exact existing
 * behavior for every other caller.
 */
export function buyerIntentToSessionRequest(intent: BuyerIntent): NegotiationSessionCreateRequest {
  return {
    sku: intent.sku,
    quantity: intent.quantity,
    maxUnitPrice: intent.maxPrice,
    deliveryDeadlineDays: intent.deliveryDeadlineDays,
    urgency: intent.urgency,
    deliveryFlexible: intent.deliveryFlexible,
    targetUnitPrice: intent.targetPrice,
  };
}
