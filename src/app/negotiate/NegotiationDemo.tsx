"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { PublicManifestProduct } from "@/types/manifest";
import type {
  LeverageScoreDTO,
  NegotiationMessageDTO,
  NegotiationSessionCreateRequest,
  NegotiationSessionResponse,
  NegotiationTurnResponse,
  PersistedAgreementDTO,
} from "@/types/negotiation";
import type { AgentDecisionRecord, AgentObservation, TurnDecisionAudit } from "@/lib/negotiation/agentDecision";
import type { NegotiationStatus } from "@/lib/rules/negotiationState";
// Only the pure, dependency-free mapping helper and its type are used
// client-side — parseBuyerIntent itself (which calls the LLM provider)
// stays server-only, reached via POST /api/negotiations/intent (see
// BuyerConversation.tsx), never imported directly into this client
// bundle.
import { buyerIntentToSessionRequest } from "@/lib/negotiation/buyerIntentParser";
import type { BuyerIntent } from "@/lib/negotiation/buyerIntentParser";
import { AuditTrailPanel } from "./AuditTrailPanel";
import { BuyerConversation } from "./BuyerConversation";
import { usePrefersReducedMotion, useTypewriterReveal } from "./negotiateClientHooks";
import {
  buyerThinkingLabel,
  computeConvergenceChartData,
  computeMaxOrderValue,
  describeTradeAnnotation,
  formatInr,
  getScenarioPresets,
  merchantThinkingLabel,
  negotiationFailureExplanation,
  negotiationMessageTypeLabel,
  negotiationMoveBadgeClass,
  negotiationMoveLabel,
  negotiationPriceGap,
  negotiationStatusLabel,
  parseBuyerRequestForm,
  type BuyerRequestFormValues,
} from "./negotiationUi";
import { PaymentPanel } from "@/app/negotiate/PaymentPanel";
import { AgentField, type AgentFieldPhase } from "@/components/AgentField";
import { InspectorPanel } from "@/components/InspectorPanel";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How long each staged reveal pauses for — modest, not a fake wait. The
// turn itself is already fully computed server-side (real deterministic
// engine + agents) before any of this pacing happens; these delays only
// control how quickly the already-known result is revealed on screen.
const REVEAL_DELAY_MS = 450;
const THINKING_DELAY_MS = 550;
const NEXT_TURN_PAUSE_MS = 350;

const TERMINAL_STATUSES: NegotiationStatus[] = ["AGREED", "REJECTED", "EXPIRED"];

interface TranscriptTurn {
  turn: number;
  buyer: NegotiationMessageDTO | null;
  merchant: NegotiationMessageDTO | null;
  leverage: LeverageScoreDTO | null;
  /** Agentic Decision + Audit Trail: both sides' captured deterministic decisions for this round — see agentDecision.ts. Null until the turn is fully revealed (alongside merchant/leverage), or when the server genuinely made no agent decision this round (a structural walk-away). */
  decisionAudit: TurnDecisionAudit | null;
}

interface NegotiationDemoProps {
  products: PublicManifestProduct[];
}

/**
 * Presentation-only progressive reveal of an ALREADY-COMPLETE string —
 * never a fake backend stream. The full `text` (e.g. a round's real,
 * already-persisted decision reason — see oneLineDecisionReason below)
 * is known synchronously the instant this hook receives it; this only
 * paces how many of its characters are shown, via requestAnimationFrame,
 * client-side, exactly like the existing turn-reveal pacing
 * (REVEAL_DELAY_MS etc.) already does for buyer/merchant turns.
 *
 * Every setState call lives inside a rAF callback, never directly in
 * the effect body (see react-hooks/set-state-in-effect — the same
 * pattern already established by AgentField's own pacing effect).
 *
 * Race-safety: `state.source` records which exact string the current
 * `count` belongs to. If `text` changes while a reveal is mid-flight,
 * the effect's cleanup cancels the in-flight rAF (also covering
 * unmount) and a fresh effect run starts counting from 0 against the
 * NEW string — but render-time derivation below never trusts `state`
 * unless `state.source` still matches the CURRENT `text` prop, so even
 * the one-frame gap before that fresh run's first tick lands renders
 * empty rather than a stale character from the previous turn.
 */
// Client Component: owns only form/UI staging state and the fetch calls
// to the turn-based API (POST /api/negotiations, then repeated
// POST /api/negotiations/:id/turn). It never computes a price,
// quantity, delivery day, or outcome itself — every structured value
// rendered below comes straight from those API responses, which are
// built entirely by the existing deterministic orchestrator/rule
// engine. The API is called once per turn (not once for the whole
// negotiation), so the transcript genuinely appears one exchange at a
// time rather than being calculated all at once and dumped on screen.
export function NegotiationDemo({ products }: NegotiationDemoProps) {
  const defaultSku = products.some((p) => p.sku === "LAPTOP-14-I5")
    ? "LAPTOP-14-I5"
    : (products[0]?.sku ?? "");

  const [form, setForm] = useState<BuyerRequestFormValues>({
    sku: defaultSku,
    quantity: "200",
    maxUnitPrice: "45000",
    deliveryDeadlineDays: "10",
    urgency: "medium",
    deliveryFlexible: false,
  });
  const presets = getScenarioPresets(products);
  const [formError, setFormError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);

  const [maxRounds, setMaxRounds] = useState<number | null>(null);
  // Audit Trail viewer: the one piece of identity AuditTrailPanel needs
  // to fetch GET /api/negotiations/:id/audit-trail on demand. Not used
  // for anything else — every other piece of UI state in this component
  // already comes from the turn-by-turn responses, unaffected by this.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // UI display fix: the engine's own `round` (state.round, above) is a
  // round-BUDGET counter for the deterministic concession formulas
  // (roundsLeft, etc.) — an explicit accept/reject/walk-away closes the
  // negotiation without consuming a new round of that budget (see
  // negotiationState.ts's acceptNegotiation/rejectNegotiation, both
  // deliberately unchanged here), so on the turn that actually closes
  // the negotiation, `round` stays one behind the round a person can see
  // in the transcript. `turn.turn` (turnNumber — negotiationSessionRepository.ts)
  // already increments on every persisted turn, including that closing
  // one, and is already what each transcript entry's own "Round N" label
  // uses (below) — this just also drives the header's summary count, so
  // both agree. Deliberately a SEPARATE state variable: the agreement
  // focal state still needs the engine's round-budget value (it compares
  // round === maxRounds to distinguish an early walk-away from genuine
  // round-exhaustion — see negotiationFailureExplanation) and must stay
  // exactly as it was.
  const [displayRound, setDisplayRound] = useState(0);
  const [status, setStatus] = useState<NegotiationStatus | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [thinking, setThinking] = useState<{ agent: "buyer" | "merchant"; label: string } | null>(
    null,
  );
  const [agreement, setAgreement] = useState<PersistedAgreementDTO | null>(null);

  // Redesign: which round's Decision Trace inspector is open — purely
  // presentational, never a second source of truth for negotiation state.
  const [traceRound, setTraceRound] = useState<number | null>(null);

  // Buyer Conversational Intake: the primary entry point is
  // BuyerConversation (its own file), a multi-turn conversational
  // wrapper over the SAME structured request the form below has always
  // produced — see buyerIntentParser.ts. The structured form itself,
  // and everything from `formError` down to the turn-polling loop
  // above, is completely unchanged: it remains the fallback/editing
  // layer, reachable at any time via entryMode "form". BuyerConversation
  // owns its own conversation/understood-fields state internally;
  // NegotiationDemo only needs to know which entry mode is active and
  // carry the one-line notice shown when falling back to the form.
  const [entryMode, setEntryMode] = useState<"intent" | "form">("intent");
  const [intentNotice, setIntentNotice] = useState<string | null>(null);

  const selectedProduct = products.find((p) => p.sku === form.sku) ?? null;
  const parsedQuantity = Number(form.quantity);
  const parsedMaxPrice = Number(form.maxUnitPrice);
  const maxOrderValuePreview =
    Number.isFinite(parsedQuantity) && Number.isFinite(parsedMaxPrice) && parsedQuantity > 0 && parsedMaxPrice > 0
      ? computeMaxOrderValue(parsedQuantity, parsedMaxPrice)
      : null;

  // The actual negotiation run — unchanged from before this milestone,
  // just extracted out of handleSubmit's body so both the structured
  // form AND the new natural-language confirmation card can start the
  // exact same flow. `parsed` is anything shaped like
  // NegotiationSessionCreateRequest — both the form's own ParsedBuyerRequest
  // and buyerIntentToSessionRequest's output satisfy this structurally,
  // targetUnitPrice included where present.
  async function runNegotiation(parsed: NegotiationSessionCreateRequest) {
    setApiError(null);
    setRunning(true);
    setStarted(true);
    setTranscript([]);
    setAgreement(null);
    setSessionId(null);
    setRound(0);
    setDisplayRound(0);
    setStatus(null);
    setTraceRound(null);
    setThinking({ agent: "buyer", label: buyerThinkingLabel(1) });

    try {
      const createResponse = await fetch("/api/negotiations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Milestone 12.5: demo-only — widens the visible negotiation
        // window past the API's own DEFAULT_MAX_ROUNDS (4), so the
        // final-two-round guaranteed-convergence safety net (which
        // activates once roundsLeft<=2) doesn't swallow half of every
        // demo run. The server-side default and every other caller of
        // POST /api/negotiations are completely unaffected — the API
        // already accepted an optional maxRounds field before this
        // change; only this one client now supplies it.
        // targetUnitPrice is absent from every existing (form) caller's
        // `parsed` object — JSON.stringify drops undefined keys, so this
        // is a no-op for them; only the natural-language path supplies it.
        body: JSON.stringify({ ...parsed, maxRounds: 6 }),
      });
      const session = (await createResponse.json()) as NegotiationSessionResponse & {
        error?: string;
      };
      if (!createResponse.ok) {
        setApiError(session.error ?? "Could not start the negotiation.");
        setRunning(false);
        setThinking(null);
        return;
      }

      setMaxRounds(session.maxRounds);
      setSessionId(session.sessionId);
      setStatus(session.status);

      let currentStatus: NegotiationStatus = session.status;
      while (!TERMINAL_STATUSES.includes(currentStatus)) {
        const turnResponse = await fetch(`/api/negotiations/${session.sessionId}/turn`, {
          method: "POST",
        });
        const turn = (await turnResponse.json()) as NegotiationTurnResponse & { error?: string };
        if (!turnResponse.ok) {
          setApiError(turn.error ?? "The negotiation could not continue.");
          break;
        }

        // Reveal the buyer's move first.
        await delay(REVEAL_DELAY_MS);
        setTranscript((prev) => [
          ...prev,
          { turn: turn.turn, buyer: turn.buyer, merchant: null, leverage: null, decisionAudit: null },
        ]);

        // Then show the merchant "thinking" before revealing its response
        // — the response itself is already known; this only paces its
        // reveal so the transcript doesn't dump instantly. The leverage
        // score is revealed alongside it, for the same reason: it's
        // already been computed server-side from this turn's real
        // structured result (leverage.ts), not something the UI derives
        // on its own.
        setThinking({ agent: "merchant", label: merchantThinkingLabel(turn.merchant.type) });
        await delay(THINKING_DELAY_MS);

        setTranscript((prev) =>
          prev.map((t) =>
            t.turn === turn.turn
              ? { ...t, merchant: turn.merchant, leverage: turn.leverage, decisionAudit: turn.decisionAudit ?? null }
              : t,
          ),
        );
        setRound(turn.round);
        setDisplayRound(turn.turn);
        setStatus(turn.status);
        currentStatus = turn.status;

        if (TERMINAL_STATUSES.includes(currentStatus)) {
          setAgreement(turn.agreement);
          setThinking(null);
          break;
        }

        await delay(NEXT_TURN_PAUSE_MS);
        setThinking({ agent: "buyer", label: buyerThinkingLabel(turn.turn + 1) });
      }
    } catch {
      setApiError("Could not reach the negotiation API.");
    } finally {
      setRunning(false);
      setThinking(null);
    }
  }

  // The structured form's own submit — unchanged behavior, now just a
  // thin wrapper around the shared runNegotiation.
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = parseBuyerRequestForm(form);
    if (typeof parsed === "string") {
      setFormError(parsed);
      return;
    }

    await runNegotiation(parsed);
  }

  // Copies whatever a BuyerIntentParseResult DID confidently understand
  // onto the existing form state — never invents a value for a field
  // that wasn't understood; those fields simply keep the form's current
  // value, exactly like a person editing the form by hand.
  function applyUnderstoodToForm(partial: Partial<BuyerIntent>) {
    setForm((prev) => ({
      sku: partial.sku ?? prev.sku,
      quantity: partial.quantity !== undefined ? String(partial.quantity) : prev.quantity,
      maxUnitPrice: partial.maxPrice !== undefined ? String(partial.maxPrice) : prev.maxUnitPrice,
      deliveryDeadlineDays:
        partial.deliveryDeadlineDays !== undefined ? String(partial.deliveryDeadlineDays) : prev.deliveryDeadlineDays,
      urgency: partial.urgency ?? prev.urgency,
      deliveryFlexible: partial.deliveryFlexible ?? prev.deliveryFlexible,
    }));
  }

  // The one bridge BuyerConversation needs into this component: when it
  // can't (or the user chooses not to) continue conversationally, hand
  // back whatever WAS understood so far and fall to the structured form
  // — the exact same "never invent, surface what's missing" contract
  // the old single-shot flow already had, just triggered from the new
  // conversation component instead of inline here.
  function handleConversationFallback(understood: Partial<BuyerIntent>, notice: string | null) {
    applyUnderstoodToForm(understood);
    setIntentNotice(notice);
    setEntryMode("form");
  }

  // BuyerConversation hands back the fully-resolved intent once ready —
  // this syncs `form` from it first (same applyUnderstoodToForm the
  // fallback path already uses, so the workspace's context panels below
  // show the REAL negotiated product/quantity/price/delivery, not the
  // form's stale default values) and only then calls the exact same,
  // unmodified runNegotiation the structured form's own submit already
  // uses — buyerIntentToSessionRequest is the same pure mapping the old
  // single-shot flow used, unchanged.
  function handleConversationReady(intent: BuyerIntent) {
    applyUnderstoodToForm(intent);
    void runNegotiation(buyerIntentToSessionRequest(intent));
  }

  // Presentation-only reset (no negotiation/API call): returns to the
  // request-entry step so a finished negotiation doesn't strand the
  // user on a dead-end screen. Nothing about the just-completed
  // session's persisted data changes — its audit trail/agreement remain
  // exactly as recorded; this only clears local UI state so a NEW
  // session can start.
  function handleStartOver() {
    setStarted(false);
    setIntentNotice(null);
    setEntryMode("intent");
    setTraceRound(null);
  }

  const lastTurn = transcript[transcript.length - 1];
  const latestBuyerOffer = lastTurn?.buyer ?? null;
  const latestMerchantOffer = lastTurn?.merchant ?? null;
  // Pass 11 addendum: distinct from `lastTurn` — a structural walk-away's
  // own closing turn has null prices on both sides (see NoDealFocal's own
  // comment), so the failure summary needs the last transcript entry that
  // actually carries a real merchant offer, not simply the last one.
  const lastPricedTurn = [...transcript].reverse().find((t) => t.merchant?.unitPrice != null) ?? null;
  const isTerminal = status !== null && TERMINAL_STATUSES.includes(status);
  const productLabel = selectedProduct?.name ?? form.sku;
  const productQuantity = latestMerchantOffer?.quantity ?? latestBuyerOffer?.quantity ?? null;

  const leverageEntries = transcript.filter(
    (t): t is TranscriptTurn & { leverage: LeverageScoreDTO } => t.leverage !== null,
  );
  const latestLeverage = leverageEntries[leverageEntries.length - 1]?.leverage ?? null;

  const reducedMotion = usePrefersReducedMotion();

  // Decorative pacing only — mirrors AgentStatusStepper's own existing
  // "cycle four labels while a turn is being revealed" convention, now
  // also driving the AgentField background's phase. Never a claim about
  // literal sub-turn backend phases (see AgentStatusStepper's own
  // comment) — the turn itself is already fully computed server-side
  // before any of this pacing runs.
  const [pacingPhase, setPacingPhase] = useState<AgentFieldPhase>("observing");
  useEffect(() => {
    if (!thinking) return;
    const steps: AgentFieldPhase[] = ["observing", "evaluating", "deciding", "acting"];
    let i = 0;
    const id = setInterval(() => {
      setPacingPhase(steps[i]);
      i = (i + 1) % steps.length;
    }, 400);
    return () => clearInterval(id);
  }, [thinking]);

  const fieldPhase: AgentFieldPhase = isTerminal
    ? "agreed"
    : thinking
      ? pacingPhase
      : transcript.length === 0
        ? "idle"
        : "observing";
  const fieldActingSide = thinking?.agent ?? null;

  const traceTurnIndex = traceRound !== null ? transcript.findIndex((t) => t.turn === traceRound) : -1;
  const traceTurn = traceTurnIndex >= 0 ? transcript[traceTurnIndex] : null;
  const tracePreviousTurn = traceTurnIndex > 0 ? transcript[traceTurnIndex - 1] : null;

  const buyerRows: { key: string; value: string; emphasize?: boolean }[] = [
    { key: "Target / max", value: formatInr(parsedMaxPrice) },
    { key: "Quantity", value: `${parsedQuantity} units` },
    { key: "Delivery", value: `≤ ${form.deliveryDeadlineDays} days` },
    ...(latestLeverage ? [{ key: "Leverage", value: `${latestLeverage.buyer}%` }] : []),
    {
      key: "Current offer",
      value: latestBuyerOffer?.unitPrice != null ? formatInr(latestBuyerOffer.unitPrice) : "—",
      emphasize: true,
    },
  ];

  const merchantRows: { key: string; value: string; emphasize?: boolean }[] = selectedProduct
    ? [
        { key: "Listed price", value: formatInr(selectedProduct.listedPrice) },
        { key: "Stock", value: `${selectedProduct.availableQuantity} units` },
        { key: "Max delivery", value: `${selectedProduct.maxDeliveryDays} days` },
        ...(latestLeverage ? [{ key: "Leverage", value: `${latestLeverage.merchant}%` }] : []),
        {
          key: "Current offer",
          value: latestMerchantOffer?.unitPrice != null ? formatInr(latestMerchantOffer.unitPrice) : "—",
          emphasize: true,
        },
      ]
    : [];

  return (
    <div className="flex flex-col">
      {/* Request entry — hidden once a negotiation is underway, so the
          workspace below can be the sole focus. No animate-fade-in here —
          it's the critical, first-paint content of /negotiate (same
          reasoning as the landing hero: never let primary above-the-fold
          content start invisible). */}
      {!started && (
        <section className="relative flex min-h-[72vh] flex-col justify-center overflow-hidden px-4 py-10 sm:px-6">
          <AgentField phase="idle" />
          <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-col gap-5">
            {entryMode === "intent" ? (
              <BuyerConversation
                products={products}
                running={running}
                onReady={handleConversationReady}
                onFallback={handleConversationFallback}
                onSwitchToForm={() => setEntryMode("form")}
              />
            ) : (
              <StructuredForm
                form={form}
                setForm={setForm}
                products={products}
                presets={presets}
                selectedProduct={selectedProduct}
                maxOrderValuePreview={maxOrderValuePreview}
                running={running}
                formError={formError}
                apiError={apiError}
                intentNotice={intentNotice}
                onSubmit={handleSubmit}
                onBackToIntent={() => setEntryMode("intent")}
              />
            )}
          </div>
        </section>
      )}

      {started && (
        // Deliberately NOT animate-fade-in: a completed CSS animation's
        // held end-state transform (translateY(0) — a real transform
        // function, not `none`) makes the element a containing block for
        // ALL position:fixed descendants per spec. This section hosts
        // the Decision Trace inspector AND (via AgreementFocal)
        // PaymentPanel's own checkout backdrop, both `fixed inset-0` —
        // confirmed live that this exact interaction was trapping both
        // off-viewport (getBoundingClientRect returning a small rect
        // nowhere near {0,0,vw,vh}) rather than covering the screen.
        // The workspace is also primary content, not decoration — it
        // should never be gated behind an entrance animation anyway.
        <section className="relative flex flex-col gap-8 overflow-hidden px-4 py-8 sm:px-6 lg:px-10 lg:py-10">
          <AgentField phase={fieldPhase} actingSide={fieldActingSide} />

          <div className="relative z-10 flex flex-col gap-8">
            <WorkspaceTopBar
              status={status}
              productLabel={productLabel}
              productQuantity={productQuantity}
              round={displayRound}
              maxRounds={maxRounds}
            />

            <StateProgression active={thinking !== null} agreed={status === "AGREED"} />

            {apiError && (
              <p className="rounded-xl border border-red-500/30 bg-red-500/[.06] px-4 py-3 text-sm text-red-300">
                {apiError}
              </p>
            )}

            <MobileFieldSummary
              buyerPrice={latestBuyerOffer?.unitPrice ?? null}
              merchantPrice={latestMerchantOffer?.unitPrice ?? null}
              round={displayRound}
              maxRounds={maxRounds}
            />

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(0,1fr)_200px] lg:items-start lg:gap-8">
              <ContextPanel
                tone="blue"
                label="Buyer Agent"
                rows={buyerRows}
                isActing={thinking?.agent === "buyer"}
                className="order-2 lg:order-1"
              />

              <NegotiationField
                transcript={transcript}
                agreement={agreement}
                isTerminal={isTerminal}
                status={status}
                thinking={thinking}
                lastTurn={lastTurn}
                round={round}
                maxRounds={maxRounds}
                productName={selectedProduct?.name ?? null}
                buyerMaxPrice={Number.isFinite(parsedMaxPrice) && parsedMaxPrice > 0 ? parsedMaxPrice : null}
                merchantFinalPrice={lastPricedTurn?.merchant?.unitPrice ?? null}
                onStartOver={handleStartOver}
                onOpenTrace={setTraceRound}
                reducedMotion={reducedMotion}
                className="order-1 lg:order-2"
              />

              {selectedProduct && (
                <ContextPanel
                  tone="amber"
                  label="Merchant Agent"
                  rows={merchantRows}
                  isActing={thinking?.agent === "merchant"}
                  className="order-3"
                />
              )}
            </div>

            <AuditTrailPanel sessionId={sessionId} productName={selectedProduct?.name ?? null} />

            {isTerminal && (
              <button
                type="button"
                onClick={handleStartOver}
                className="self-start text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                ← Start a new negotiation
              </button>
            )}
          </div>

          {traceTurn && (
            <DecisionTracePanel
              turn={traceTurn}
              previousTurn={tracePreviousTurn}
              productLabel={productLabel}
              buyerMaxPrice={Number.isFinite(parsedMaxPrice) && parsedMaxPrice > 0 ? parsedMaxPrice : null}
              onClose={() => setTraceRound(null)}
            />
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The manual structured form — a secondary, always-available fallback.
 * Every field/handler here is exactly what NegotiationDemo already
 * owned; only the presentation changed.
 */
function StructuredForm({
  form,
  setForm,
  products,
  presets,
  selectedProduct,
  maxOrderValuePreview,
  running,
  formError,
  apiError,
  intentNotice,
  onSubmit,
  onBackToIntent,
}: {
  form: BuyerRequestFormValues;
  setForm: (form: BuyerRequestFormValues) => void;
  products: PublicManifestProduct[];
  presets: ReturnType<typeof getScenarioPresets>;
  selectedProduct: PublicManifestProduct | null;
  maxOrderValuePreview: number | null;
  running: boolean;
  formError: string | null;
  apiError: string | null;
  intentNotice: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBackToIntent: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        disabled={running}
        onClick={onBackToIntent}
        className="self-start text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        ← Back to natural language
      </button>

      {intentNotice && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/[.06] px-4 py-3 text-sm text-amber-200">
          {intentNotice}
        </p>
      )}

      <div>
        <h2 className="text-xl font-medium text-foreground">Start a negotiation</h2>
        <p className="text-sm text-muted">
          Tell the Buyer Agent what it&rsquo;s shopping for.
        </p>
      </div>

      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              disabled={running}
              title={preset.description}
              onClick={() => setForm(preset.values)}
              className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-50"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted">Product</span>
            <select
              value={form.sku}
              disabled={running}
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-foreground disabled:opacity-50"
            >
              {products.map((product) => (
                <option key={product.sku} value={product.sku}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted">Quantity</span>
            <input
              type="number"
              min={1}
              disabled={running}
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-foreground disabled:opacity-50"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted">Maximum price per unit (₹)</span>
            <input
              type="number"
              min={1}
              disabled={running}
              value={form.maxUnitPrice}
              onChange={(e) => setForm({ ...form, maxUnitPrice: e.target.value })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-foreground disabled:opacity-50"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted">Delivery deadline (days)</span>
            <input
              type="number"
              min={1}
              disabled={running}
              value={form.deliveryDeadlineDays}
              onChange={(e) => setForm({ ...form, deliveryDeadlineDays: e.target.value })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-foreground disabled:opacity-50"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted">Buyer urgency</span>
            <select
              value={form.urgency}
              disabled={running}
              onChange={(e) => setForm({ ...form, urgency: e.target.value as BuyerRequestFormValues["urgency"] })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-foreground disabled:opacity-50"
            >
              <option value="low">Low — can wait</option>
              <option value="medium">Medium</option>
              <option value="high">High — needs it fast</option>
            </select>
          </label>

          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              disabled={running}
              checked={form.deliveryFlexible}
              onChange={(e) => setForm({ ...form, deliveryFlexible: e.target.checked })}
              className="h-4 w-4 rounded border-border disabled:opacity-50"
            />
            <span className="font-medium text-muted">Flexible on delivery (trade for a better price)</span>
          </label>
        </div>

        {selectedProduct && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-white/[.03] px-4 py-3 text-xs text-muted">
            <span>
              Listed price: <span className="font-medium text-foreground">{formatInr(selectedProduct.listedPrice)} / unit</span>
            </span>
            <span>
              Available: <span className="font-medium text-foreground">{selectedProduct.availableQuantity}</span>
            </span>
            <span>
              Standard delivery: <span className="font-medium text-foreground">{selectedProduct.standardDeliveryDays}d</span>
            </span>
            <span>
              Negotiable: <span className="font-medium text-foreground">{selectedProduct.negotiable ? "Yes" : "No"}</span>
            </span>
            {maxOrderValuePreview !== null && (
              <span className="ml-auto">
                Max order value: <span className="font-medium text-foreground">{formatInr(maxOrderValuePreview)}</span>
              </span>
            )}
          </div>
        )}

        <div>
          {formError && <p className="mb-2 text-sm text-red-300">{formError}</p>}
          {apiError && <p className="mb-2 text-sm text-red-300">{apiError}</p>}
          <button
            type="submit"
            disabled={running}
            className="flex h-11 items-center justify-center rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition-colors hover:brightness-110 disabled:opacity-50"
          >
            {running ? "Negotiating…" : "Start Negotiation"}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * The workspace's top strip — status, round counter, product. Purely a
 * direct read of state NegotiationDemo already holds.
 */
function WorkspaceTopBar({
  status,
  productLabel,
  productQuantity,
  round,
  maxRounds,
}: {
  status: NegotiationStatus | null;
  productLabel: string;
  productQuantity: number | null;
  round: number;
  maxRounds: number | null;
}) {
  const isTerminal = status !== null && TERMINAL_STATUSES.includes(status);
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="inline-flex items-center gap-2 text-xs font-semibold tracking-widest text-muted uppercase">
          <span
            className={`h-1.5 w-1.5 rounded-full ${isTerminal ? "bg-white/30" : "animate-pulse bg-accent"}`}
            aria-hidden
          />
          {status ? negotiationStatusLabel(status) : "Negotiating"}
        </span>
        <h1 className="text-display-3 font-semibold text-foreground">
          {productQuantity !== null ? `${productQuantity} × ` : ""}
          {productLabel}
        </h1>
      </div>
      <p className="tabular-nums text-sm text-muted">
        Round {round} of {maxRounds ?? "—"}
      </p>
    </div>
  );
}

/**
 * A persistent agent context column — buyer or merchant, whichever the
 * caller supplies rows for. Deliberately border/box-free (Redesign 2.0,
 * section 10: reduce visual clutter) — a plain typographic column, not
 * another card. `isActing` is real, already-known state (thinking.agent
 * === this side, from NegotiationDemo's own `thinking`) — never a new
 * timer or guess: the label dot gets a soft glow for exactly the same
 * window AgentField's canvas already treats this side as active. The
 * merchant side is only ever fed PUBLIC catalog facts
 * (listedPrice/availableQuantity/maxDeliveryDays —
 * PublicManifestProduct's own fields, see types/manifest.ts): that DTO
 * structurally has no minPrice field at all, so there is nothing private
 * available to leak here even by mistake.
 */
function ContextPanel({
  tone,
  label,
  rows,
  isActing,
  className,
}: {
  tone: "blue" | "amber";
  label: string;
  rows: { key: string; value: string; emphasize?: boolean }[];
  isActing?: boolean;
  className?: string;
}) {
  const toneClass = tone === "blue" ? "text-blue-300" : "text-yellow-300";
  const dotClass = tone === "blue" ? "bg-blue-400" : "bg-yellow-400";
  const emphasizedRow = rows.find((row) => row.emphasize);
  const restRows = rows.filter((row) => row !== emphasizedRow);
  return (
    <div className={`flex flex-col gap-3 lg:sticky lg:top-24 ${className ?? ""}`}>
      <span className={`flex items-center gap-2 text-[11px] font-semibold tracking-widest uppercase ${toneClass}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass} ${isActing ? "animate-agent-glow" : ""}`} aria-hidden />
        {label}
      </span>
      {/* Redesign 2.0, section 14: below lg, this is secondary detail —
          genuinely expandable/collapsible (native <details>, defaults
          open so nothing regresses), not just visually de-prioritized.
          At lg+ (the persistent side column), the disclosure marker is
          hidden and the summary/content act as one static block, same
          as before this change. The one "current offer" row stays
          outside the collapsible content either way — it's the number
          MobileFieldSummary already treats as the hero, so it should
          never disappear behind a closed disclosure. */}
      <details open className="group flex flex-col gap-2.5 border-t border-border pt-3 lg:[&_summary::-webkit-details-marker]:hidden">
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 text-sm lg:pointer-events-none">
          {emphasizedRow ? (
            <>
              <span className="text-muted">{emphasizedRow.key}</span>
              <span className="tabular-nums text-base font-medium text-foreground">{emphasizedRow.value}</span>
            </>
          ) : (
            <span className="text-muted">Details</span>
          )}
          <span className="ml-auto text-[10px] text-muted transition-transform group-open:rotate-180 lg:hidden" aria-hidden>
            ⌄
          </span>
        </summary>
        <dl className="flex flex-col gap-2.5 pt-1">
          {restRows.map((row) => (
            <div key={row.key} className="flex items-baseline justify-between gap-3 text-sm">
              <dt className="text-muted">{row.key}</dt>
              <dd className={`tabular-nums font-medium text-foreground ${row.emphasize ? "text-base" : ""}`}>{row.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

/**
 * Mobile/tablet-only compact snapshot (Redesign 2.0, section 14) — the
 * hero "buyer ↔ merchant" numbers, visible immediately below the fold,
 * before the fuller ContextPanel columns (which stack lower on narrow
 * screens). Hidden at lg+, where the persistent side columns already
 * show this. Same real offer values ContextPanel's own rows use.
 */
function MobileFieldSummary({
  buyerPrice,
  merchantPrice,
  round,
  maxRounds,
}: {
  buyerPrice: number | null;
  merchantPrice: number | null;
  round: number;
  maxRounds: number | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-y border-border py-3 lg:hidden">
      <div>
        <p className="text-[10px] font-semibold tracking-widest text-blue-300/80 uppercase">Buyer</p>
        <p className="tabular-nums text-lg font-semibold text-foreground">{buyerPrice !== null ? formatInr(buyerPrice) : "—"}</p>
      </div>
      <span className="text-xs text-muted">
        Round {round}
        {maxRounds ? ` / ${maxRounds}` : ""}
      </span>
      <div className="text-right">
        <p className="text-[10px] font-semibold tracking-widest text-yellow-300/80 uppercase">Merchant</p>
        <p className="tabular-nums text-lg font-semibold text-foreground">{merchantPrice !== null ? formatInr(merchantPrice) : "—"}</p>
      </div>
    </div>
  );
}

/**
 * The negotiation field itself — Redesign 2.0's actual hero. ONE bordered
 * surface (section 10: reduce visual clutter — no more separate boxed
 * chart / activity / history stacked on top of each other) holding, top
 * to bottom: the real current offers + convergence trajectory
 * (ConvergenceChart), the current state — live turn event, AGREED
 * resolution, or the terminal conclusion (FieldStateSlot) — and the
 * round-by-round history (RoundRows). Every child renders bare content;
 * this component owns the one outer border and the dividers between
 * them.
 */
function NegotiationField({
  transcript,
  agreement,
  isTerminal,
  status,
  thinking,
  lastTurn,
  round,
  maxRounds,
  productName,
  buyerMaxPrice,
  merchantFinalPrice,
  onStartOver,
  onOpenTrace,
  reducedMotion,
  className,
}: {
  transcript: TranscriptTurn[];
  agreement: PersistedAgreementDTO | null;
  isTerminal: boolean;
  status: NegotiationStatus | null;
  thinking: { agent: "buyer" | "merchant"; label: string } | null;
  lastTurn: TranscriptTurn | undefined;
  round: number;
  maxRounds: number | null;
  productName: string | null;
  buyerMaxPrice: number | null;
  merchantFinalPrice: number | null;
  onStartOver: () => void;
  onOpenTrace: (turn: number) => void;
  reducedMotion: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col rounded-2xl border border-border bg-surface/60 p-4 sm:p-6 ${className ?? ""}`}>
      <ConvergenceChart transcript={transcript} agreement={agreement} isTerminal={isTerminal} reducedMotion={reducedMotion} />
      <FieldStateSlot
        transcript={transcript}
        thinking={thinking}
        isTerminal={isTerminal}
        status={status}
        agreement={agreement}
        lastTurn={lastTurn}
        round={round}
        maxRounds={maxRounds}
        productName={productName}
        buyerMaxPrice={buyerMaxPrice}
        merchantFinalPrice={merchantFinalPrice}
        onStartOver={onStartOver}
      />
      <RoundRows transcript={transcript} onOpenTrace={onOpenTrace} reducedMotion={reducedMotion} />
    </div>
  );
}

/**
 * The negotiation field's hero: real current buyer/merchant offers and
 * the live gap between them (Redesign 2.0, section 6 — this is the
 * dominant element, not a small chart tucked in a box), then the
 * convergence trajectory once there's enough history to plot one.
 * Successor to the earlier PriceConvergenceChart: same real-data-only
 * min/max normalization, a two-line SVG chart, with a one-shot
 * "converged" ring drawn over the final round's two points once the
 * negotiation is genuinely AGREED. No own border/box — this now lives
 * directly inside NegotiationField's single unified surface.
 */
function ConvergenceChart({
  transcript,
  agreement,
  isTerminal,
  reducedMotion,
}: {
  transcript: TranscriptTurn[];
  agreement: PersistedAgreementDTO | null;
  isTerminal: boolean;
  reducedMotion: boolean;
}) {
  // Pass 11, Objective B: all round filtering, gap math, and x/y scaling
  // now lives in computeConvergenceChartData (negotiationUi.ts) — a
  // pure, directly-testable function; this component only renders
  // whatever it returns. It also fixes the previous non-uniform scaling
  // bug: the old viewBox (0 0 100 100) with preserveAspectRatio="none",
  // stretched into a wide/short CSS box, squashed every circular marker
  // into a soft-looking ellipse and made vectorEffect="non-scaling-
  // stroke" lines render at a fixed, wafer-thin 0.8 CSS pixels regardless
  // of viewport. The viewBox height below (42) is chosen to match the
  // container's own CSS aspect-ratio (~12:5), so the scale is uniform —
  // no ellipses, no direction-dependent stroke width, no
  // preserveAspectRatio/non-scaling-stroke needed at all.
  const viewHeight = 42;
  const topMargin = 6;
  const data = computeConvergenceChartData(transcript, agreement !== null, isTerminal, viewHeight);
  const last = transcript.filter((t) => t.buyer?.unitPrice != null && t.merchant?.unitPrice != null).at(-1) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold tracking-widest text-blue-300/80 uppercase">Buyer offer</p>
          <p className="tabular-nums text-3xl font-semibold text-foreground sm:text-4xl">
            {last ? formatInr(last.buyer!.unitPrice as number) : "—"}
          </p>
        </div>
        {data && (
          <div className="flex flex-col items-center gap-0.5 pb-1.5">
            <p className="text-[10px] font-medium tracking-wide text-muted uppercase">
              Gap{data.gapDirection ? ` · ${data.gapDirection}` : ""}
            </p>
            <p className="tabular-nums text-sm font-medium text-accent">{formatInr(data.currentGap)}</p>
          </div>
        )}
        <div className="text-right">
          <p className="text-[11px] font-semibold tracking-widest text-yellow-300/80 uppercase">Merchant offer</p>
          <p className="tabular-nums text-3xl font-semibold text-foreground sm:text-4xl">
            {last ? formatInr(last.merchant!.unitPrice as number) : "—"}
          </p>
        </div>
      </div>

      {data && (
        <div className="flex flex-col gap-2">
          <div
            className="aspect-[12/5] max-h-64 min-h-[132px] w-full overflow-hidden rounded-xl border border-border/70 bg-base/40"
            style={{ contain: "layout paint" }}
          >
            <svg viewBox={`0 0 100 ${viewHeight}`} className="h-full w-full" aria-hidden>
              <polygon
                points={data.gapPolygonPoints}
                fill="var(--accent)"
                opacity={0.1}
                stroke="var(--accent)"
                strokeWidth={0.15}
                strokeOpacity={0.3}
              />
              <path d={data.buyerPath} fill="none" stroke="#60a5fa" strokeWidth={0.55} strokeLinejoin="round" strokeLinecap="round" />
              <path d={data.merchantPath} fill="none" stroke="#facc15" strokeWidth={0.55} strokeLinejoin="round" strokeLinecap="round" />

              {/* Trade-round event marker (Objective B, item 6) — a small,
                  restrained diamond above the round's own x position,
                  never a large badge that competes with the trajectories. */}
              {data.rounds.map((r) =>
                r.isTradeRound ? (
                  <rect
                    key={`trade-${r.turn}`}
                    x={r.buyerPoint.x - 0.9}
                    y={topMargin - 3.4}
                    width={1.8}
                    height={1.8}
                    fill="var(--accent)"
                    opacity={0.85}
                    transform={`rotate(45 ${r.buyerPoint.x} ${topMargin - 2.5})`}
                  />
                ) : null,
              )}

              {/*
                Redesign 2.0.1 (D1, "current round stronger emphasis"), Pass
                11 (Objective B item 7, "agreement endpoint" fix): every past
                round's marker renders quieter/smaller; the LATEST round is
                emphasized; on convergence the final point becomes the
                strongest marker on the chart (a larger filled dot, not just
                a thin ring around a shrunken-back dot as before).
              */}
              {data.rounds.map((r, i) => {
                const isLast = i === data.rounds.length - 1;
                const radius = isLast ? (data.converged ? 2.5 : 2.1) : 1.3;
                return <circle key={`b${i}`} cx={r.buyerPoint.x} cy={r.buyerPoint.y} r={radius} fill="#60a5fa" opacity={isLast ? 1 : 0.7} />;
              })}
              {data.rounds.map((r, i) => {
                const isLast = i === data.rounds.length - 1;
                const radius = isLast ? (data.converged ? 2.5 : 2.1) : 1.3;
                return <circle key={`m${i}`} cx={r.merchantPoint.x} cy={r.merchantPoint.y} r={radius} fill="#facc15" opacity={isLast ? 1 : 0.7} />;
              })}
              {data.converged &&
                [data.rounds.at(-1)!.buyerPoint, data.rounds.at(-1)!.merchantPoint].map((p, i) => (
                  <circle key={`ring${i}`} cx={p.x} cy={p.y} r={3.8} fill="none" stroke="var(--accent)" strokeWidth={0.5} />
                ))}
              {data.converged &&
                !reducedMotion &&
                [data.rounds.at(-1)!.buyerPoint, data.rounds.at(-1)!.merchantPoint].map((p, i) => (
                  <circle key={`pulse${i}`} cx={p.x} cy={p.y} r={3.8} fill="none" stroke="var(--accent)" strokeWidth={0.5}>
                    <animate attributeName="r" values="3.8;7.5;3.8" dur="1.4s" begin="0s" fill="freeze" repeatCount="1" />
                    <animate attributeName="opacity" values="0.7;0;0" dur="1.4s" begin="0s" fill="freeze" repeatCount="1" />
                  </circle>
                ))}
            </svg>
          </div>
          {/*
            Redesign 2.0.1 (D1, "make the current price gap visible" per
            round, not just the latest): a compact rupee figure under
            each round's own x-position — real Math.abs(merchant-buyer)
            for THAT round, never the chart's own single running "Gap"
            headline repeated.
          */}
          <div className="relative h-4 text-[10px] text-muted">
            {data.rounds.map((r, i) => (
              <span
                key={`gap-${r.turn}`}
                className={`absolute -translate-x-1/2 tabular-nums ${i === data.rounds.length - 1 ? "font-medium text-accent" : ""}`}
                style={{ left: `${r.buyerPoint.x}%` }}
              >
                {r.gap === 0 ? "₹0" : formatInr(r.gap)}
              </span>
            ))}
          </div>
          <div className="relative h-3.5 text-[11px] text-muted/80">
            {data.rounds.map((r) => (
              <span key={r.turn} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${r.buyerPoint.x}%` }}>
                R{r.turn}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The negotiation's turn-in-progress event (Redesign 2.0, sections 1 and
 * 3): which agent is acting, and — the instant the OTHER side's move for
 * this round is already known (real transcript data, already revealed)
 * — that real price, framed as "traveling to" the side now deciding.
 * Rendered only while `thinking` is set, i.e. exactly the same real
 * pacing window AgentField's canvas already treats as active — this is
 * the foreground counterpart to that background signal, never a second
 * source of truth. No LLM calls, nothing invented: the price shown is
 * the exact same NegotiationMessageDTO.unitPrice the eventual compact
 * RoundRow for this turn will also show.
 */
function LiveActivity({
  thinking,
  transcript,
}: {
  thinking: { agent: "buyer" | "merchant"; label: string } | null;
  transcript: TranscriptTurn[];
}) {
  if (!thinking) return null;
  const toneClass = thinking.agent === "buyer" ? "text-blue-300" : "text-yellow-300";
  const dotClass = thinking.agent === "buyer" ? "bg-blue-400" : "bg-yellow-400";
  const agentName = thinking.agent === "buyer" ? "Buyer Agent" : "Merchant Agent";

  const lastEntry = transcript[transcript.length - 1];

  // Buyer just moved this round, merchant now deciding.
  const buyerJustMoved =
    thinking.agent === "merchant" && lastEntry && lastEntry.buyer && !lastEntry.merchant ? lastEntry.buyer : null;

  // Negotiation 3.0, Part 3 Stage D — the symmetric case: the previous
  // round fully resolved (merchant's real counter already known) and
  // it's now the buyer's turn for the NEXT round. Same real handoff
  // signal, the other direction. Never fires for round 1 (no previous
  // round exists yet — that's the activation moment below instead).
  const merchantJustMoved =
    thinking.agent === "buyer" && lastEntry && lastEntry.buyer && lastEntry.merchant ? lastEntry.merchant : null;

  const handoff = buyerJustMoved
    ? { from: "Buyer Agent", fromTone: "text-blue-300", to: "Merchant Agent", message: buyerJustMoved }
    : merchantJustMoved
      ? { from: "Merchant Agent", fromTone: "text-yellow-300", to: "Buyer Agent", message: merchantJustMoved }
      : null;

  // Negotiation 3.0, Part 14 — the very first activation, nothing has
  // happened yet at all. A one-time real-state entrance line, not a
  // fake delay: it plays out during the EXISTING reveal pacing
  // (REVEAL_DELAY_MS) that already elapses before round 1's buyer move
  // is pushed onto the transcript — no new timer added anywhere.
  const isActivating = thinking.agent === "buyer" && transcript.length === 0;

  return (
    <div className="flex flex-col gap-3">
      {isActivating && (
        <p className="animate-fade-in text-sm text-muted">Requirements confirmed · Buyer Agent activated</p>
      )}
      {handoff && (
        <p className="text-sm">
          <span className={`font-medium ${handoff.fromTone}`}>{handoff.from}</span>{" "}
          <span className="text-muted">{negotiationMessageTypeLabel(handoff.message.type).toLowerCase()} at</span>{" "}
          <span className="tabular-nums font-semibold text-foreground">
            {handoff.message.unitPrice != null ? formatInr(handoff.message.unitPrice) : "—"}
          </span>{" "}
          <span className="text-muted" aria-hidden>
            →
          </span>{" "}
          <span className="text-muted">sending to {handoff.to}</span>
        </p>
      )}
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass} animate-agent-glow`} aria-hidden />
        <span className={`text-sm font-semibold ${toneClass}`}>{agentName}</span>
        <AgentStatusStepper key={`${thinking.agent}-${transcript.length}`} agent={thinking.agent} />
      </div>
    </div>
  );
}

/**
 * The negotiation's current "state slot" — exactly one of: the AGREED
 * resolution, the REJECTED/EXPIRED conclusion, the live turn-in-progress
 * event, or (before anything has happened at all) a quiet idle line.
 * Owns the divider/spacing that visually separates it from the chart
 * above and the round history below; each of its own children render
 * bare content only (Redesign 2.0, section 10 — one divider here, not a
 * nested box per state).
 */
function FieldStateSlot({
  transcript,
  thinking,
  isTerminal,
  status,
  agreement,
  lastTurn,
  round,
  maxRounds,
  productName,
  buyerMaxPrice,
  merchantFinalPrice,
  onStartOver,
}: {
  transcript: TranscriptTurn[];
  thinking: { agent: "buyer" | "merchant"; label: string } | null;
  isTerminal: boolean;
  status: NegotiationStatus | null;
  agreement: PersistedAgreementDTO | null;
  lastTurn: TranscriptTurn | undefined;
  round: number;
  maxRounds: number | null;
  productName: string | null;
  buyerMaxPrice: number | null;
  merchantFinalPrice: number | null;
  onStartOver: () => void;
}) {
  let content: ReactNode = null;
  if (isTerminal && status === "AGREED" && agreement) {
    content = <AgreementFocal agreement={agreement} productName={productName} onStartOver={onStartOver} />;
  } else if (isTerminal && status) {
    content = (
      <NoDealFocal
        status={status}
        lastTurn={lastTurn}
        round={round}
        maxRounds={maxRounds}
        buyerMaxPrice={buyerMaxPrice}
        merchantFinalPrice={merchantFinalPrice}
      />
    );
  } else if (thinking) {
    content = <LiveActivity thinking={thinking} transcript={transcript} />;
  } else if (transcript.length === 0) {
    content = <p className="text-sm text-muted">Waiting for the opening move…</p>;
  }

  if (!content) return null;
  return <div className="border-t border-border pt-5">{content}</div>;
}

/**
 * The negotiation channel round history — one compact row per completed
 * round (round number, both sides' real prices, the strategic move, and
 * a "Decision trace ↗" affordance). Only FULLY resolved rounds appear
 * here (both buyer and merchant known) — a round still in flight is
 * represented solely by LiveActivity above, never duplicated here with
 * a half-empty row. The most recently completed round renders with the
 * fuller "agent message" treatment (RoundRow's own `isLatest`) for as
 * long as its real reason is still typewriter-revealing, then collapses
 * to the same compact format as the rest.
 */
function RoundRows({
  transcript,
  onOpenTrace,
  reducedMotion,
}: {
  transcript: TranscriptTurn[];
  onOpenTrace: (turn: number) => void;
  reducedMotion: boolean;
}) {
  const complete = transcript.filter((t) => t.buyer && t.merchant);
  if (complete.length === 0) return null;

  return (
    <div className="flex flex-col border-t border-border pt-2">
      {complete.map((turn, i) => (
        <RoundRow
          key={turn.turn}
          turn={turn}
          previousTurn={i > 0 ? complete[i - 1] : null}
          onOpenTrace={onOpenTrace}
          reducedMotion={reducedMotion}
          isLatest={i === complete.length - 1}
        />
      ))}
    </div>
  );
}

/**
 * Correction pass, section 3: a restrained one-line decision summary for
 * the round row — NOT a second source of truth. Returns the exact same
 * first real reason string AgentDecisionSide's own "Reason" section
 * already surfaces (sufficiency.reason, else the first deterministic
 * reason, else the first strategic reason) — every one of them a
 * deterministic, engine-generated string (buyerRules.ts /
 * negotiationStrategy.ts / candidateMove.ts), never invented here, never
 * an LLM call. Returns null when the record genuinely carries no reason
 * text to show — the row then simply stays compact rather than showing
 * an empty or fabricated line.
 */
function oneLineDecisionReason(record: AgentDecisionRecord | null): string | null {
  if (!record) return null;
  return record.sufficiency?.reason ?? record.deterministicReasons[0] ?? record.strategicReasons[0] ?? null;
}

/** Compact "· 7u · 12d" suffix for one side's real quantity/delivery — omitted entirely when neither is present, never a placeholder. */
function RoundRowTerms({ quantity, deliveryDays }: { quantity: number | null; deliveryDays: number | null }) {
  if (quantity === null && deliveryDays === null) return null;
  return (
    <span className="ml-1 font-normal text-muted">
      {quantity !== null && `· ${quantity}u`}
      {deliveryDays !== null && ` · ${deliveryDays}d`}
    </span>
  );
}

function RoundRow({
  turn,
  previousTurn,
  onOpenTrace,
  reducedMotion,
  isLatest,
}: {
  turn: TranscriptTurn;
  previousTurn: TranscriptTurn | null;
  onOpenTrace: (turn: number) => void;
  reducedMotion: boolean;
  isLatest: boolean;
}) {
  const buyerPrice = turn.buyer?.unitPrice ?? null;
  const merchantPrice = turn.merchant?.unitPrice ?? null;
  const move = turn.merchant?.move ?? turn.buyer?.move ?? null;
  // Pass 11 addendum: a structural walk-away's own closing round has no
  // decisionAudit (see orchestrator.ts's buildWalkAwayTurn — neither
  // agent ran a fresh decision that round) but DOES have real, already-
  // phrased closing messages worth opening the trace for (see
  // DecisionTracePanel's isUnexplainedClose / WalkAwayDecisionSide) —
  // without this, that round's "Decision trace" button would never
  // appear at all, making that real content unreachable.
  const hasTrace = turn.decisionAudit != null || (turn.buyer?.unitPrice == null && turn.merchant?.unitPrice == null);
  // Redesign 2.0.1 (D2): only ever non-null for a genuine trade round
  // with real before/after data to show — see describeTradeAnnotation's
  // own doc comment.
  const tradeAnnotation = turn.buyer
    ? describeTradeAnnotation(
        move ?? undefined,
        previousTurn?.buyer
          ? { quantity: previousTurn.buyer.quantity, deliveryDays: previousTurn.buyer.deliveryDays }
          : null,
        { quantity: turn.buyer.quantity, deliveryDays: turn.buyer.deliveryDays },
      )
    : null;

  // Same priority the move badge above already uses (merchant's move
  // wins when both exist) — the merchant's counter is typically the
  // more strategically-rich half of a round, so its reason is preferred
  // here too, for the one side actually shown per row.
  const primarySide: "buyer" | "merchant" = turn.decisionAudit?.merchant ? "merchant" : "buyer";
  const primaryRecord = (primarySide === "merchant" ? turn.decisionAudit?.merchant : turn.decisionAudit?.buyer) ?? null;
  const reason = oneLineDecisionReason(primaryRecord);
  // The label ("Buyer Agent ·") appears immediately, same as a chat
  // message's sender — only the sentence itself reveals progressively,
  // exactly the real `reason` string above, never a re-typed/altered
  // copy of it.
  const revealedReason = useTypewriterReveal(reason, reducedMotion);
  const primaryPrice = primarySide === "buyer" ? buyerPrice : merchantPrice;
  const primaryToneClass = primarySide === "buyer" ? "text-blue-300" : "text-yellow-300";
  const primaryBorderColor = primarySide === "buyer" ? "#60a5fa" : "#facc15";

  // Redesign 2.0, section 4: the most recently completed round gets a
  // fuller "agent message" treatment (ChatGPT-adjacent, not a ChatGPT
  // clone — a compact bordered message, not an open-ended chat log)
  // for exactly as long as its real reason is still typewriter-
  // revealing. The instant it finishes (or a newer round supersedes
  // it), the very next render already falls through to the same
  // compact row every other round uses — no extra state needed.
  const expanded = isLatest && reason !== null && !revealedReason.complete;

  if (expanded) {
    return (
      <div
        className="animate-fade-in flex flex-col gap-2 border-l-2 py-2 pl-4 text-sm"
        style={{ borderColor: primaryBorderColor }}
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="w-7 shrink-0 tabular-nums text-[11px] text-muted">R{turn.turn}</span>
          <span className={`text-xs font-semibold tracking-wide uppercase ${primaryToneClass}`}>
            {primarySide === "buyer" ? "Buyer Agent" : "Merchant Agent"}
          </span>
          {move && (
            <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${negotiationMoveBadgeClass(move)}`}>
              {negotiationMoveLabel(move)}
            </span>
          )}
        </div>
        <p className="tabular-nums text-lg font-semibold text-foreground">
          {primaryPrice !== null ? formatInr(primaryPrice) : "—"}
          <RoundRowTerms
            quantity={primarySide === "buyer" ? (turn.buyer?.quantity ?? null) : (turn.merchant?.quantity ?? null)}
            deliveryDays={primarySide === "buyer" ? (turn.buyer?.deliveryDays ?? null) : (turn.merchant?.deliveryDays ?? null)}
          />
        </p>
        {tradeAnnotation && (
          <p className="text-xs font-medium text-accent">{tradeAnnotation}</p>
        )}
        <p className="leading-6 text-muted">
          {revealedReason.text}
          <span className="ml-0.5 inline-block h-3.5 w-[2px] -mb-0.5 animate-pulse bg-muted align-middle" aria-hidden />
        </p>
        {hasTrace && (
          <button
            type="button"
            onClick={() => onOpenTrace(turn.turn)}
            className="flex w-fit shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground"
          >
            Decision trace <span aria-hidden>↗</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 border-b border-border px-1.5 py-2.5 text-sm last:border-0">
      <div className="flex flex-wrap items-center gap-2.5 sm:gap-3.5">
        <span className="w-7 shrink-0 tabular-nums text-[11px] text-muted">R{turn.turn}</span>
        <span className="tabular-nums font-medium text-blue-300">
          {buyerPrice !== null ? formatInr(buyerPrice) : "—"}
          <RoundRowTerms quantity={turn.buyer?.quantity ?? null} deliveryDays={turn.buyer?.deliveryDays ?? null} />
        </span>
        <span className="text-muted" aria-hidden>
          →
        </span>
        <span className="tabular-nums font-medium text-yellow-300">
          {merchantPrice !== null ? formatInr(merchantPrice) : "…"}
          <RoundRowTerms quantity={turn.merchant?.quantity ?? null} deliveryDays={turn.merchant?.deliveryDays ?? null} />
        </span>
        {move && (
          <span className={`hidden rounded px-2 py-0.5 text-[11px] font-medium sm:inline ${negotiationMoveBadgeClass(move)}`}>
            {negotiationMoveLabel(move)}
          </span>
        )}
        {hasTrace && (
          <button
            type="button"
            onClick={() => onOpenTrace(turn.turn)}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground"
          >
            <span className="hidden sm:inline">Decision trace</span>
            <span aria-hidden>↗</span>
          </button>
        )}
      </div>

      {/*
        Redesign 2.0.1 (D2): a concrete "what changed, and why" line for
        a genuine trade round — never a bare badge alone. Only ever
        rendered when describeTradeAnnotation found a real before/after
        difference (see its own doc comment); an ordinary HOLD/CONCEDE
        round renders nothing here.
      */}
      {tradeAnnotation && <p className="pl-9 text-xs font-medium text-accent">{tradeAnnotation}</p>}

      {reason && (
        <p className="truncate pl-9 text-xs text-muted">
          <span className={primarySide === "buyer" ? "font-medium text-blue-300" : "font-medium text-yellow-300"}>
            {primarySide === "buyer" ? "Buyer Agent" : "Merchant Agent"}
          </span>
          <span className="mx-1.5">·</span>
          {revealedReason.text}
        </p>
      )}
    </div>
  );
}

const PROGRESSION_STAGES = ["Observing", "Evaluating", "Deciding", "Acting", "Agreed"] as const;

/**
 * The workspace-level state progression rail: OBSERVING → EVALUATING →
 * DECIDING → ACTING → AGREED. The first four pulse together (agent-
 * agnostic — either side may be mid-turn) exactly while a turn is being
 * paced onto the screen; the final "Agreed" stage lights up solid, once,
 * only when the negotiation's real persisted status is AGREED — never
 * before, and never for REJECTED/EXPIRED (no false "agreed" claim on a
 * failed negotiation). Purely a presentational reframing of state this
 * component already holds (`thinking`/`status`) — never a second source
 * of truth for negotiation state.
 */
function StateProgression({ active, agreed }: { active: boolean; agreed: boolean }) {
  return (
    <div className="flex items-start" aria-hidden>
      {PROGRESSION_STAGES.map((stage, i) => {
        const isLast = i === PROGRESSION_STAGES.length - 1;
        const lit = isLast ? agreed : active;
        const dotToneClass = isLast ? "bg-emerald-400" : "bg-accent";
        const textToneClass = isLast ? "text-emerald-300" : "text-accent";
        return (
          <div key={stage} className={`flex items-start ${isLast ? "" : "flex-1"}`}>
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={`h-2 w-2 rounded-full transition-all duration-300 ${lit ? dotToneClass : "bg-white/15"} ${
                  active && !isLast ? "animate-dot-halo text-accent" : ""
                }`}
              />
              <span
                className={`hidden text-[10px] font-medium tracking-wide uppercase transition-colors duration-300 whitespace-nowrap sm:inline ${
                  lit ? textToneClass : "text-muted/50"
                }`}
              >
                {stage}
              </span>
            </div>
            {!isLast && (
              <span
                className={`mt-[3px] h-px flex-1 transition-colors duration-500 ${active ? "bg-accent/40" : "bg-border"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Cycles the four agent-loop phase labels while a turn is being computed/paced onto the screen — purely presentational motion over the same real delay window this component already used before the redesign. Never a claim about literal sub-turn backend phases. */
function AgentStatusStepper({ agent }: { agent: "buyer" | "merchant" }) {
  const steps = ["Observing", "Evaluating", "Deciding", "Acting"];
  const toneClass = agent === "buyer" ? "text-blue-300" : "text-yellow-300";
  return (
    <div className="flex items-center gap-2.5 text-xs font-medium">
      {steps.map((step, i) => (
        <span
          key={step}
          className={toneClass}
          style={{
            opacity: 0.35,
            animation: "pact-step 1.6s ease-in-out infinite",
            animationDelay: `${i * 0.3}s`,
          }}
        >
          {step}
        </span>
      ))}
    </div>
  );
}

function DecisionField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <div className="leading-5 text-zinc-200">{children}</div>
    </div>
  );
}

/**
 * What this side observed before deciding — see AgentObservation
 * (agentDecision.ts). Every line is a direct, unmodified echo of a real
 * input the agent already received; nothing recomputed, nothing
 * invented.
 */
function buildObservedLines(observation: AgentObservation): string[] {
  const lines: string[] = [];
  if (observation.previousMerchantOffer?.unitPrice != null) {
    lines.push(`Merchant offer: ${formatInr(observation.previousMerchantOffer.unitPrice)}`);
  }
  if (observation.buyerRequirement.quantity) {
    lines.push(`Quantity: ${observation.buyerRequirement.quantity}`);
  }
  if (observation.buyerRequirement.deliveryDeadlineDays !== undefined) {
    lines.push(`Delivery deadline: ${observation.buyerRequirement.deliveryDeadlineDays} day(s)`);
  }
  if (observation.round !== undefined) {
    lines.push(`Round: ${observation.round} / ${observation.maxRounds}`);
  }
  if (observation.leverage?.buyer !== undefined) {
    lines.push(
      `Leverage: ${observation.leverage.buyer}%${
        observation.leverage.merchant !== undefined ? ` buyer / ${observation.leverage.merchant}% merchant` : ""
      }`,
    );
  }
  return lines.length > 0 ? lines : ["Its own opening requirement — no prior offer to react to yet."];
}

/**
 * Exported so AuditTrailPanel.tsx can reuse this exact rendering for a
 * NEGOTIATION_DECISION AuditLog entry, instead of duplicating it — same
 * component, same props, whether the record came from a live turn
 * response or a persisted audit row. Structured as OBSERVED / EVALUATED
 * / SELECTED / REASON — the same fields AgentDecisionRecord already
 * carries, never chain-of-thought or LLM reasoning.
 */
export function AgentDecisionSide({
  label,
  tone,
  record,
}: {
  label: string;
  tone: "blue" | "amber";
  record: AgentDecisionRecord | null;
}) {
  const toneClass = tone === "blue" ? "text-blue-300" : "text-yellow-300";

  if (!record) {
    return (
      <div className="flex flex-col gap-1">
        <span className={`text-[11px] font-semibold tracking-wide uppercase ${toneClass}`}>{label}</span>
        <p className="text-muted">No fresh decision this round.</p>
      </div>
    );
  }

  const { terms } = record;
  const hasTerms = terms.quantity !== null || terms.unitPrice !== null || terms.deliveryDays !== null;
  const reasons = [...record.deterministicReasons, ...record.strategicReasons];
  const observedLines = buildObservedLines(record.observation);

  return (
    <div className="flex flex-col gap-3">
      <span className={`text-[11px] font-semibold tracking-wide uppercase ${toneClass}`}>{label}</span>

      <DecisionField label="Observed">
        <ul className="flex flex-col gap-0.5">
          {observedLines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </DecisionField>

      {record.candidates && record.candidates.length > 0 && (
        <DecisionField label="Evaluated">
          <ul className="flex flex-col gap-0.5">
            {record.candidates.map((candidate, i) => {
              const selected = candidate.move === record.move;
              return (
                <li key={i} className={selected ? `font-medium ${toneClass}` : "text-muted"}>
                  {selected ? "✓" : "–"} {negotiationMoveLabel(candidate.move)} · {formatInr(candidate.unitPrice)}
                </li>
              );
            })}
          </ul>
        </DecisionField>
      )}

      <DecisionField label="Selected">
        <span className={record.move ? `font-medium ${toneClass}` : ""}>
          {record.move ? negotiationMoveLabel(record.move) : "—"}
        </span>
        {hasTerms && (
          <span className="text-muted">
            {" "}
            · {terms.quantity ?? "—"} unit(s) · {terms.unitPrice !== null ? formatInr(terms.unitPrice) : "—"} ·{" "}
            {terms.deliveryDays !== null ? `${terms.deliveryDays}d` : "—"}
          </span>
        )}
      </DecisionField>

      {(record.sufficiency || reasons.length > 0) && (
        <DecisionField label="Reason">
          <ul className="flex flex-col gap-0.5">
            {record.sufficiency && <li>{record.sufficiency.reason}</li>}
            {reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </DecisionField>
      )}
    </div>
  );
}

/**
 * The Decision Trace inspector — replaces the old inline "Why this
 * move?" <details> disclosure with a proper contextual panel, opened
 * per round from RoundRow. Reuses AgentDecisionSide's exact real-data
 * rendering for both sides, unchanged, plus one new RESULT section: a
 * plain diff of this round's resulting prices against the previous
 * round's — computed only from adjacent real transcript entries already
 * in state, never invented.
 */
function DecisionTracePanel({
  turn,
  previousTurn,
  productLabel,
  buyerMaxPrice,
  onClose,
}: {
  turn: TranscriptTurn;
  previousTurn: TranscriptTurn | null;
  productLabel: string;
  buyerMaxPrice: number | null;
  onClose: () => void;
}) {
  // Redesign 2.0.1 (D4): the SAME move value RoundRow's own badge
  // already shows for this round — surfaced once, prominently, at the
  // top of the trace rather than only buried inside one side's
  // "Selected" line, so opening the trace immediately confirms what
  // kind of round this was.
  const move = turn.merchant?.move ?? turn.buyer?.move ?? null;

  // Pass 11 addendum: a structural walk-away closing turn (e.g. an
  // unbridgeable price gap) has null prices of its own and no fresh
  // per-side decision record — neither agent ran a counter-offer
  // computation that round, it closed BEFORE one would have (see
  // orchestrator.ts's buildWalkAwayTurn, which correctly leaves
  // buyerDecision/merchantDecision undefined for this exact case rather
  // than fabricating one). What IS real for this turn: the agents' own
  // already-phrased, integrity-checked closing messages. Shown plainly
  // instead of a fake "No fresh decision this round" for both sides.
  const isUnexplainedClose = turn.buyer?.unitPrice == null && turn.merchant?.unitPrice == null && !turn.decisionAudit;

  return (
    <InspectorPanel eyebrow={`Round ${turn.turn} · ${productLabel}`} title="Decision trace" onClose={onClose}>
      {move && (
        <span className={`w-fit rounded px-2.5 py-1 text-xs font-medium ${negotiationMoveBadgeClass(move)}`}>
          {negotiationMoveLabel(move)}
        </span>
      )}
      {isUnexplainedClose ? (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <WalkAwayDecisionSide
            label="Buyer"
            tone="blue"
            message={turn.buyer?.message ?? null}
            observation={previousTurn?.decisionAudit?.buyer?.observation ?? null}
            buyerMaxPrice={buyerMaxPrice}
            merchantFinalPrice={previousTurn?.merchant?.unitPrice ?? null}
          />
          <WalkAwayDecisionSide
            label="Merchant"
            tone="amber"
            message={turn.merchant?.message ?? null}
            observation={null}
            buyerMaxPrice={buyerMaxPrice}
            merchantFinalPrice={previousTurn?.merchant?.unitPrice ?? null}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <AgentDecisionSide label="Buyer" tone="blue" record={turn.decisionAudit?.buyer ?? null} />
          <AgentDecisionSide label="Merchant" tone="amber" record={turn.decisionAudit?.merchant ?? null} />
        </div>
      )}
      <ResultDiff current={turn} previous={previousTurn} buyerMaxPrice={buyerMaxPrice} />
    </InspectorPanel>
  );
}

/**
 * A structural walk-away's closing turn has no fresh per-round
 * AgentDecisionRecord (see isUnexplainedClose above) — this renders the
 * same OBSERVED / EVALUATED / SELECTED / REASON hierarchy AgentDecisionSide
 * uses, but sourced only from data that's genuinely real and already
 * available: `observation` is the PRECEDING round's own already-computed
 * buyer observation (the requirement that round was negotiating against
 * — unchanged since, this being the very next turn), buyerMaxPrice/
 * merchantFinalPrice are the same two safe, non-floor numbers
 * NoDealFocal's summary card and ResultDiff's RESULT section already
 * show, and `message` is the agent's own real, integrity-checked closing
 * text. "Walk away" is a plain factual label for what status/type
 * already say happened this turn — never written into a CandidateMoveType
 * value, since that type has no such member and this pass does not
 * modify src/lib/rules/candidateMove.ts to add one.
 */
function WalkAwayDecisionSide({
  label,
  tone,
  message,
  observation,
  buyerMaxPrice,
  merchantFinalPrice,
}: {
  label: string;
  tone: "blue" | "amber";
  message: string | null;
  observation: AgentObservation | null;
  buyerMaxPrice: number | null;
  merchantFinalPrice: number | null;
}) {
  const toneClass = tone === "blue" ? "text-blue-300" : "text-yellow-300";
  const gap = negotiationPriceGap(buyerMaxPrice ?? undefined, merchantFinalPrice ?? undefined);

  return (
    <div className="flex flex-col gap-3">
      <span className={`text-[11px] font-semibold tracking-wide uppercase ${toneClass}`}>{label}</span>

      {observation && (
        <DecisionField label="Observed">
          <ul className="flex flex-col gap-0.5">
            {observation.buyerRequirement.quantity != null && <li>Quantity: {observation.buyerRequirement.quantity}</li>}
            {observation.buyerRequirement.deliveryDeadlineDays !== undefined && (
              <li>Delivery deadline: {observation.buyerRequirement.deliveryDeadlineDays} day(s)</li>
            )}
            {buyerMaxPrice != null && <li>Maximum budget: {formatInr(buyerMaxPrice)}</li>}
            {observation.round !== undefined && (
              <li>
                Round: {observation.round} / {observation.maxRounds ?? "—"}
              </li>
            )}
          </ul>
        </DecisionField>
      )}

      {gap !== null && merchantFinalPrice != null && (
        <DecisionField label="Evaluated">
          <ul className="flex flex-col gap-0.5">
            <li>Merchant offer: {formatInr(merchantFinalPrice)}</li>
            <li>Above buyer maximum by: {formatInr(gap)}</li>
            <li>No acceptable remaining trade available</li>
          </ul>
        </DecisionField>
      )}

      <DecisionField label="Selected">
        <span className={`font-medium ${toneClass}`}>Walk away</span>
      </DecisionField>

      <DecisionField label="Reason">
        <p>{message ?? "No closing message recorded."}</p>
      </DecisionField>
    </div>
  );
}

function ResultDiff({
  current,
  previous,
  buyerMaxPrice,
}: {
  current: TranscriptTurn;
  previous: TranscriptTurn | null;
  buyerMaxPrice: number | null;
}) {
  const rows: { label: string; text: string }[] = [];

  // Pass 11 addendum: a structural walk-away's own closing turn has null
  // prices of its own (see isUnexplainedClose in DecisionTracePanel) —
  // there is nothing for the normal per-round diff below to compare.
  // What IS real and known: the buyer's own stated maximum, and the
  // PREVIOUS round's real merchant offer (the actual number that
  // triggered the walk-away) — the exact same pair NoDealFocal's summary
  // card already shows, computed the same safe way (negotiationPriceGap
  // never touches the merchant's private floor).
  if (current.buyer?.unitPrice == null && current.merchant?.unitPrice == null && previous?.merchant?.unitPrice != null) {
    const gap = negotiationPriceGap(buyerMaxPrice ?? undefined, previous.merchant.unitPrice);
    if (gap !== null && buyerMaxPrice != null) {
      return (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 text-xs">
          <p className="text-[10px] font-semibold tracking-widest text-muted uppercase">Result</p>
          <ul className="flex flex-col gap-1 text-foreground">
            <li>Negotiation ended — no agreement</li>
            <li>
              <span className="text-muted">Buyer maximum:</span>{" "}
              <span className="tabular-nums">{formatInr(buyerMaxPrice)}</span>
            </li>
            <li>
              <span className="text-muted">Merchant final offer:</span>{" "}
              <span className="tabular-nums">{formatInr(previous.merchant.unitPrice)}</span>
            </li>
            <li>
              <span className="text-muted">Unresolved gap:</span>{" "}
              <span className="tabular-nums">{formatInr(gap)}/unit</span>
            </li>
          </ul>
        </div>
      );
    }
  }

  // Redesign 2.0.1 (D4): the gap itself, narrowed/widened/unchanged —
  // the same real Math.abs(merchant-buyer) comparison the chart (D1)
  // now annotates per round, framed here as the round's own headline
  // result rather than two separate per-side price lines alone.
  if (
    previous?.buyer?.unitPrice != null &&
    previous?.merchant?.unitPrice != null &&
    current.buyer?.unitPrice != null &&
    current.merchant?.unitPrice != null
  ) {
    const previousGap = Math.abs(previous.merchant.unitPrice - previous.buyer.unitPrice);
    const currentGap = Math.abs(current.merchant.unitPrice - current.buyer.unitPrice);
    if (previousGap !== currentGap) {
      rows.push({
        label: currentGap < previousGap ? "Gap narrowed" : "Gap widened",
        text: `${formatInr(previousGap)} → ${formatInr(currentGap)}`,
      });
    } else {
      rows.push({ label: "Gap unchanged", text: formatInr(currentGap) });
    }
  }

  if (previous?.buyer?.unitPrice != null && current.buyer?.unitPrice != null && previous.buyer.unitPrice !== current.buyer.unitPrice) {
    const delta = current.buyer.unitPrice - previous.buyer.unitPrice;
    rows.push({
      label: "Buyer price",
      text: `${formatInr(previous.buyer.unitPrice)} → ${formatInr(current.buyer.unitPrice)} (${delta > 0 ? "+" : "−"}${formatInr(Math.abs(delta))})`,
    });
  }
  if (
    previous?.merchant?.unitPrice != null &&
    current.merchant?.unitPrice != null &&
    previous.merchant.unitPrice !== current.merchant.unitPrice
  ) {
    const delta = current.merchant.unitPrice - previous.merchant.unitPrice;
    rows.push({
      label: "Merchant price",
      text: `${formatInr(previous.merchant.unitPrice)} → ${formatInr(current.merchant.unitPrice)} (${delta > 0 ? "+" : "−"}${formatInr(Math.abs(delta))})`,
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 text-xs">
      <p className="text-[10px] font-semibold tracking-widest text-muted uppercase">Result</p>
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-1 text-foreground">
          {rows.map((r) => (
            <li key={r.label}>
              <span className="text-muted">{r.label}:</span> <span className="tabular-nums">{r.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">
          {previous ? "No price change from the previous round." : "Opening round — no prior round to compare."}
        </p>
      )}
    </div>
  );
}

function FocalStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="tabular-nums text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

/**
 * The AGREED moment's focal content — the agreement's real terms become
 * the visual center, not a footnote. Redesign 2.0, section 8: this is
 * the payoff of the whole negotiation, so it renders as the field's own
 * resolution (embedded in FieldStateSlot, no separate card of its own)
 * right where the live turn activity used to be — the two trajectories
 * above it have already visibly converged (ConvergenceChart's own
 * `converged` ring). Same fields the old OutcomeCard/AgreementFocal card
 * already rendered.
 */
function AgreementFocal({
  agreement,
  productName,
  onStartOver,
}: {
  agreement: PersistedAgreementDTO;
  productName: string | null;
  onStartOver: () => void;
}) {
  const [showPayment, setShowPayment] = useState(false);

  // Deliberately NOT animate-fade-in on this wrapper — see the workspace
  // section's own comment: PaymentPanel (a child once "Proceed to
  // payment" is clicked) renders its own `fixed inset-0` checkout
  // backdrop, which a transform-bearing ancestor here would trap
  // off-viewport the exact same way. The AGREED moment still gets real
  // motion via animate-resolve below (a box-shadow pulse — not a
  // transform, so it doesn't create this containing-block trap).
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-widest text-accent uppercase">Agreement reached</p>
        <h3 className="text-display-3 font-semibold text-foreground">{productName ?? agreement.sku}</h3>
      </div>

      <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
        <FocalStat label="Quantity" value={`${agreement.quantity} units`} />
        <FocalStat label="Unit price" value={formatInr(agreement.unitPrice)} />
        <FocalStat label="Delivery" value={`${agreement.deliveryDays} day(s)`} />
        <div className="animate-resolve ml-auto rounded-2xl">
          <p className="text-xs text-muted">Total</p>
          <p className="text-display-2 font-semibold text-accent">{formatInr(agreement.totalAmount)}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-xs text-muted">
        <span>
          Agreement ID: <span className="font-mono">{agreement.id}</span>
        </span>
        {/* Both true the instant this card can render: the turn API
            route persists the Agreement and its AuditLog row in the
            same transaction (agreementRepository.ts) before ever
            returning — never a claim ahead of what's actually
            committed. */}
        <span className="flex items-center gap-3 text-emerald-300/80">
          <span>Agreement persisted ✓</span>
          <span>Audit trail persisted ✓</span>
        </span>
      </div>

      {showPayment ? (
        <PaymentPanel
          agreementId={agreement.id}
          productName={productName ?? agreement.sku}
          quantity={agreement.quantity}
          unitPrice={agreement.unitPrice}
          totalAmount={agreement.totalAmount}
          onStartOver={onStartOver}
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowPayment(true)}
          className="flex h-12 w-fit items-center justify-center rounded-full bg-accent px-7 text-base font-medium text-accent-foreground transition-colors hover:brightness-110"
        >
          Proceed to payment
        </button>
      )}
    </div>
  );
}

/**
 * REJECTED/EXPIRED terminal conclusion — Redesign 2.0, section 9: framed
 * as a deliberate conclusion (embedded in FieldStateSlot, same as
 * AgreementFocal), not an error card.
 *
 * Pass 11 addendum: when the failure has a genuine, explainable price
 * gap (the buyer's own stated maximum vs. the merchant's own already-
 * public final offer — negotiationPriceGap), that real gap is shown as
 * three plain stat rows (same FocalStat AgreementFocal already uses)
 * and negotiationFailureExplanation's more specific copy is used.
 * Neither number nor the explanation ever touches the merchant's
 * private floor — buyerMaxPrice is the buyer's OWN requirement, and
 * merchantFinalPrice is a price the merchant already stated out loud in
 * the transcript. When there's no clean price-gap story (a REJECTED
 * negotiation, or a round-exhaustion with no offers to compare), this
 * falls back to exactly the prior generic explanation — never invents
 * a gap that isn't genuinely there.
 */
function NoDealFocal({
  status,
  lastTurn,
  round,
  maxRounds,
  buyerMaxPrice,
  merchantFinalPrice,
}: {
  status: NegotiationStatus;
  lastTurn: TranscriptTurn | undefined;
  round: number;
  maxRounds: number | null;
  buyerMaxPrice: number | null;
  /**
   * The merchant's last real numeric offer — deliberately NOT derived
   * from `lastTurn` here: a structural walk-away's own closing turn (see
   * DecisionTracePanel's isUnexplainedClose) has unitPrice: null on
   * BOTH sides (see orchestrator.ts's buildWalkAwayTurn/walkAwayMessage),
   * so reading it off `lastTurn` directly would silently show no gap at
   * all for exactly the case this addendum is about. The caller passes
   * the last transcript entry that actually HAS real prices instead.
   */
  merchantFinalPrice: number | null;
}) {
  const gap = negotiationPriceGap(buyerMaxPrice ?? undefined, merchantFinalPrice ?? undefined);
  const explanation =
    status === "REJECTED" || status === "EXPIRED"
      ? negotiationFailureExplanation(status, round, maxRounds ?? undefined, buyerMaxPrice ?? undefined, merchantFinalPrice ?? undefined)
      : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-widest text-red-300 uppercase">Negotiation ended</p>
        <h3 className="text-display-3 font-semibold text-foreground">{negotiationStatusLabel(status)}</h3>
      </div>

      {gap !== null && buyerMaxPrice != null && merchantFinalPrice != null && (
        <div className="flex flex-wrap gap-6 border-y border-border py-3">
          <FocalStat label="Buyer maximum" value={`${formatInr(buyerMaxPrice)}/unit`} />
          <FocalStat label="Merchant final offer" value={`${formatInr(merchantFinalPrice)}/unit`} />
          <FocalStat label="Remaining gap" value={`${formatInr(gap)}/unit`} />
        </div>
      )}

      {explanation && <p className="text-sm text-muted">{explanation}</p>}
      {gap === null && (
        <p className="text-sm text-muted">{lastTurn?.merchant?.message ?? "The negotiation ended without an agreement."}</p>
      )}
    </div>
  );
}
