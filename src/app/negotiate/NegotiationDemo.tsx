"use client";

import { useState, type FormEvent, type ReactNode } from "react";
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
// Only the pure, dependency-free mapping helper and its types are used
// client-side — parseBuyerIntent itself (which calls the LLM provider)
// stays server-only, reached via POST /api/negotiations/intent (see
// handleUnderstandRequest below), never imported directly into this
// client bundle.
import { buyerIntentToSessionRequest } from "@/lib/negotiation/buyerIntentParser";
import type { BuyerIntent, BuyerIntentParseResult } from "@/lib/negotiation/buyerIntentParser";
import { AuditTrailPanel } from "./AuditTrailPanel";
import {
  buyerThinkingLabel,
  computeMaxOrderValue,
  formatInr,
  getScenarioPresets,
  merchantThinkingLabel,
  negotiationFailureExplanation,
  negotiationMoveBadgeClass,
  negotiationMoveLabel,
  negotiationStatusLabel,
  parseBuyerRequestForm,
  type BuyerRequestFormValues,
} from "./negotiationUi";
import { PaymentPanel } from "@/app/negotiate/PaymentPanel";

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
  // both agree. Deliberately a SEPARATE state variable: OutcomeCard's own
  // `round` prop still needs the engine's round-budget value (it compares
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

  // Natural-Language Buyer Intent (Roadmap Step 1): the primary entry
  // point is free text, understood into the SAME structured request the
  // form below has always produced — see buyerIntentParser.ts. The
  // structured form itself, and everything from `formError` down to the
  // turn-polling loop above, is completely unchanged: it remains the
  // fallback/editing layer, reachable at any time via entryMode "form".
  const [entryMode, setEntryMode] = useState<"intent" | "form">("intent");
  const [intentText, setIntentText] = useState("");
  const [intentLoading, setIntentLoading] = useState(false);
  const [intentNotice, setIntentNotice] = useState<string | null>(null);
  const [parsedIntent, setParsedIntent] = useState<BuyerIntent | null>(null);

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

  // Natural-language entry point: sends free text to the new, isolated
  // /api/negotiations/intent endpoint (buyerIntentParser.ts) — never
  // decides anything itself, only understands. A successful parse shows
  // the confirmation card; anything else (missing fields, an unmatched
  // product, or unusable output) surfaces the parser's own message and
  // falls back to the structured form, pre-filled with whatever WAS
  // understood, exactly per the "never invent, surface what's missing"
  // requirement.
  async function handleUnderstandRequest() {
    setIntentNotice(null);
    setParsedIntent(null);

    if (intentText.trim().length === 0) {
      setIntentNotice("Describe what you'd like to buy first.");
      return;
    }

    setIntentLoading(true);
    try {
      const response = await fetch("/api/negotiations/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: intentText }),
      });
      const result = (await response.json()) as BuyerIntentParseResult & { error?: string };

      if (!response.ok) {
        setIntentNotice(result.error ?? "Could not process that request.");
        return;
      }

      if (result.status === "ok") {
        setParsedIntent(result.intent);
        applyUnderstoodToForm(result.intent);
      } else if (result.status === "missing_fields" || result.status === "unknown_product") {
        setIntentNotice(result.message);
        applyUnderstoodToForm(result.understood);
        setEntryMode("form");
      } else {
        setIntentNotice(result.message);
        setEntryMode("form");
      }
    } catch {
      setIntentNotice("Could not reach the request parser — please fill in the details below.");
      setEntryMode("form");
    } finally {
      setIntentLoading(false);
    }
  }

  // "Start Autonomous Negotiation" on the confirmation card — runs the
  // exact same negotiation flow as the structured form's submit, just
  // sourced from the already-understood, already-validated intent
  // instead of re-reading the form. buyerIntentToSessionRequest (the
  // same pure mapping function this milestone's tests exercise directly)
  // is also what supplies targetUnitPrice — the one field the manual
  // form path never sends.
  async function handleStartFromIntent() {
    if (!parsedIntent) return;
    await runNegotiation(buyerIntentToSessionRequest(parsedIntent));
  }

  function handleDescribeSomethingElse() {
    setParsedIntent(null);
    setIntentText("");
    setIntentNotice(null);
  }

  // Presentation-only reset (no negotiation/API call): returns to the
  // request-entry step so a finished negotiation doesn't strand the
  // user on a dead-end screen. Nothing about the just-completed
  // session's persisted data changes — its audit trail/agreement remain
  // exactly as recorded; this only clears local UI state so a NEW
  // session can start.
  function handleStartOver() {
    setStarted(false);
    setParsedIntent(null);
    setIntentText("");
    setIntentNotice(null);
    setEntryMode("intent");
  }

  const lastTurn = transcript[transcript.length - 1];
  const latestBuyerOffer = lastTurn?.buyer ?? null;
  const latestMerchantOffer = lastTurn?.merchant ?? null;
  const isTerminal = status !== null && TERMINAL_STATUSES.includes(status);
  const productLabel = selectedProduct?.name ?? form.sku;
  const productQuantity = latestMerchantOffer?.quantity ?? latestBuyerOffer?.quantity ?? null;

  return (
    <div className="flex flex-col gap-8">
      {/* Request entry — hidden once a negotiation is underway, so the
          workspace below can be the sole focus (see design brief:
          "transition into a focused negotiation workspace"). */}
      {!started && (
        <section className="animate-fade-in flex flex-col gap-5">
          {entryMode === "intent" ? (
            parsedIntent ? (
              <IntentConfirmation
                intent={parsedIntent}
                running={running}
                onStart={handleStartFromIntent}
                onEdit={() => setEntryMode("form")}
                onReset={handleDescribeSomethingElse}
              />
            ) : (
              <IntentEntry
                value={intentText}
                onChange={setIntentText}
                onSubmit={handleUnderstandRequest}
                loading={intentLoading}
                notice={intentNotice}
                disabled={running}
                onSkipToForm={() => setEntryMode("form")}
              />
            )
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
        </section>
      )}

      {started && (
        <section className="animate-fade-in flex flex-col gap-6">
          <WorkspaceHeader
            status={status}
            productLabel={productLabel}
            productQuantity={productQuantity}
            round={displayRound}
            maxRounds={maxRounds}
            buyerOffer={latestBuyerOffer}
            merchantOffer={latestMerchantOffer}
            thinking={thinking !== null}
            leverageHistory={transcript
              .filter((t): t is TranscriptTurn & { leverage: LeverageScoreDTO } => t.leverage !== null)
              .map((t) => ({ turn: t.turn, leverage: t.leverage }))}
          />

          {apiError && (
            <p className="rounded-xl border border-red-500/30 bg-red-500/[.06] px-4 py-3 text-sm text-red-300">
              {apiError}
            </p>
          )}

          <NegotiationTimeline transcript={transcript} thinking={thinking} />

          {status && isTerminal && (
            <OutcomeCard
              status={status}
              agreement={agreement}
              lastTurn={lastTurn}
              productName={selectedProduct?.name ?? null}
              round={round}
              maxRounds={maxRounds}
              onStartOver={handleStartOver}
            />
          )}

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
        </section>
      )}
    </div>
  );
}

/**
 * Natural-Language Buyer Intent (Roadmap Step 1) — the primary entry
 * point: free text in, "Understand my request" turns it into the same
 * structured request the form below has always produced (see
 * buyerIntentParser.ts). The structured form itself is untouched and
 * always one click away via "Or fill in the form manually".
 */
function IntentEntry({
  value,
  onChange,
  onSubmit,
  loading,
  notice,
  disabled,
  onSkipToForm,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
  notice: string | null;
  disabled: boolean;
  onSkipToForm: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          What are you looking to buy?
        </h1>
        <p className="text-sm leading-6 text-muted">
          Describe it in your own words. Your Buyer Agent turns this into a structured
          request, then negotiates it directly with the merchant&rsquo;s Agent.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 transition-colors focus-within:border-border-strong sm:p-5">
        <textarea
          value={value}
          disabled={disabled || loading}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          placeholder="I need 300 wireless keyboard and mouse combos for our office. I need them within 5 days. I'd like to stay around ₹1,200 each, but I can pay a little more if I can get faster delivery."
          className="resize-none bg-transparent text-base leading-7 text-foreground placeholder:text-muted/70 focus:outline-none disabled:opacity-50"
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <button
            type="button"
            disabled={disabled}
            onClick={onSkipToForm}
            className="text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Fill in the form instead
          </button>
          <button
            type="button"
            disabled={disabled || loading}
            onClick={onSubmit}
            className="flex h-11 items-center justify-center rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition-colors hover:brightness-110 disabled:opacity-50"
          >
            {loading ? "Understanding…" : "Understand my request"}
          </button>
        </div>
      </div>

      {notice && <p className="text-sm text-red-300">{notice}</p>}
    </div>
  );
}

/**
 * "Here's what your agent understood" — the confirmation/editing layer
 * shown after a successful parse. Every value here is a direct,
 * unmodified field of the BuyerIntent the server returned (see
 * buyerIntentParser.ts); nothing is recomputed here. "Start autonomous
 * negotiation" hands this straight to the existing, unmodified
 * negotiation flow; "Edit details" reveals the structured form,
 * pre-filled with these same values.
 */
function IntentConfirmation({
  intent,
  running,
  onStart,
  onEdit,
  onReset,
}: {
  intent: BuyerIntent;
  running: boolean;
  onStart: () => void;
  onEdit: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold tracking-widest text-muted uppercase">Buyer Agent understood</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {intent.productName}
        </h1>
        <p className="mt-1 text-lg text-muted">{intent.quantity} units</p>
      </div>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
        {intent.targetPrice !== undefined && (
          <IntentField label="Target" value={`${formatInr(intent.targetPrice)} / unit`} />
        )}
        <IntentField label="Maximum" value={`${formatInr(intent.maxPrice)} / unit`} />
        <IntentField label="Delivery" value={`Within ${intent.deliveryDeadlineDays} day(s)`} />
        <IntentField label="Priority" value={intent.urgency} capitalize />
        <IntentField label="Delivery flexibility" value={intent.deliveryFlexible ? "Yes" : "No"} />
      </dl>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          disabled={running}
          onClick={onStart}
          className="flex h-12 items-center justify-center rounded-full bg-accent px-7 text-base font-medium text-accent-foreground transition-colors hover:brightness-110 disabled:opacity-50"
        >
          {running ? "Negotiating…" : "Start autonomous negotiation"}
        </button>
        <button
          type="button"
          disabled={running}
          onClick={onEdit}
          className="text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Edit details
        </button>
        <button
          type="button"
          disabled={running}
          onClick={onReset}
          className="text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Describe something else
        </button>
      </div>
    </div>
  );
}

function IntentField({ label, value, capitalize }: { label: string; value: string; capitalize?: boolean }) {
  return (
    <div className="flex flex-col gap-1 bg-background px-5 py-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`text-lg font-medium text-foreground ${capitalize ? "capitalize" : ""}`}>{value}</dd>
    </div>
  );
}

/**
 * The manual structured form — a secondary, always-available fallback
 * (see design brief: "Do not remove the manual form; it can be
 * secondary"). Every field/handler here is exactly what NegotiationDemo
 * already owned; only the presentation changed.
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
 * The focused negotiation workspace's top strip — product, live status,
 * and the current best terms both sides are converging on. Everything
 * here is a direct read of the turn-by-turn API responses already held
 * in state; nothing is computed by this component beyond simple
 * display arithmetic (the price gap).
 */
function WorkspaceHeader({
  status,
  productLabel,
  productQuantity,
  round,
  maxRounds,
  buyerOffer,
  merchantOffer,
  thinking,
  leverageHistory,
}: {
  status: NegotiationStatus | null;
  productLabel: string;
  productQuantity: number | null;
  round: number;
  maxRounds: number | null;
  buyerOffer: NegotiationMessageDTO | null;
  merchantOffer: NegotiationMessageDTO | null;
  /** Whether an agent is actively being paced onto the screen right now — drives the OBSERVING/EVALUATING/DECIDING/ACTING rail below; purely presentational, see StateProgression. */
  thinking: boolean;
  leverageHistory: { turn: number; leverage: LeverageScoreDTO }[];
}) {
  const buyerPrice = buyerOffer?.unitPrice ?? null;
  const merchantPrice = merchantOffer?.unitPrice ?? null;
  const gap = buyerPrice !== null && merchantPrice !== null ? Math.abs(merchantPrice - buyerPrice) : null;
  const isTerminal = status !== null && TERMINAL_STATUSES.includes(status);

  return (
    <div className="flex flex-col gap-6 rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-xs font-semibold tracking-widest text-muted uppercase">
          <span
            className={`h-1.5 w-1.5 rounded-full ${isTerminal ? "bg-white/30" : "animate-pulse bg-accent"}`}
            aria-hidden
          />
          {status ? negotiationStatusLabel(status) : "Negotiating"}
        </span>
        <span className="text-xs text-muted">
          Round {round} of {maxRounds ?? "—"}
        </span>
      </div>

      <StateProgression active={thinking} agreed={status === "AGREED"} />

      <div>
        <p className="text-xs text-muted">Product</p>
        <p className="text-xl font-medium tracking-tight text-foreground">
          {productQuantity !== null ? `${productQuantity} × ` : ""}
          {productLabel}
        </p>
      </div>

      <div className="flex items-center justify-center gap-3 rounded-xl bg-white/[.03] px-4 py-5 sm:gap-8">
        <PriceStat label="Buyer offer" price={buyerPrice} tone="blue" />
        <div className="flex flex-col items-center gap-1 text-muted">
          <span aria-hidden className="text-lg leading-none">
            {gap === 0 ? "✓" : "↔"}
          </span>
          <span className="text-[11px] whitespace-nowrap">
            {gap === null ? "—" : gap === 0 ? "matched" : `gap ${formatInr(gap)}`}
          </span>
        </div>
        <PriceStat label="Merchant offer" price={merchantPrice} tone="amber" />
      </div>

      {leverageHistory.length > 0 && <LeverageGraph history={leverageHistory} />}
    </div>
  );
}

/**
 * Live buyer-vs-merchant leverage visualization. Every number here comes
 * straight from the server's LeverageScoreDTO (see leverage.ts /
 * orchestrator.ts) — computed entirely from deterministic strategic
 * factors. Nothing on this graph is generated by an LLM, and nothing
 * here can influence the real negotiation.
 */
function LeverageGraph({ history }: { history: { turn: number; leverage: LeverageScoreDTO }[] }) {
  const latest = history[history.length - 1].leverage;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border px-4 py-4">
      <p className="text-[11px] font-semibold tracking-widest text-muted uppercase">Negotiation leverage</p>
      <LeverageBar label="Buyer" percent={latest.buyer} tone="blue" />
      <LeverageBar label="Merchant" percent={latest.merchant} tone="amber" />
      {latest.reasons.length > 0 && <p className="text-xs text-muted">{latest.reasons[0]}</p>}
    </div>
  );
}

function LeverageBar({ label, percent, tone }: { label: string; percent: number; tone: "blue" | "amber" }) {
  const barClass = tone === "blue" ? "bg-blue-400" : "bg-yellow-400";
  const textClass = tone === "blue" ? "text-blue-300" : "text-yellow-300";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className={`font-medium ${textClass}`}>{label}</span>
        <span className={`font-medium ${textClass}`}>{percent}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[.08]">
        <div className={`h-full rounded-full transition-all duration-500 ${barClass}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function PriceStat({ label, price, tone }: { label: string; price: number | null; tone: "blue" | "amber" }) {
  const toneClass = tone === "blue" ? "text-blue-300" : "text-yellow-300";
  return (
    <div className="text-center">
      <p className={`text-xs font-medium ${toneClass}`}>{label}</p>
      <p className="text-2xl font-semibold tracking-tight text-foreground">
        {price !== null ? formatInr(price) : "—"}
      </p>
    </div>
  );
}

/**
 * The negotiation narrative — a vertical timeline of Buyer Agent /
 * Merchant Agent turns, connected by a running line, plus the transient
 * "agent status" indicator while a turn is being paced onto the screen.
 * Deliberately NOT a chat transcript: each entry is labeled by which
 * autonomous agent acted, carries its resulting terms as the headline,
 * and offers a "Why this move?" control for the same structured
 * decision data already computed server-side (agentDecision.ts) —
 * never chain-of-thought.
 */
function NegotiationTimeline({
  transcript,
  thinking,
}: {
  transcript: TranscriptTurn[];
  thinking: { agent: "buyer" | "merchant"; label: string } | null;
}) {
  const entries: { key: string; node: ReactNode }[] = [];

  transcript.forEach((turn) => {
    entries.push({
      key: `${turn.turn}-buyer`,
      node: (
        <TimelineEntry
          side="buyer"
          roundLabel={`Round ${turn.turn}`}
          msg={turn.buyer}
          decision={turn.decisionAudit?.buyer ?? null}
        />
      ),
    });
    if (turn.merchant) {
      entries.push({
        key: `${turn.turn}-merchant`,
        node: (
          <TimelineEntry
            side="merchant"
            roundLabel={`Round ${turn.turn}`}
            msg={turn.merchant}
            decision={turn.decisionAudit?.merchant ?? null}
          />
        ),
      });
    }
  });

  return (
    <ol className="flex flex-col">
      {entries.map((entry, i) => (
        <li key={entry.key} className="flex flex-col">
          {entry.node}
          {i < entries.length - 1 && <TimelineConnector />}
        </li>
      ))}

      {thinking && (
        <li className="flex flex-col">
          {entries.length > 0 && <TimelineConnector />}
          <div className="flex items-center gap-3 py-1">
            <span
              className={`h-2 w-2 rounded-full ${thinking.agent === "buyer" ? "bg-blue-400" : "bg-yellow-400"}`}
              aria-hidden
            />
            <AgentStatusStepper key={`${thinking.agent}-${entries.length}`} agent={thinking.agent} />
          </div>
        </li>
      )}
    </ol>
  );
}

function TimelineConnector() {
  return (
    <div aria-hidden className="ml-[3px] flex h-6 flex-col items-center">
      <span className="h-full w-px bg-border-strong" />
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
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" aria-hidden>
      {PROGRESSION_STAGES.map((stage, i) => {
        const isAgreedStage = i === PROGRESSION_STAGES.length - 1;
        const lit = isAgreedStage ? agreed : active;
        return (
          <span key={stage} className="flex items-center gap-2">
            <span
              className={`text-[11px] font-medium tracking-wide uppercase transition-colors duration-300 ${
                lit ? (isAgreedStage ? "text-emerald-300" : "text-accent") : "text-muted/50"
              }`}
              style={
                active && !isAgreedStage
                  ? { animation: "pact-step 1.6s ease-in-out infinite", animationDelay: `${i * 0.3}s` }
                  : undefined
              }
            >
              {stage}
            </span>
            {!isAgreedStage && <span className="text-muted/30">→</span>}
          </span>
        );
      })}
    </div>
  );
}

/** Cycles the four agent-loop phase labels while a turn is being computed/paced onto the screen — purely presentational motion over the same real delay window this component already used before the redesign; see the design brief's "Observing / Evaluating / Deciding / Acting" requirement. Never a claim about literal sub-turn backend phases. */
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

function TimelineEntry({
  side,
  roundLabel,
  msg,
  decision,
}: {
  side: "buyer" | "merchant";
  roundLabel: string;
  msg: NegotiationMessageDTO | null;
  decision: AgentDecisionRecord | null;
}) {
  if (!msg) return null;

  const isBuyer = side === "buyer";
  const label = isBuyer ? "Buyer Agent" : "Merchant Agent";
  const toneClass = isBuyer ? "text-blue-300" : "text-yellow-300";
  const dotClass = isBuyer ? "bg-blue-400" : "bg-yellow-400";

  return (
    <div className="flex flex-col gap-2 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
        <span className={`text-xs font-semibold tracking-wide uppercase ${toneClass}`}>{label}</span>
        <span className="text-xs text-muted">{roundLabel}</span>
        {msg.move && (
          <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${negotiationMoveBadgeClass(msg.move)}`}>
            {negotiationMoveLabel(msg.move)}
          </span>
        )}
      </div>

      <div className="ml-[3px] flex flex-col gap-2 border-l border-border py-1 pl-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-2xl font-semibold tracking-tight text-foreground">
            {msg.unitPrice !== null ? formatInr(msg.unitPrice) : "—"}
          </span>
          {msg.quantity !== null && <span className="text-sm text-muted">× {msg.quantity}</span>}
          {msg.deliveryDays !== null && <span className="text-sm text-muted">· {msg.deliveryDays} day delivery</span>}
        </div>

        <p className="max-w-2xl text-sm leading-6 text-muted">{msg.message}</p>

        {decision && (
          <details className="group w-fit">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-foreground">
              Why this move?
              <span className="text-[10px] transition-transform group-open:rotate-180">⌄</span>
            </summary>
            <div className="animate-fade-in mt-2 max-w-md rounded-xl border border-border bg-surface p-4 text-xs">
              <AgentDecisionSide label={label} tone={isBuyer ? "blue" : "amber"} record={decision} />
            </div>
          </details>
        )}
      </div>
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

function OutcomeCard({
  status,
  agreement,
  lastTurn,
  productName,
  round,
  maxRounds,
  onStartOver,
}: {
  status: NegotiationStatus;
  agreement: PersistedAgreementDTO | null;
  lastTurn: TranscriptTurn | undefined;
  productName: string | null;
  /** Milestone 12.5: only used to distinguish an early walk-away EXPIRED from a round-exhaustion EXPIRED — see negotiationFailureExplanation. */
  round: number;
  maxRounds: number | null;
  onStartOver: () => void;
}) {
  const [showPayment, setShowPayment] = useState(false);

  if (status === "AGREED" && agreement) {
    return (
      <div className="animate-fade-in flex flex-col gap-6 rounded-2xl border border-accent/30 bg-surface p-6 sm:p-8">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold tracking-widest text-accent uppercase">Deal agreed</p>
          <h3 className="text-2xl font-semibold tracking-tight text-foreground">{productName ?? agreement.sku}</h3>
        </div>

        <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div>
            <p className="text-xs text-muted">Quantity</p>
            <p className="text-2xl font-semibold text-foreground">{agreement.quantity} units</p>
          </div>
          <div>
            <p className="text-xs text-muted">Unit price</p>
            <p className="text-2xl font-semibold text-foreground">{formatInr(agreement.unitPrice)}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Delivery</p>
            <p className="text-2xl font-semibold text-foreground">{agreement.deliveryDays} day(s)</p>
          </div>
          <div className="ml-auto">
            <p className="text-xs text-muted">Total</p>
            <p className="text-3xl font-semibold tracking-tight text-accent">{formatInr(agreement.totalAmount)}</p>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-4 text-xs text-muted">
          <span>
            Agreement ID: <span className="font-mono">{agreement.id}</span>
          </span>
        </div>

        {showPayment ? (
          <PaymentPanel
            agreementId={agreement.id}
            productName={productName ?? agreement.sku}
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

  const explanation =
    status === "REJECTED" || status === "EXPIRED"
      ? negotiationFailureExplanation(status, round, maxRounds ?? undefined)
      : null;

  return (
    <div className="animate-fade-in flex flex-col gap-2 rounded-2xl border border-red-500/30 bg-surface p-6 sm:p-8">
      <p className="text-xs font-semibold tracking-widest text-red-300 uppercase">No deal</p>
      <h3 className="text-xl font-semibold tracking-tight text-foreground">
        Negotiation {negotiationStatusLabel(status).toLowerCase()}
      </h3>
      {explanation && <p className="text-sm text-muted">{explanation}</p>}
      <p className="text-sm text-muted">{lastTurn?.merchant?.message ?? "The negotiation ended without an agreement."}</p>
    </div>
  );
}
