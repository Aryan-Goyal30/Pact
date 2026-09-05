// Pure helpers for BuyerConversation.tsx — same discipline as
// negotiationUi.ts/paymentUi.ts: the non-trivial logic lives here,
// unit-testable without a browser/DOM environment, so the component
// itself stays thin and presentational. Nothing here calls an LLM,
// talks to the negotiation engine, or invents a value — every function
// is a deterministic transform of data the caller already has (the
// real public catalog, or fields the existing parser already
// confidently returned).

import type { PublicManifestProduct } from "@/types/manifest";
import type { BuyerIntent, BuyerIntentField } from "@/lib/negotiation/buyerIntentParser";

/** Currency formatting shared with the rest of /negotiate. */
export function formatInr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * The first still-missing required field, in a natural asking order —
 * or null once all four are present. These are the same four fields the
 * negotiation engine actually requires before a turn can begin
 * (BuyerConstraints — buyerRules.ts), asked about in this fixed order:
 * what, how many, at what price, by when.
 */
export function nextMissingField(understood: Partial<BuyerIntent>): BuyerIntentField | null {
  if (!understood.sku) return "product";
  if (understood.quantity === undefined) return "quantity";
  if (understood.maxPrice === undefined) return "maxPrice";
  if (understood.deliveryDeadlineDays === undefined) return "deliveryDeadlineDays";
  return null;
}

export function isBuyerIntentComplete(understood: Partial<BuyerIntent>): understood is BuyerIntent {
  return nextMissingField(understood) === null;
}

/** Applies the exact same "unstated -> default" rule BuyerConstraints itself already applies (buyerRules.ts) once the four required fields are present — never invents a stronger preference than "no preference stated". Returns null if a required field is still missing. */
export function withDefaults(understood: Partial<BuyerIntent>): BuyerIntent | null {
  if (!isBuyerIntentComplete(understood)) return null;
  return {
    ...understood,
    urgency: understood.urgency ?? "medium",
    deliveryFlexible: understood.deliveryFlexible ?? false,
    budgetFlexible: understood.budgetFlexible ?? false,
  };
}

/**
 * A natural, ONLY-real-data summary clause of whatever's understood so
 * far — e.g. "20 × 24-inch Full HD Monitor at up to ₹9,000/unit". Never
 * fabricates a field that isn't present; simply omits it. Returns null
 * when nothing at all is understood yet (nothing to summarize).
 */
export function describeUnderstood(u: Partial<BuyerIntent>): string | null {
  const parts: string[] = [];

  if (u.quantity !== undefined && u.productName) {
    parts.push(`${u.quantity} × ${u.productName}`);
  } else if (u.productName) {
    parts.push(u.productName);
  } else if (u.quantity !== undefined) {
    parts.push(`${u.quantity} units`);
  }

  if (u.maxPrice !== undefined) {
    parts.push(`up to ${formatInr(u.maxPrice)}/unit`);
  }

  if (u.deliveryDeadlineDays !== undefined) {
    parts.push(`delivery within ${u.deliveryDeadlineDays} day(s)`);
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} at ${parts[parts.length - 1]}`;
}

const MISSING_FIELD_QUESTION: Record<BuyerIntentField, (u: Partial<BuyerIntent>) => string> = {
  product: () => "What product are you looking for?",
  quantity: () => "How many do you need?",
  maxPrice: () => "What's your maximum budget per unit?",
  deliveryDeadlineDays: () => "When do you need them delivered?",
};

/** The single targeted question to ask for one missing field — real product context where known, never a generic form dump. */
export function questionForMissingField(field: BuyerIntentField, understood: Partial<BuyerIntent>): string {
  return MISSING_FIELD_QUESTION[field](understood);
}

// ---------------------------------------------------------------------------
// Contextual short answers (Buyer Intake audit, pass 9) — a small,
// deterministic interpretation of a SHORT, unambiguous reply to
// whichever field is currently being asked about (nextMissingField's own
// return value) — e.g. a bare "5" right after "How many do you need?",
// or "46k" right after the budget question. This is the SAME discipline
// the existing quick-reply handlers (handleSelectDelivery,
// handleContinueWithStock, ...) already use: resolve the cases simple
// enough to have zero ambiguity without a round trip, and defer
// everything else — a full sentence, a correction, several fields
// stated together, anything that isn't cleanly one of these patterns —
// to the real parser, completely unchanged. Never invents a value: a
// non-match returns null, and the caller falls through to the existing
// whole-transcript parse exactly as before this pass. "product" is
// deliberately never handled here — matching free text against the
// catalog is not a job for a regex, and the existing catalog-card
// quick-replies already cover the common case well.
// ---------------------------------------------------------------------------

/**
 * Interprets `text` as a short, unambiguous answer for `field` — or
 * returns null if it isn't one. Only ever called by the caller when
 * `field` is the field CURRENTLY being asked about (nextMissingField),
 * so a bare number is never misapplied to the wrong question.
 */
export function matchShortAnswer(field: BuyerIntentField, text: string): number | null {
  const trimmed = text.trim();
  switch (field) {
    case "quantity": {
      const match = trimmed.match(/^(\d{1,6})(?:\s*(?:units?|pcs?|pieces?))?$/i);
      if (!match) return null;
      const value = Number(match[1]);
      return value > 0 ? value : null;
    }
    case "maxPrice": {
      const match = trimmed.match(/^(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?$/i);
      if (!match) return null;
      const raw = Number(match[1].replace(/,/g, ""));
      if (!Number.isFinite(raw) || raw <= 0) return null;
      return Math.round(match[2] ? raw * 1000 : raw);
    }
    case "deliveryDeadlineDays": {
      const match = trimmed.match(/^(?:within\s+)?(\d{1,4})\s*(?:days?)?$/i);
      if (!match) return null;
      const value = Number(match[1]);
      return value > 0 ? value : null;
    }
    case "product":
      return null;
  }
}

/** A spec-shaped token (RAM/storage/screen size etc.) anywhere in the text — the same pattern findUnmatchedSpec uses. Used to keep matchCurrentFieldAnswer from ever stealing a genuine spec-mismatch mention (e.g. "12gb") as if it were a plain number answering quantity. */
const SPEC_TOKEN_PATTERN = /\d+\s?(?:gb|tb|mb|inch|mp|mah)\b/i;

const CURRENT_FIELD_COMPETING_KEYWORD: Record<Exclude<BuyerIntentField, "product">, RegExp> = {
  quantity: /\bday|₹|\brs\.?\b|\binr\b|\bbudget\b|\bmax(?:imum)?\b|\bprice\b|\bspend\b/i,
  maxPrice: /\bday|\bneed\b|\bunits?\b|\bpcs\b|\bpieces?\b/i,
  deliveryDeadlineDays: /₹|\brs\.?\b|\binr\b|\bbudget\b|\bmax(?:imum)?\b|\bprice\b|\bspend\b|\bneed\b|\bunits?\b|\bpcs\b|\bpieces?\b/i,
};

/**
 * A natural-language answer to whichever field is CURRENTLY being
 * asked about — more lenient than matchShortAnswer (not anchored to
 * the whole message), since a real answer often comes wrapped in
 * ordinary sentence structure: "i can go upto 45000", "my max is
 * 45000", "I can spend up to ₹45,000" (Buyer Intake audit, pass 11.1).
 *
 * Checked as the HIGHEST-priority deterministic match in
 * BuyerConversation.tsx's submitUtterance — a valid answer to the
 * field that was just asked about must always win, since otherwise a
 * message with no product/spec mention at all (like the examples
 * above) has nothing to anchor it and risks falling through to the
 * parser, whose whole-transcript re-parse can occasionally drop an
 * already-confirmed field (e.g. sku) from its returned `understood`,
 * which advance() then treats as a fresh "still missing" state — the
 * originally reported bug ("i can go upto 45000" re-asking for the
 * product).
 *
 * Deliberately still narrow, never a parallel parser: null whenever
 * (a) the text is too long to plausibly be just an answer, (b) it
 * contains a spec-shaped token (so a genuine spec-mismatch mention,
 * e.g. "12gb", is never misread as a quantity/budget/delivery number
 * — findUnmatchedSpec's own check in BuyerConversation.tsx already
 * runs before this and is never regressed by it), or (c) it contains
 * a keyword that belongs to a DIFFERENT field (so a message that's
 * actually about delivery/quantity doesn't get stolen as a budget
 * answer just because it happens to contain a number).
 */
export function matchCurrentFieldAnswer(field: BuyerIntentField, text: string): number | null {
  if (field === "product") return null;
  const trimmed = text.trim();
  if (trimmed.split(/\s+/).length > 14) return null;
  if (SPEC_TOKEN_PATTERN.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  if (CURRENT_FIELD_COMPETING_KEYWORD[field].test(lower)) return null;

  switch (field) {
    case "quantity": {
      const match = trimmed.match(/(\d{1,6})\s*(?:units?|pcs?|pieces?)?\b/i);
      if (!match) return null;
      const value = Number(match[1]);
      return value > 0 ? value : null;
    }
    case "maxPrice": {
      const match = trimmed.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/i);
      if (!match) return null;
      const raw = Number(match[1].replace(/,/g, ""));
      if (!Number.isFinite(raw) || raw <= 0) return null;
      return Math.round(match[2] ? raw * 1000 : raw);
    }
    case "deliveryDeadlineDays": {
      const match = trimmed.match(/(\d{1,4})\s*days?\b/i);
      if (!match) return null;
      const value = Number(match[1]);
      return value > 0 ? value : null;
    }
  }
}

/** Fields `matchFieldCorrection` can target — the same three numeric fields `matchShortAnswer` handles, "product" excluded since a correction never re-picks the product (that's the spec-mismatch path instead). */
export type CorrectableField = "quantity" | "maxPrice" | "deliveryDeadlineDays";

const CORRECTION_SIGNAL = /\b(actually|instead|change|make it|make that)\b/i;

/**
 * A natural-language correction to an ALREADY-confirmed numeric field —
 * e.g. "actually make that 7", "actually my budget is 46k, not 42k",
 * "actually 10 days is fine", "46k is my max", "I can wait 10 days",
 * "actually I only need 4", "change that to 45k" (Buyer Intake audit,
 * pass 10, Objective B). Deliberately separate from `matchShortAnswer`
 * above: that one only ever answers whichever field is CURRENTLY being
 * asked about; this one re-targets a field that was set on an EARLIER
 * turn, which is why it needs its own field-attribution logic rather
 * than just reusing the "currently asked" field.
 *
 * Field targeting, in priority order — each is checked independently of
 * whether a correction-signal word is present, since "I can wait 10
 * days" and "46k is my max" are themselves unambiguous without one:
 *  1. An explicit "N day(s)" mention -> delivery.
 *  2. A currency symbol, "k" suffix, or budget/max/price keyword -> budget.
 *  3. "need"/"unit(s)"/"pcs"/"pieces" alongside a bare number -> quantity.
 *  4. Otherwise, a bare number is only attributed to `fallbackField` (the
 *     field the caller reports as most recently confirmed) when an
 *     explicit correction-signal word is present — a bare number with no
 *     keyword and no correction language is too ambiguous to guess at.
 *
 * Guarded to only ever fire on a short reply (10 words or fewer) so a
 * long, multi-clause opening statement (e.g. the Golden Demo's own first
 * message, which happens to mention both a budget and a delivery figure)
 * is never intercepted here — it must still go through the real parser
 * to resolve every field together. Returns null for anything else, in
 * which case the caller falls through to the unchanged parser call.
 */
export function matchFieldCorrection(
  text: string,
  fallbackField: CorrectableField | null,
): { field: CorrectableField; value: number } | null {
  const trimmed = text.trim();
  if (trimmed.split(/\s+/).length > 10) return null;
  const lower = trimmed.toLowerCase();

  const dayMatch = trimmed.match(/(\d{1,4})\s*days?\b/i);
  if (dayMatch) {
    const value = Number(dayMatch[1]);
    if (value > 0) return { field: "deliveryDeadlineDays", value };
  }

  const hasBudgetKeyword = /₹|\brs\.?\b|\binr\b|\bbudget\b|\bmax(?:imum)?\b|\bprice\b/i.test(lower) || /\d\s*k\b/i.test(lower);
  if (hasBudgetKeyword) {
    const priceMatch = trimmed.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/i);
    if (priceMatch) {
      const raw = Number(priceMatch[1].replace(/,/g, ""));
      if (Number.isFinite(raw) && raw > 0) {
        return { field: "maxPrice", value: Math.round(priceMatch[2] ? raw * 1000 : raw) };
      }
    }
  }

  const hasQuantityKeyword = /\bneed\b|\bunits?\b|\bpcs\b|\bpieces?\b/i.test(lower);
  if (hasQuantityKeyword) {
    const qtyMatch = trimmed.match(/(\d{1,6})/);
    if (qtyMatch) {
      const value = Number(qtyMatch[1]);
      if (value > 0) return { field: "quantity", value };
    }
  }

  if (fallbackField && CORRECTION_SIGNAL.test(lower)) {
    const bareMatch = trimmed.match(/(\d[\d,]*)/);
    if (bareMatch) {
      const value = Number(bareMatch[1].replace(/,/g, ""));
      if (value > 0) return { field: fallbackField, value };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Discoverable editing of confirmed requirements (Buyer Intake audit, pass
// 3) — a small set of pure helpers, deliberately reusing everything above
// (nextMissingField, questionForMissingField) rather than introducing a
// second notion of "what's missing" or "what to ask." Editing a field is
// implemented as nothing more than clearing that one field from
// `understood` and asking the SAME question the normal collecting flow
// already asks for it — every downstream behavior (the real intent parser
// interpreting the buyer's new answer, advance()'s spec-mismatch/stock
// re-validation, Pass 2's question interception) is the existing,
// unmodified machinery, not reimplemented here.
// ---------------------------------------------------------------------------

const REQUIREMENT_FIELD_LABEL: Record<BuyerIntentField, string> = {
  product: "Product",
  quantity: "Quantity",
  maxPrice: "Budget",
  deliveryDeadlineDays: "Delivery",
};

/** The short label for a field in the requirements summary/edit UI — distinct from questionForMissingField's own longer question phrasing. */
export function requirementFieldLabel(field: BuyerIntentField): string {
  return REQUIREMENT_FIELD_LABEL[field];
}

/** The synthetic "user" transcript line appended when an Edit affordance is clicked — same convention this file already uses for every other quick-reply action (e.g. "Choose another product", "Search again"). */
export function editAnnouncement(field: BuyerIntentField): string {
  return `Edit ${REQUIREMENT_FIELD_LABEL[field].toLowerCase()}`;
}

/**
 * One row of the buyer-facing requirements summary — real values only,
 * formatted the same way the rest of this module already formats them
 * (formatInr, "≤ N days"). Never derived from anything but `understood`
 * itself.
 */
export interface RequirementRow {
  field: BuyerIntentField;
  label: string;
  value: string;
}

/**
 * The requirement rows to show/offer for editing — one per field that
 * currently has a REAL understood value, in the same fixed order the
 * rest of this module already asks about them (see nextMissingField). A
 * field with no value yet simply isn't in this list — there is nothing
 * to edit until it's been understood at least once.
 */
export function buildRequirementRows(understood: Partial<BuyerIntent>): RequirementRow[] {
  const rows: RequirementRow[] = [];
  if (understood.productName) {
    rows.push({ field: "product", label: requirementFieldLabel("product"), value: understood.productName });
  }
  if (understood.quantity !== undefined) {
    rows.push({ field: "quantity", label: requirementFieldLabel("quantity"), value: `${understood.quantity} units` });
  }
  if (understood.maxPrice !== undefined) {
    rows.push({
      field: "maxPrice",
      label: requirementFieldLabel("maxPrice"),
      // Pass 4: an honest, presentation-only note that this number is a
      // soft preference rather than a hard ceiling — never changes what
      // gets sent to the parser/API, only how the confirmed value reads.
      value: understood.budgetFlexible
        ? `${formatInr(understood.maxPrice)}/unit · flexible`
        : `${formatInr(understood.maxPrice)}/unit`,
    });
  }
  if (understood.deliveryDeadlineDays !== undefined) {
    rows.push({
      field: "deliveryDeadlineDays",
      label: requirementFieldLabel("deliveryDeadlineDays"),
      value: `≤ ${understood.deliveryDeadlineDays} days`,
    });
  }
  return rows;
}

/**
 * Clears exactly one field from `understood`, leaving every other field
 * byte-identical — the entire logic behind the Edit affordance. "product"
 * clears both `sku` and `productName` together (they are always set/
 * cleared as a pair everywhere else in this module too); every other
 * field clears only itself. After this, nextMissingField(cleared) is
 * guaranteed to identify `field` as needing an answer again (or an
 * earlier field, only if `field` itself wasn't actually filled — never a
 * LATER field, since every field before it in the fixed order is
 * untouched), so the existing collecting → parse → advance() cascade
 * resumes exactly as if that one field had never been provided.
 */
export function clearField(understood: Partial<BuyerIntent>, field: BuyerIntentField): Partial<BuyerIntent> {
  const cleared = { ...understood };
  switch (field) {
    case "product":
      delete cleared.sku;
      delete cleared.productName;
      return cleared;
    case "quantity":
      delete cleared.quantity;
      return cleared;
    case "maxPrice":
      delete cleared.maxPrice;
      return cleared;
    case "deliveryDeadlineDays":
      delete cleared.deliveryDeadlineDays;
      return cleared;
  }
}

/**
 * Deterministic, explainable relevance ranking for catalog suggestions —
 * NOT a semantic/LLM match, and never described to the user as
 * "closest". Simple case-insensitive word-overlap between the buyer's
 * raw text and each product's name+description; ties broken by catalog
 * order. Used only to ORDER the suggestion list; every product shown is
 * always a genuinely real, public catalog entry.
 */
export function rankCatalogMatches(queryText: string, catalog: PublicManifestProduct[]): PublicManifestProduct[] {
  const queryWords = new Set(
    queryText
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w.length > 2),
  );
  if (queryWords.size === 0) return catalog;

  const scored = catalog.map((product, index) => {
    const productWords = `${product.name} ${product.description}`.toLowerCase().split(/[^a-z0-9]+/i);
    const score = productWords.filter((w) => queryWords.has(w)).length;
    return { product, score, index };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.product);
}

/** A cheap, deterministic English singular/plural fold — "monitors" and "monitor" should count as the same word for catalog-overlap purposes. Not real stemming, just enough to stop a plural buyer phrasing from looking unmatched against a singular catalog name. */
function foldPlural(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

const PRODUCT_INTENT_PATTERN =
  /\b(?:need|want|looking for|interested in|buy|purchase|require|get)\b\s+(?:a|an|some|\d+\s*)?\s*([a-z][a-z\s-]{1,40})/i;

/**
 * The plausible product/category name a buyer named, when it doesn't
 * overlap with anything in the real catalog at all — e.g. "I need a
 * car" against a catalog of laptops/monitors/keyboards returns "car".
 * Deterministic and LLM-independent by design (Buyer Intake audit, pass
 * 11, Objective A): the LLM parser's own "unknown_product" status only
 * fires when it names an invalid sku, but the model correctly follows
 * its own instructions and returns sku: null for a genuinely absent
 * category too — indistinguishable, from the caller's side, from "no
 * product mentioned at all" unless the raw text itself is inspected
 * here. Returns null whenever no plausible product-request phrase is
 * found, OR the phrase shares a word with some real catalog product
 * (name+description, singular/plural folded) — in which case whatever
 * WAS said is left to the real parser/existing catalog-match flow,
 * never overridden here.
 */
export function extractUnavailableProductMention(text: string, catalog: PublicManifestProduct[]): string | null {
  const match = text.match(PRODUCT_INTENT_PATTERN);
  if (!match) return null;

  const phrase = match[1].trim().replace(/[.,!?;:]+$/, "");
  const words = phrase
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 4);
  if (words.length === 0) return null;

  const catalogWords = new Set(
    catalog.flatMap((p) => `${p.name} ${p.description}`.toLowerCase().split(/[^a-z0-9]+/i).map(foldPlural)),
  );
  const overlaps = words.some((w) => catalogWords.has(foldPlural(w)));
  if (overlaps) return null;

  return words.join(" ");
}

/** Quick-reply delivery windows shown alongside the free-text input for the delivery question — matches the negotiate form's own existing granularity, nothing invented. */
export const DELIVERY_QUICK_REPLIES = [3, 5, 7] as const;

// ---------------------------------------------------------------------------
// Question handling (Buyer Intake audit, pass 2) — a small, fully
// deterministic classifier and answer-builder so a buyer asking a
// question ("What's the price of the monitor?") gets answered from the
// real, already-loaded catalog instead of being treated as another
// extraction attempt. Nothing here calls the LLM, the intent API, or
// touches `understood` — a question is intercepted in
// BuyerConversation.tsx BEFORE it would ever reach the parser, so a
// number or word inside a question can never be misread as a stated
// requirement (see isQuestion's own doc comment for why detection is
// deliberately conservative). Every answer is built only from real
// PublicManifestProduct fields — that type structurally has no minPrice
// field at all (see types/manifest.ts), so there is nothing private
// available to leak here even by mistake.
// ---------------------------------------------------------------------------

export type QuestionCategory = "price" | "stock" | "delivery" | "catalog";

const QUESTION_OPENERS = [
  "what's",
  "whats",
  "what is",
  "what are",
  "what do",
  "what does",
  "how many",
  "how much",
  "how long",
  "how fast",
  "when can",
  "when will",
  "when do",
  "do you have",
  "does it",
  "is there",
  "are there",
  "can i",
  "could i",
] as const;

/**
 * Deliberately conservative: a message is treated as a question only
 * when it ends with "?" (the strong, unambiguous signal) or opens with
 * one of a small set of common question phrases. A single question WORD
 * appearing anywhere ("Where I work we need 5 monitors") is NOT enough —
 * that's exactly the false-positive this stays away from, since
 * mis-detecting a real requirement statement as a question would mean
 * it's never sent to the parser at all.
 */
export function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith("?")) return true;
  const lower = trimmed.toLowerCase();
  return QUESTION_OPENERS.some((opener) => lower.startsWith(opener));
}

/**
 * Which real catalog fact the question is asking about — or null when it
 * can't be confidently categorized. Deliberately ordered so "what
 * products are available" (asking about the whole catalog) doesn't get
 * mis-caught by the plain "available" check meant for a single product's
 * stock.
 */
export function classifyQuestion(text: string): QuestionCategory | null {
  const lower = text.toLowerCase();
  if (/\bproducts?\b/.test(lower) && /\b(available|offer|sell|have|catalog|options)\b/.test(lower)) {
    return "catalog";
  }
  // "What do you sell/carry/offer?" — the whole-catalog question asked
  // without the word "product" at all (Buyer Intake audit, pass 11).
  if (/\bwhat\b[\s\S]*\b(sell|carry)\b/.test(lower)) {
    return "catalog";
  }
  if (/\b(delivery|shipping|ship|deliver)\b/.test(lower)) return "delivery";
  if (/\b(stock|available|availability)\b/.test(lower)) return "stock";
  if (/\b(price|cost|expensive|cheap)\b/.test(lower) || /how much/.test(lower)) return "price";
  return null;
}

/**
 * A product is "mentioned" only when a real, distinctive word from its
 * own real name appears in the question text — never a fuzzy/best-effort
 * guess, and never the reason a product gets silently selected as a
 * requirement (this is used only to pick which product's real facts to
 * answer with; it never touches `understood`).
 */
export function findMentionedProduct(text: string, products: PublicManifestProduct[]): PublicManifestProduct | null {
  const lower = text.toLowerCase();
  for (const product of products) {
    const words = product.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    if (words.some((w) => lower.includes(w))) return product;
  }
  return null;
}

/**
 * The real factual answer for one question category — for a specific
 * product when one was resolved (by name-mention in the question, or the
 * product already selected in the conversation), otherwise a real
 * summary across the whole catalog. Every number and name here comes
 * directly from a real PublicManifestProduct field.
 */
export function answerQuestion(
  category: QuestionCategory,
  product: PublicManifestProduct | null,
  products: PublicManifestProduct[],
): string {
  switch (category) {
    case "price":
      return product
        ? `${product.name} is listed at ${formatInr(product.listedPrice)} per unit.`
        : `Listed prices: ${products.map((p) => `${p.name} at ${formatInr(p.listedPrice)}/unit`).join(", ")}.`;
    case "stock":
      return product
        ? `We have ${product.availableQuantity} unit(s) of ${product.name} available.`
        : `Current stock: ${products.map((p) => `${p.name} — ${p.availableQuantity} unit(s)`).join(", ")}.`;
    case "delivery":
      return product
        ? `${product.name} ships in ${product.standardDeliveryDays}–${product.maxDeliveryDays} day(s), depending on your requirements.`
        : `Delivery windows: ${products.map((p) => `${p.name} in ${p.standardDeliveryDays}–${p.maxDeliveryDays} day(s)`).join(", ")}.`;
    case "catalog":
      return products.length > 0
        ? `Here's what's available: ${products.map((p) => `${p.name} (${formatInr(p.listedPrice)})`).join(", ")}.`
        : "There's nothing in the catalog right now.";
  }
}

/**
 * What the conversation should show next, derived from `understood`
 * alone — the exact same missing-field / stock / ready cascade
 * BuyerConversation.tsx's own `advance()` tail uses (minus setUnderstood
 * itself and the spec-mismatch check, neither of which applies here: a
 * question never changes `understood`, so there is nothing new to
 * detect a mismatch on). Used only to resume the conversation after a
 * question has just been answered — never a second source of truth for
 * what's missing, just this same real state read again. Decoupled from
 * BuyerConversation.tsx's own local `Phase` union so this stays a plain,
 * directly testable function; the component maps `kind` onto its own
 * Phase.
 */
export type ResumedState =
  | { kind: "collecting"; followUp: string }
  | { kind: "quantity_check"; product: PublicManifestProduct; requested: number; followUp: string }
  | { kind: "ready"; followUp: string };

export function deriveResumedState(understood: Partial<BuyerIntent>, products: PublicManifestProduct[]): ResumedState {
  const missing = nextMissingField(understood);
  if (missing) {
    return { kind: "collecting", followUp: questionForMissingField(missing, understood) };
  }
  const product = products.find((p) => p.sku === understood.sku) ?? null;
  if (product && understood.quantity !== undefined && understood.quantity > product.availableQuantity) {
    return {
      kind: "quantity_check",
      product,
      requested: understood.quantity,
      followUp: `I only have ${product.availableQuantity} unit(s) of ${product.name} listed as available.`,
    };
  }
  return { kind: "ready", followUp: "Ready to negotiate." };
}

/**
 * The lead-in for a question that couldn't be confidently categorized —
 * never a guess at an answer (see this module's own "Do not hallucinate"
 * discipline). The caller appends the real next question/state
 * afterward, exactly as questionForMissingField already provides it —
 * this only supplies the acknowledging clause, phrased differently
 * depending on whether a requirement is genuinely still missing.
 */
export function ambiguousQuestionLeadIn(stillCollecting: boolean): string {
  return stillCollecting ? "I can help with that, but I still need a bit more first." : "I can help with that.";
}

/**
 * A best-effort, deterministic check for a numeric+unit spec (RAM,
 * storage, screen size, etc — "12GB", "15 inch") the buyer's own words
 * named that the resolved product's own real name doesn't contain — e.g.
 * asking for a "12GB RAM laptop" when the catalog's only laptop is
 * listed as 16GB. Never a semantic/LLM judgment or an inferred
 * "closest match": a plain regex extraction of the buyer's own text,
 * compared as a literal substring against the product's own real name.
 * Returns null whenever the buyer's text names no such spec at all, or
 * every spec named IS present in the product name (nothing to flag) —
 * this function only ever surfaces a mismatch it can point to in the
 * buyer's own words and the product's own real name, never invents one.
 *
 * Pass 9: the bare "in" unit (as a short form of "inch") was dropped
 * from this list — real observed false positive: "5 in qty" (meaning
 * "5, in quantity") matched as if "5 in" were a screen-size spec,
 * producing a spurious spec-mismatch prompt on an ordinary quantity
 * answer. "in" alone is far more often the common English preposition
 * than an inches abbreviation in natural buyer text; a genuine
 * screen-size mention overwhelmingly says "inch" in full ("15 inch",
 * "15-inch"), which this still catches.
 */
export function findUnmatchedSpec(rawText: string, product: PublicManifestProduct): string | null {
  const tokens = rawText.match(/\d+\s?(?:gb|tb|mb|inch|mp|mah)\b/gi) ?? [];
  const normalizedProductName = product.name.toLowerCase().replace(/\s+/g, "");
  for (const token of tokens) {
    const normalized = token.toLowerCase().replace(/\s+/g, "");
    if (!normalizedProductName.includes(normalized)) {
      return token.trim();
    }
  }
  return null;
}

/**
 * Whether a DIFFERENT real catalog product actually has the spec the
 * buyer just mentioned (e.g. the catalog genuinely carries a 12GB
 * variant alongside the 16GB one already selected) — checked before ever
 * telling the buyer that spec is unavailable, so a real match is used
 * instead of a fabricated "not available" claim. Reuses the same
 * normalization findUnmatchedSpec itself uses; returns null when nothing
 * else in the catalog matches, in which case the mismatch is genuine.
 */
export function findMatchingProductForSpec(
  unmatchedSpec: string,
  currentSku: string,
  products: PublicManifestProduct[],
): PublicManifestProduct | null {
  const normalizedSpec = unmatchedSpec.toLowerCase().replace(/\s+/g, "");
  return (
    products.find((p) => p.sku !== currentSku && p.name.toLowerCase().replace(/\s+/g, "").includes(normalizedSpec)) ??
    null
  );
}
