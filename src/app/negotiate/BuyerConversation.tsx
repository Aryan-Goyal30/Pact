"use client";

// Buyer Agent Conversational Intake — the primary /negotiate entry
// point. A thin conversational wrapper over the EXISTING single-shot
// buyer-intent parser (buyerIntentParser.ts, reached via the existing,
// unmodified POST /api/negotiations/intent): each new user message is
// appended to a running transcript of the buyer's own words, and the
// WHOLE accumulated transcript is re-sent to that one endpoint every
// turn — the parser already reports back exactly what it could and
// couldn't confidently determine, so no new backend capability is
// needed to make it feel incremental. This component owns its own
// conversation state; the only things it hands back to NegotiationDemo
// are (a) a fully-resolved BuyerIntent, once ready — the parent syncs
// its own form state from it (so the workspace shows the real
// negotiated product/terms) and calls the EXISTING, unmodified
// runNegotiation — or (b) a "fall back to the structured form" signal
// carrying whatever was understood so far.
//
// No negotiation decision, price, or catalog fact is ever computed or
// invented here — every number shown comes directly from a real
// PublicManifestProduct or a real BuyerIntentParseResult.

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PublicManifestProduct } from "@/types/manifest";
import type { BuyerIntent, BuyerIntentField, BuyerIntentParseResult } from "@/lib/negotiation/buyerIntentParser";
import { useTypewriterReveal, usePrefersReducedMotion } from "./negotiateClientHooks";
import {
  DELIVERY_QUICK_REPLIES,
  ambiguousQuestionLeadIn,
  answerQuestion,
  buildRequirementRows,
  classifyQuestion,
  clearField,
  deriveResumedState,
  describeUnderstood,
  editAnnouncement,
  extractUnavailableProductMention,
  findMatchingProductForSpec,
  findMentionedProduct,
  findUnmatchedSpec,
  formatInr,
  isQuestion,
  matchCurrentFieldAnswer,
  matchFieldCorrection,
  matchShortAnswer,
  nextMissingField,
  type CorrectableField,
  questionForMissingField,
  rankCatalogMatches,
  withDefaults,
} from "./buyerConversationUi";

const EXAMPLE_PROMPTS = [
  "20 monitors under ₹9,000 each",
  "5 business laptops, delivery within 7 days",
  "100 keyboards for an office rollout",
] as const;

interface UserEntry {
  id: number;
  kind: "user";
  text: string;
}
interface AgentEntry {
  id: number;
  kind: "agent";
  text: string;
}
type ConversationEntry = UserEntry | AgentEntry;

type Phase =
  | { kind: "collecting" }
  | { kind: "catalog_mismatch"; suggestions: PublicManifestProduct[] }
  | { kind: "spec_mismatch"; product: PublicManifestProduct; unmatchedSpec: string }
  | { kind: "quantity_check"; product: PublicManifestProduct; requested: number }
  | { kind: "ready" };

interface BuyerConversationProps {
  products: PublicManifestProduct[];
  /** Mirrors the existing disabled-while-starting pattern the old IntentEntry/IntentConfirmation already used. */
  running: boolean;
  /** The fully-resolved intent, once ready — NegotiationDemo.tsx syncs its own form state from this (so the workspace's context panels show the real negotiated product/terms, not stale defaults) and then calls the EXISTING, unmodified runNegotiation. */
  onReady: (intent: BuyerIntent) => void;
  /** Hands back whatever was understood so far when this component can't (or the user chooses not to) continue conversationally — same contract the old single-shot flow already had. */
  onFallback: (understood: Partial<BuyerIntent>, notice: string | null) => void;
  onSwitchToForm: () => void;
}

export function BuyerConversation({ products, running, onReady, onFallback, onSwitchToForm }: BuyerConversationProps) {
  const reducedMotion = usePrefersReducedMotion();
  const idRef = useRef(0);
  function nextId() {
    idRef.current += 1;
    return idRef.current;
  }

  const [history, setHistory] = useState<ConversationEntry[]>([]);
  const [understood, setUnderstood] = useState<Partial<BuyerIntent>>({});
  const [userUtterances, setUserUtterances] = useState<string[]>([]);
  // Mirrors `userUtterances` synchronously — `advance()` below (and the
  // spec-mismatch check inside it) needs the utterance that was JUST
  // submitted, but `advance()` can run in the same tick as the
  // `setUserUtterances` call that adds it, before that state update is
  // visible to this render's closures. Same category of fix as
  // `advance`'s own `understood`-vs-`next` comment just below: read the
  // ref for "what's true right now", never the possibly-stale state.
  const userUtterancesRef = useRef<string[]>([]);
  // The most recently CONFIRMED numeric field — updated inside advance()
  // whenever one of the three changes value. Lets a later free-text
  // correction with no field keyword of its own (e.g. "actually make
  // that 7" right after quantity was set) still resolve to the right
  // field, without a second parallel state machine: it's just "what did
  // the last successful advance() call actually change".
  const lastConfirmedFieldRef = useRef<CorrectableField | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "collecting" });
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);

  function appendAgent(text: string) {
    setHistory((prev) => [...prev, { id: nextId(), kind: "agent", text }]);
  }
  function appendUser(text: string) {
    setHistory((prev) => [...prev, { id: nextId(), kind: "user", text }]);
  }

  /** After ANY update to `understood` (from a parse OR a direct quick-reply set), decide what happens next — ask about the next missing field, flag a stock issue, or declare readiness. Takes the new state as a parameter rather than reading closure state, since callers just called setUnderstood(next) and that update isn't visible yet. */
  function advance(next: Partial<BuyerIntent>) {
    (["quantity", "maxPrice", "deliveryDeadlineDays"] as const).forEach((field) => {
      if (next[field] !== undefined && next[field] !== understood[field]) {
        lastConfirmedFieldRef.current = field;
      }
    });
    setUnderstood(next);

    // A product just became known this call (it wasn't the one already
    // understood before) — before asking about anything else still
    // missing, check whether the buyer's own words named a spec
    // (RAM/storage/size) this real product's name doesn't actually
    // have. Deliberately checked BEFORE the "still missing fields"
    // branch below: the mismatch is worth surfacing the moment the
    // product resolves, not after several more questions about
    // quantity/budget/delivery. `understood` here is still the
    // PRE-update closure value (setUnderstood(next) above hasn't
    // re-rendered yet), so this only fires once per newly-resolved
    // product — re-entering advance() after the user explicitly
    // confirms it (same sku, unchanged) skips this branch naturally, no
    // separate "acknowledged" flag needed.
    if (next.sku && understood.sku !== next.sku) {
      const product = products.find((p) => p.sku === next.sku) ?? null;
      if (product) {
        const unmatchedSpec = findUnmatchedSpec(userUtterancesRef.current.join(". "), product);
        if (unmatchedSpec) {
          appendAgent(
            `I couldn't find a ${unmatchedSpec} configuration in the catalog. The available option is ${product.name}.`,
          );
          setPhase({ kind: "spec_mismatch", product, unmatchedSpec });
          return;
        }
      }
    }

    const missing = nextMissingField(next);
    if (missing) {
      appendAgent(missing === "product" ? questionForMissingField(missing, next) : composeGotIt(next, missing));
      setPhase({ kind: "collecting" });
      return;
    }

    const product = products.find((p) => p.sku === next.sku) ?? null;

    if (product && next.quantity !== undefined && next.quantity > product.availableQuantity) {
      appendAgent(
        `I only have ${product.availableQuantity} unit(s) of ${product.name} listed as available.`,
      );
      setPhase({ kind: "quantity_check", product, requested: next.quantity });
      return;
    }

    appendAgent("Ready to negotiate.");
    setPhase({ kind: "ready" });
  }

  function composeGotIt(u: Partial<BuyerIntent>, missing: BuyerIntentField): string {
    const summary = describeUnderstood(u);
    const question = questionForMissingField(missing, u);
    return summary ? `Got it — ${summary}. ${question}` : question;
  }

  /**
   * The buyer named a real, recognizable product/category this
   * merchant's catalog doesn't carry at all (Buyer Intake audit, pass
   * 11, Objective A) — e.g. "I need a car" against a laptop/monitor/
   * keyboard catalog. Explicitly acknowledges what was asked for, says
   * plainly that it isn't available FROM THIS MERCHANT, and presents the
   * real catalog via the same catalog_mismatch phase/cards the existing
   * unrecognized-sku path already uses — never a generic "What product
   * are you looking for?" (which reads as having ignored the buyer) and
   * never an invented "closest" product. `merged` carries forward
   * whatever OTHER fields (quantity, budget, delivery) were already
   * confirmed or just extracted alongside the unavailable mention — this
   * never clears or overwrites them.
   */
  function presentUnavailableProduct(mention: string, merged: Partial<BuyerIntent>) {
    setUnderstood(merged);
    const ranked = rankCatalogMatches(mention, products).slice(0, 3);
    const options = ranked.length > 0 ? ranked : products.slice(0, 3);
    // No article for a plausibly-plural mention ("cars") — "a cars"
    // would read as broken English; "cars" alone reads naturally either way.
    const article = /s$/i.test(mention) ? "" : /^[aeiou]/i.test(mention) ? "an " : "a ";
    appendAgent(
      options.length > 0
        ? `I couldn't find ${article}${mention} in this merchant's catalog. They currently offer these products — which one would you like to negotiate for?`
        : `I couldn't find ${article}${mention} in this merchant's catalog, and there's nothing else available right now.`,
    );
    setPhase({ kind: "catalog_mismatch", suggestions: options });
  }

  /** Maps buyerConversationUi.ts's decoupled ResumedState onto this component's own local Phase union — the actual cascade logic lives there (deriveResumedState), directly testable without a DOM. */
  function resumeFromUnderstood(): { phase: Phase; followUp: string } {
    const resumed = deriveResumedState(understood, products);
    const phase: Phase =
      resumed.kind === "quantity_check"
        ? { kind: "quantity_check", product: resumed.product, requested: resumed.requested }
        : { kind: resumed.kind };
    return { phase, followUp: resumed.followUp };
  }

  async function submitUtterance(rawText: string) {
    const text = rawText.trim();
    if (text.length === 0) return;

    appendUser(text);
    setInputValue("");

    // Question handling (Buyer Intake audit, pass 2) — deliberately
    // checked BEFORE this message ever becomes part of the utterance
    // transcript the parser sees, and returns before touching
    // userUtterances/understood at all. This is what guarantees a
    // question's own embedded word/number can never be misread as a
    // stated requirement — see buyerConversationUi.ts's own header
    // comment on this. Fully deterministic: no LLM call, no intent API
    // call, every fact in the answer comes from the real, already-loaded
    // `products` (or the real product already selected in `understood`).
    if (isQuestion(text)) {
      const { phase: resumedPhase, followUp } = resumeFromUnderstood();
      const category = classifyQuestion(text);
      const selectedProduct = understood.sku ? (products.find((p) => p.sku === understood.sku) ?? null) : null;
      const answer = category
        ? answerQuestion(category, findMentionedProduct(text, products) ?? selectedProduct, products)
        : ambiguousQuestionLeadIn(resumedPhase.kind === "collecting");
      appendAgent(`${answer} ${followUp}`);
      setPhase(resumedPhase);
      return;
    }

    // Specification corrections on an ALREADY-established product (Buyer
    // Intake audit, pass 10, Objective A) — e.g. product resolved to the
    // 16GB laptop on an earlier turn, and this turn says "I need 12gb ram
    // in the laptop not 16". advance()'s own spec-mismatch check just
    // above only ever fires the FIRST time a product resolves (comparing
    // against the pre-update `understood.sku`), so a mismatch mentioned
    // on a LATER turn — while the same product stays selected — would
    // otherwise fall straight through to nextMissingField and get
    // misread as an answer to whatever's still missing (originally
    // reported as: "12" getting misread as the quantity answer). Checked
    // here, against ONLY this message's own text (never the accumulated
    // transcript, which could false-positive on an old, already-resolved
    // mention), before either the correction-matcher or the parser ever
    // sees it, so "12" can never be interpreted as quantity.
    if (understood.sku) {
      const selectedProduct = products.find((p) => p.sku === understood.sku) ?? null;
      if (selectedProduct) {
        const unmatchedSpec = findUnmatchedSpec(text, selectedProduct);
        if (unmatchedSpec) {
          const nextUtterances = [...userUtterances, text];
          setUserUtterances(nextUtterances);
          userUtterancesRef.current = nextUtterances;
          const realMatch = findMatchingProductForSpec(unmatchedSpec, selectedProduct.sku, products);
          if (realMatch) {
            advance({ ...understood, sku: realMatch.sku, productName: realMatch.name });
          } else {
            appendAgent(
              `I couldn't find a ${unmatchedSpec} configuration in the catalog. The available option is ${selectedProduct.name}.`,
            );
            setPhase({ kind: "spec_mismatch", product: selectedProduct, unmatchedSpec });
          }
          return;
        }
      }
    }

    // Natural-language answer to whichever field is CURRENTLY being
    // asked (Buyer Intake audit, pass 11.1) — e.g. product + quantity
    // already confirmed, budget is what's being asked, and the buyer
    // replies "i can go upto 45000". Deliberately checked here — after
    // the spec-mismatch check above (never regressed: a genuine "12gb"
    // mismatch mention is excluded by matchCurrentFieldAnswer's own
    // spec-token guard anyway, but the spec-mismatch check staying
    // first keeps that precedence explicit) and BEFORE the correction-
    // matcher/unavailable-product paths below, since a valid answer to
    // the field that was just asked about must always win over either.
    // This is what actually fixes the reported bug: without this catching
    // "i can go upto 45000" deterministically, that message fell through
    // to the parser, whose whole-transcript re-parse could return
    // `understood` without `sku`, which advance() then treated as the
    // product having become unresolved again.
    const currentlyAskingField = nextMissingField(understood);
    if (currentlyAskingField && currentlyAskingField !== "product") {
      const fieldAnswer = matchCurrentFieldAnswer(currentlyAskingField, text);
      if (fieldAnswer !== null) {
        const nextUtterances = [...userUtterances, text];
        setUserUtterances(nextUtterances);
        userUtterancesRef.current = nextUtterances;
        advance({ ...understood, [currentlyAskingField]: fieldAnswer });
        return;
      }
    }

    // Natural corrections to an already-confirmed field (Buyer Intake
    // audit, pass 10, Objective B) — e.g. quantity was set to 5 on an
    // earlier turn, budget is what's currently being asked, and this
    // turn says "actually make that 7" (meaning quantity, not budget).
    // matchFieldCorrection is deliberately checked ahead of the Pass 9
    // short-answer check below: an explicit correction should never be
    // reinterpreted as a first-time answer to whatever's currently being
    // asked just because the number would also fit that pattern.
    if (understood.sku) {
      const correction = matchFieldCorrection(text, lastConfirmedFieldRef.current);
      if (correction) {
        const nextUtterances = [...userUtterances, text];
        setUserUtterances(nextUtterances);
        userUtterancesRef.current = nextUtterances;
        advance({ ...understood, [correction.field]: correction.value });
        return;
      }
    }

    // Contextual short answers (Buyer Intake audit, pass 9) — a short,
    // unambiguous reply to whichever field is CURRENTLY being asked
    // about (e.g. a bare "5" right after "How many do you need?") is
    // resolved deterministically, without a round trip to the LLM
    // parser at all — see matchShortAnswer's own doc comment for why
    // this is safe and why it never competes with the real parser: any
    // input that isn't cleanly one of these narrow patterns (a full
    // sentence, a correction, several fields stated together) falls
    // straight through to the unchanged parser call below.
    const currentlyAsking = nextMissingField(understood);
    if (currentlyAsking && currentlyAsking !== "product") {
      const shortValue = matchShortAnswer(currentlyAsking, text);
      if (shortValue !== null) {
        const nextUtterances = [...userUtterances, text];
        setUserUtterances(nextUtterances);
        userUtterancesRef.current = nextUtterances;
        advance({ ...understood, [currentlyAsking]: shortValue });
        return;
      }
    }

    const nextUtterances = [...userUtterances, text];
    setUserUtterances(nextUtterances);
    userUtterancesRef.current = nextUtterances;

    setLoading(true);
    try {
      const response = await fetch("/api/negotiations/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: nextUtterances.join(". ") }),
      });
      const result = (await response.json()) as BuyerIntentParseResult & { error?: string };

      if (!response.ok) {
        onFallback(understood, result.error ?? "Could not process that request.");
        return;
      }

      if (result.status === "ok") {
        advance(result.intent);
      } else if (result.status === "missing_fields") {
        // The parser correctly follows its own "never invent a sku"
        // instruction and reports sku as unresolved both when the buyer
        // named nothing recognizable AND when they named a real category
        // this catalog just doesn't carry — indistinguishable from the
        // parser's own status alone. Deterministic, LLM-independent raw-
        // text inspection disambiguates the second case before ever
        // falling back to the generic "what product" question.
        const mention = result.understood.sku ? null : extractUnavailableProductMention(text, products);
        if (mention) {
          presentUnavailableProduct(mention, { ...understood, ...result.understood });
        } else {
          advance(result.understood);
        }
      } else if (result.status === "unknown_product") {
        const merged = { ...understood, ...result.understood };
        const mention = extractUnavailableProductMention(text, products);
        if (mention) {
          presentUnavailableProduct(mention, merged);
        } else {
          setUnderstood(merged);
          const ranked = rankCatalogMatches(text, products).slice(0, 3);
          appendAgent(
            ranked.length > 0
              ? "I don't have that listed in the catalog. Here's what's available:"
              : "I don't have that listed in the catalog, and there's nothing else available right now.",
          );
          setPhase({ kind: "catalog_mismatch", suggestions: ranked });
        }
      } else {
        onFallback(understood, result.message);
      }
    } catch {
      // Deterministic catalog-mismatch detection doesn't depend on the
      // parser having responded at all — a total network/API failure
      // still gets the real "not available from this merchant" response
      // for a recognizable-but-absent category, rather than only the
      // generic fallback notice.
      const mention = understood.sku ? null : extractUnavailableProductMention(text, products);
      if (mention) {
        presentUnavailableProduct(mention, understood);
      } else {
        onFallback(understood, "Could not reach the request parser — please fill in the details below.");
      }
    } finally {
      setLoading(false);
    }
  }

  function handleSelectProduct(product: PublicManifestProduct) {
    appendUser(product.name);
    advance({ ...understood, sku: product.sku, productName: product.name });
  }

  function handleSelectDelivery(days: number) {
    appendUser(`Within ${days} day(s)`);
    advance({ ...understood, deliveryDeadlineDays: days });
  }

  function handleSearchAgain() {
    appendUser("Search again");
    appendAgent("What would you like instead?");
    setPhase({ kind: "collecting" });
  }

  function handleContinueWithStock(product: PublicManifestProduct) {
    appendUser(`Continue with ${product.availableQuantity}`);
    advance({ ...understood, quantity: product.availableQuantity });
  }

  /** The buyer accepts the real available product despite the spec mismatch (e.g. 16GB instead of the requested 12GB) — re-enters advance() with the SAME sku already understood, so the mismatch check above is naturally skipped this time and the flow continues normally (quantity check, then ready). */
  function handleAcceptSpecMismatch(product: PublicManifestProduct) {
    appendUser(`Continue with ${product.name}`);
    advance({ ...understood, sku: product.sku, productName: product.name });
  }

  /** The buyer wants to see other real catalog options instead — same ranked-suggestion presentation the unknown-product path already uses, never a fabricated "closest match" claim. */
  function handleShowOtherOptions() {
    appendUser("Show other options");
    const ranked = rankCatalogMatches(userUtterances.join(". "), products).slice(0, 3);
    appendAgent(
      ranked.length > 0
        ? "Here are the available options:"
        : "There's nothing else available right now.",
    );
    setPhase({ kind: "catalog_mismatch", suggestions: ranked });
  }

  /**
   * Discoverable editing (Buyer Intake audit, pass 3) — clears exactly
   * one already-confirmed field (clearField, pure/tested) and asks the
   * SAME question the normal collecting flow already asks for it
   * (questionForMissingField, unchanged). Deliberately does nothing else:
   * `phase` resets to "collecting" (leaving "ready" if that's where the
   * conversation was — see this component's own header comment on why
   * that's the whole mechanism, no separate "ready" check needed), and
   * every subsequent step — the buyer's typed correction going through
   * the real intent parser, advance()'s spec-mismatch/stock re-
   * validation once a new value resolves, Pass 2's question interception
   * remaining accurate because it only ever reads `understood` — is the
   * existing, completely unmodified machinery. No second state machine.
   */
  function handleEditField(field: BuyerIntentField) {
    const cleared = clearField(understood, field);
    appendUser(editAnnouncement(field));
    appendAgent(questionForMissingField(field, cleared));
    setUnderstood(cleared);
    setPhase({ kind: "collecting" });
  }

  function handleChooseAnotherProduct() {
    appendUser("Choose another product");
    // Drops the product (its stock couldn't support the requested
    // quantity) but keeps everything else already understood —
    // advance() re-derives "product" as the next missing field and asks
    // for it the normal way; if the next product picked also can't
    // support the same quantity, the exact same stock check in advance()
    // fires again naturally, no special-casing needed here.
    advance({ ...understood, sku: undefined, productName: undefined });
  }

  function handleStartOver() {
    setHistory([]);
    setUnderstood({});
    setUserUtterances([]);
    userUtterancesRef.current = [];
    setPhase({ kind: "collecting" });
    setInputValue("");
  }

  function handleStart() {
    const complete = withDefaults(understood);
    if (!complete) return;
    onReady(complete);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !loading && !running) {
      e.preventDefault();
      void submitUtterance(inputValue);
    }
  }

  const showInput = phase.kind !== "ready";
  const disabled = loading || running;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-display-2 font-semibold text-foreground">What are you looking to buy?</h1>
        <p className="text-sm leading-6 text-muted">
          Tell me what you need — product, quantity, budget, delivery, or any combination.
        </p>
      </div>

      <RequirementsSummary understood={understood} onEdit={handleEditField} disabled={disabled} />

      {history.length > 0 && (
        <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 sm:p-5">
          {history.map((entry, i) => {
            const isLast = i === history.length - 1;
            if (entry.kind === "user") {
              return <UserMessage key={entry.id} text={entry.text} />;
            }
            return (
              <AgentMessage key={entry.id} text={entry.text} reducedMotion={reducedMotion}>
                {isLast ? (
                  <LivePhaseContent
                    phase={phase}
                    understood={understood}
                    products={products}
                    disabled={disabled}
                    onSelectProduct={handleSelectProduct}
                    onSelectDelivery={handleSelectDelivery}
                    onSearchAgain={handleSearchAgain}
                    onContinueWithStock={handleContinueWithStock}
                    onChooseAnotherProduct={handleChooseAnotherProduct}
                    onAcceptSpecMismatch={handleAcceptSpecMismatch}
                    onShowOtherOptions={handleShowOtherOptions}
                    onStart={handleStart}
                    running={running}
                  />
                ) : null}
              </AgentMessage>
            );
          })}
        </div>
      )}

      {showInput && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface p-2 pl-4 transition-colors focus-within:border-border-strong">
            <input
              type="text"
              value={inputValue}
              disabled={disabled}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={history.length === 0 ? "I need 20 monitors under ₹9,000 each" : "Type your answer…"}
              className="h-9 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted/70 focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              disabled={disabled || inputValue.trim().length === 0}
              onClick={() => void submitUtterance(inputValue)}
              className="flex h-9 shrink-0 items-center justify-center rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition-colors hover:brightness-110 disabled:opacity-50"
            >
              {loading ? "…" : "Send"}
            </button>
          </div>

          {history.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example}
                  type="button"
                  disabled={disabled}
                  onClick={() => void submitUtterance(example)}
                  className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-50"
                >
                  {example}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        {history.length > 0 && (
          <button
            type="button"
            disabled={running}
            onClick={handleStartOver}
            className="text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Start over
          </button>
        )}
        <button
          type="button"
          disabled={running}
          onClick={() => onSwitchToForm()}
          className="text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Use structured form instead
        </button>
      </div>
    </div>
  );
}

/**
 * Discoverable editing (Buyer Intake audit, pass 3) — a compact,
 * persistent summary of the real requirements understood so far, each
 * with its own subtle Edit affordance. Only ever shown once at least one
 * field has a real value (buildRequirementRows returns real rows or
 * none — never a placeholder for an unset field), so there is nothing to
 * edit before the conversation has actually produced anything. Every
 * value here is the buyer's OWN stated intent (product/quantity/budget/
 * delivery) — never merchant data, so there is structurally nothing
 * private (no minPrice/floor) that could ever appear here.
 */
function RequirementsSummary({
  understood,
  onEdit,
  disabled,
}: {
  understood: Partial<BuyerIntent>;
  onEdit: (field: BuyerIntentField) => void;
  disabled: boolean;
}) {
  const rows = buildRequirementRows(understood);
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface/60 p-4">
      <p className="text-[10px] font-semibold tracking-widest text-muted uppercase">Your requirements</p>
      <dl className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.field} className="flex items-center justify-between gap-3 text-sm">
            <dt className="text-muted">{row.label}</dt>
            <div className="flex items-center gap-2.5">
              <dd className="tabular-nums font-medium text-foreground">{row.value}</dd>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onEdit(row.field)}
                className="text-[11px] font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
              >
                Edit
              </button>
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] text-sm leading-6 text-foreground/90">{text}</p>
    </div>
  );
}

function AgentMessage({ text, reducedMotion, children }: { text: string; reducedMotion: boolean; children?: ReactNode }) {
  const revealed = useTypewriterReveal(text, reducedMotion);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" aria-hidden />
        <p className="text-sm leading-6 text-foreground">
          {revealed.text}
          {!revealed.complete && (
            <span className="-mb-0.5 ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-blue-300 align-middle" aria-hidden />
          )}
        </p>
      </div>
      {children && <div className="pl-4">{children}</div>}
    </div>
  );
}

function LivePhaseContent({
  phase,
  understood,
  products,
  disabled,
  onSelectProduct,
  onSelectDelivery,
  onSearchAgain,
  onContinueWithStock,
  onChooseAnotherProduct,
  onAcceptSpecMismatch,
  onShowOtherOptions,
  onStart,
  running,
}: {
  phase: Phase;
  understood: Partial<BuyerIntent>;
  products: PublicManifestProduct[];
  disabled: boolean;
  onSelectProduct: (product: PublicManifestProduct) => void;
  onSelectDelivery: (days: number) => void;
  onSearchAgain: () => void;
  onContinueWithStock: (product: PublicManifestProduct) => void;
  onChooseAnotherProduct: () => void;
  onAcceptSpecMismatch: (product: PublicManifestProduct) => void;
  onShowOtherOptions: () => void;
  onStart: () => void;
  running: boolean;
}) {
  if (phase.kind === "spec_mismatch") {
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAcceptSpecMismatch(phase.product)}
          className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:brightness-110 disabled:opacity-50"
        >
          Continue with {phase.product.name}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onShowOtherOptions}
          className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-50"
        >
          Show other options
        </button>
      </div>
    );
  }

  if (phase.kind === "catalog_mismatch") {
    return (
      <div className="flex flex-col gap-2">
        {phase.suggestions.map((product) => (
          <CatalogSuggestionCard key={product.sku} product={product} disabled={disabled} onSelect={() => onSelectProduct(product)} />
        ))}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            disabled={disabled}
            onClick={onSearchAgain}
            className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-50"
          >
            Search again
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "quantity_check") {
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onContinueWithStock(phase.product)}
          className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:brightness-110 disabled:opacity-50"
        >
          Continue with {phase.product.availableQuantity}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onChooseAnotherProduct}
          className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-50"
        >
          Choose another product
        </button>
      </div>
    );
  }

  if (phase.kind === "ready") {
    const complete = withDefaults(understood);
    if (!complete) return null;
    return <NegotiationReady intent={complete} disabled={running} onStart={onStart} />;
  }

  // "collecting" — quick replies for the field currently being asked
  // about, when the field has a natural small, enumerable option set.
  // The real catalog is small enough to offer every product directly
  // ("offers available options", not just a free-text prompt).
  const missing = nextMissingField(understood);
  if (missing === "product") {
    return (
      <div className="flex flex-col gap-2">
        {products.map((product) => (
          <CatalogSuggestionCard key={product.sku} product={product} disabled={disabled} onSelect={() => onSelectProduct(product)} />
        ))}
      </div>
    );
  }
  if (missing === "deliveryDeadlineDays") {
    return (
      <div className="flex flex-wrap gap-2">
        {DELIVERY_QUICK_REPLIES.map((days) => (
          <button
            key={days}
            type="button"
            disabled={disabled}
            onClick={() => onSelectDelivery(days)}
            className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-50"
          >
            ≤ {days} days
          </button>
        ))}
      </div>
    );
  }
  return null;
}

function CatalogSuggestionCard({
  product,
  disabled,
  onSelect,
}: {
  product: PublicManifestProduct;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium text-foreground">{product.name}</p>
        <p className="text-xs text-muted">
          {formatInr(product.listedPrice)} listed · {product.availableQuantity} in stock ·{" "}
          {product.standardDeliveryDays}–{product.maxDeliveryDays} day delivery
        </p>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className="shrink-0 rounded-full border border-border-strong px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-white/[.04] disabled:opacity-50"
      >
        Use this
      </button>
    </div>
  );
}

function NegotiationReady({ intent, disabled, onStart }: { intent: BuyerIntent; disabled: boolean; onStart: () => void }) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-accent/30 bg-background p-4 sm:p-5">
      <div>
        <p className="text-xs font-semibold tracking-widest text-accent uppercase">Ready to negotiate</p>
        <h3 className="mt-1 text-lg font-medium text-foreground">{intent.productName}</h3>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">Quantity</dt>
          <dd className="tabular-nums font-medium text-foreground">{intent.quantity} units</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Maximum</dt>
          <dd className="tabular-nums font-medium text-foreground">{formatInr(intent.maxPrice)}/unit</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Delivery</dt>
          <dd className="tabular-nums font-medium text-foreground">≤ {intent.deliveryDeadlineDays} days</dd>
        </div>
      </dl>
      <p className="text-xs text-muted">Your Buyer Agent will negotiate within these requirements.</p>
      <button
        type="button"
        disabled={disabled}
        onClick={onStart}
        className="flex h-11 w-fit items-center justify-center gap-2 rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition-colors hover:brightness-110 disabled:opacity-50"
      >
        Start negotiation <span aria-hidden>→</span>
      </button>
    </div>
  );
}
