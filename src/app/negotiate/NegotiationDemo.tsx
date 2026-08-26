"use client";

import { useState, type FormEvent } from "react";
import type { PublicManifestProduct } from "@/types/manifest";
import type {
  NegotiationAgreementDTO,
  NegotiationMessageDTO,
  NegotiationSessionResponse,
  NegotiationTurnResponse,
} from "@/types/negotiation";
import type { NegotiationStatus } from "@/lib/rules/negotiationState";
import {
  buyerThinkingLabel,
  computeMaxOrderValue,
  formatInr,
  merchantThinkingLabel,
  negotiationFailureExplanation,
  negotiationMessageTypeBadgeClass,
  negotiationMessageTypeLabel,
  negotiationStatusBadgeClass,
  negotiationStatusLabel,
  parseBuyerRequestForm,
  type BuyerRequestFormValues,
} from "./negotiationUi";

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
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);

  const [maxRounds, setMaxRounds] = useState<number | null>(null);
  const [round, setRound] = useState(0);
  const [status, setStatus] = useState<NegotiationStatus | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [thinking, setThinking] = useState<{ agent: "buyer" | "merchant"; label: string } | null>(
    null,
  );
  const [agreement, setAgreement] = useState<NegotiationAgreementDTO | null>(null);

  const selectedProduct = products.find((p) => p.sku === form.sku) ?? null;
  const parsedQuantity = Number(form.quantity);
  const parsedMaxPrice = Number(form.maxUnitPrice);
  const maxOrderValuePreview =
    Number.isFinite(parsedQuantity) && Number.isFinite(parsedMaxPrice) && parsedQuantity > 0 && parsedMaxPrice > 0
      ? computeMaxOrderValue(parsedQuantity, parsedMaxPrice)
      : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setApiError(null);

    const parsed = parseBuyerRequestForm(form);
    if (typeof parsed === "string") {
      setFormError(parsed);
      return;
    }

    setRunning(true);
    setStarted(true);
    setTranscript([]);
    setAgreement(null);
    setRound(0);
    setStatus(null);
    setThinking({ agent: "buyer", label: buyerThinkingLabel(1) });

    try {
      const createResponse = await fetch("/api/negotiations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
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
        setTranscript((prev) => [...prev, { turn: turn.turn, buyer: turn.buyer, merchant: null }]);

        // Then show the merchant "thinking" before revealing its response
        // — the response itself is already known; this only paces its
        // reveal so the transcript doesn't dump instantly.
        setThinking({ agent: "merchant", label: merchantThinkingLabel(turn.merchant.type) });
        await delay(THINKING_DELAY_MS);

        setTranscript((prev) =>
          prev.map((t) => (t.turn === turn.turn ? { ...t, merchant: turn.merchant } : t)),
        );
        setRound(turn.round);
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

  const lastTurn = transcript[transcript.length - 1];
  const previousTurn = transcript[transcript.length - 2];
  const latestBuyerOffer = lastTurn?.buyer ?? null;
  const latestMerchantOffer = lastTurn?.merchant ?? null;

  return (
    <div className="flex flex-col gap-8">
      <AgentObjectivesHeader />

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-medium text-black dark:text-zinc-50">
            Start a negotiation
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Tell the Buyer Agent what it&apos;s shopping for. It will negotiate with
            the Merchant Agent on your behalf, one real exchange at a time.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 rounded-xl border border-black/[.08] p-5 dark:border-white/[.145]"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Product</span>
              <select
                value={form.sku}
                disabled={running}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 disabled:opacity-50 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
              >
                {products.map((product) => (
                  <option key={product.sku} value={product.sku}>
                    {product.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Quantity</span>
              <input
                type="number"
                min={1}
                disabled={running}
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 disabled:opacity-50 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Maximum price per unit (₹)
              </span>
              <input
                type="number"
                min={1}
                disabled={running}
                value={form.maxUnitPrice}
                onChange={(e) => setForm({ ...form, maxUnitPrice: e.target.value })}
                className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 disabled:opacity-50 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Delivery deadline (days)
              </span>
              <input
                type="number"
                min={1}
                disabled={running}
                value={form.deliveryDeadlineDays}
                onChange={(e) => setForm({ ...form, deliveryDeadlineDays: e.target.value })}
                className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 disabled:opacity-50 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
              />
            </label>
          </div>

          {selectedProduct && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-black/[.03] px-4 py-3 text-xs text-zinc-600 dark:bg-white/[.04] dark:text-zinc-400">
              <span>
                Listed price:{" "}
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {formatInr(selectedProduct.listedPrice)} / unit
                </span>
              </span>
              <span>
                Available quantity:{" "}
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {selectedProduct.availableQuantity}
                </span>
              </span>
              <span>
                Standard delivery:{" "}
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {selectedProduct.standardDeliveryDays} day(s)
                </span>
              </span>
              <span>
                Negotiable:{" "}
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {selectedProduct.negotiable ? "Yes" : "No"}
                </span>
              </span>
              {maxOrderValuePreview !== null && (
                <span className="ml-auto">
                  Maximum possible order value:{" "}
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {formatInr(maxOrderValuePreview)}
                  </span>
                </span>
              )}
            </div>
          )}

          <div>
            {formError && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{formError}</p>}
            {apiError && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{apiError}</p>}
            <button
              type="submit"
              disabled={running}
              className="flex h-11 items-center justify-center rounded-full bg-foreground px-6 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
            >
              {running ? "Negotiating…" : "Start Negotiation"}
            </button>
          </div>
        </form>
      </section>

      {!started && (
        <p className="rounded-lg border border-dashed border-black/[.15] p-6 text-center text-sm text-zinc-500 dark:border-white/[.2] dark:text-zinc-500">
          Fill in the form above and start a negotiation to watch the Buyer and
          Merchant Agents negotiate live, one real exchange at a time.
        </p>
      )}

      {started && (
        <section className="flex flex-col gap-4">
          <NegotiationStateHeader
            status={status}
            round={round}
            maxRounds={maxRounds}
            buyerOffer={latestBuyerOffer}
            merchantOffer={latestMerchantOffer}
            previousBuyerOffer={previousTurn?.buyer ?? null}
            previousMerchantOffer={previousTurn?.merchant ?? null}
          />

          <ol className="flex flex-col gap-4">
            {transcript.map((turn) => (
              <li key={turn.turn}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
                  Round {turn.turn}
                </p>
                <div className="flex flex-col gap-3">
                  <MessageBubble side="buyer" msg={turn.buyer} />
                  <MessageBubble side="merchant" msg={turn.merchant} />
                </div>
              </li>
            ))}

            {thinking && (
              <li>
                <div
                  className={`flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm ${
                    thinking.agent === "buyer"
                      ? "border-blue-200 text-blue-700 dark:border-blue-900/50 dark:text-blue-300"
                      : "border-amber-200 text-amber-700 dark:border-amber-900/50 dark:text-amber-300"
                  } ${thinking.agent === "buyer" ? "" : "ml-6 sm:ml-12"}`}
                >
                  <span className="inline-flex gap-0.5">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
                  </span>
                  <span>{thinking.label}</span>
                </div>
              </li>
            )}
          </ol>

          {status && TERMINAL_STATUSES.includes(status) && (
            <OutcomeCard
              status={status}
              agreement={agreement}
              lastTurn={lastTurn}
              productName={selectedProduct?.name ?? null}
            />
          )}
        </section>
      )}
    </div>
  );
}

/** Static, always-visible explainer of what each agent is trying to do — never gated on a negotiation running. */
function AgentObjectivesHeader() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 dark:border-blue-900/40 dark:bg-blue-950/20">
        <p className="text-xs font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
          Buyer Agent
        </p>
        <p className="mt-1 text-sm text-zinc-800 dark:text-zinc-200">
          Goal: get the best possible price ↓
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-500">
          Constraint: maximum budget it can never exceed
        </p>
      </div>
      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
        <p className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
          Merchant Agent
        </p>
        <p className="mt-1 text-sm text-zinc-800 dark:text-zinc-200">
          Goal: get the best possible selling price ↑
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-500">
          Constraint: a private reservation price it can never go below
        </p>
      </div>
    </div>
  );
}

function priceTrend(current: number | null, previous: number | null): "up" | "down" | null {
  if (current === null || previous === null || current === previous) {
    return null;
  }
  return current > previous ? "up" : "down";
}

function NegotiationStateHeader({
  status,
  round,
  maxRounds,
  buyerOffer,
  merchantOffer,
  previousBuyerOffer,
  previousMerchantOffer,
}: {
  status: NegotiationStatus | null;
  round: number;
  maxRounds: number | null;
  buyerOffer: NegotiationMessageDTO | null;
  merchantOffer: NegotiationMessageDTO | null;
  previousBuyerOffer: NegotiationMessageDTO | null;
  previousMerchantOffer: NegotiationMessageDTO | null;
}) {
  const buyerPrice = buyerOffer?.unitPrice ?? null;
  const merchantPrice = merchantOffer?.unitPrice ?? null;
  const buyerTrend = priceTrend(buyerPrice, previousBuyerOffer?.unitPrice ?? null);
  const merchantTrend = priceTrend(merchantPrice, previousMerchantOffer?.unitPrice ?? null);
  const gap = buyerPrice !== null && merchantPrice !== null ? Math.abs(merchantPrice - buyerPrice) : null;
  const quantity = merchantOffer?.quantity ?? buyerOffer?.quantity ?? null;
  const delivery = merchantOffer?.deliveryDays ?? buyerOffer?.deliveryDays ?? null;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-black/[.08] p-5 dark:border-white/[.145]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium text-black dark:text-zinc-50">AI-to-AI Negotiation</h2>
        <div className="flex items-center gap-2">
          {status && (
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium ${negotiationStatusBadgeClass(status)}`}
            >
              {negotiationStatusLabel(status)}
            </span>
          )}
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            Round {round} / {maxRounds ?? "—"}
          </span>
        </div>
      </div>

      {/* Price convergence: both agents' current offers, moving toward each other. */}
      <div className="flex items-center justify-center gap-3 rounded-lg bg-black/[.03] px-4 py-4 dark:bg-white/[.04] sm:gap-6">
        <PriceStat label="Buyer offer" price={buyerPrice} trend={buyerTrend} tone="blue" />
        <div className="flex flex-col items-center gap-1 text-zinc-400 dark:text-zinc-600">
          <span aria-hidden className="text-lg leading-none">
            {gap === 0 ? "✓" : "↔"}
          </span>
          <span className="whitespace-nowrap text-[11px]">
            {gap === null ? "—" : gap === 0 ? "matched" : `gap ${formatInr(gap)}`}
          </span>
        </div>
        <PriceStat label="Merchant offer" price={merchantPrice} trend={merchantTrend} tone="amber" />
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs text-zinc-500 dark:text-zinc-500">Quantity being negotiated</p>
          <p className="font-medium text-zinc-900 dark:text-zinc-100">{quantity ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500 dark:text-zinc-500">Delivery being negotiated</p>
          <p className="font-medium text-zinc-900 dark:text-zinc-100">
            {delivery !== null ? `${delivery} day(s)` : "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

function PriceStat({
  label,
  price,
  trend,
  tone,
}: {
  label: string;
  price: number | null;
  trend: "up" | "down" | null;
  tone: "blue" | "amber";
}) {
  const toneClass = tone === "blue" ? "text-blue-700 dark:text-blue-400" : "text-amber-700 dark:text-amber-400";
  return (
    <div className="text-center">
      <p className={`text-xs font-medium ${toneClass}`}>{label}</p>
      <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        {price !== null ? formatInr(price) : "—"}
      </p>
      {trend && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
          {trend === "up" ? "▲ increased" : "▼ decreased"}
        </p>
      )}
    </div>
  );
}

function MessageBubble({
  side,
  msg,
}: {
  side: "buyer" | "merchant";
  msg: NegotiationMessageDTO | null;
}) {
  const isBuyer = side === "buyer";
  const label = isBuyer ? "Buyer Agent" : "Merchant Agent";
  const alignClass = isBuyer ? "" : "sm:ml-12";
  const accentClass = isBuyer
    ? "border-blue-200 dark:border-blue-900/40"
    : "border-amber-200 dark:border-amber-900/40";

  if (!msg) {
    return (
      <div className={`rounded-xl border border-dashed p-4 opacity-40 ${accentClass} ${alignClass}`}>
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
          {label}
        </span>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border bg-black/[.02] p-4 dark:bg-white/[.03] ${accentClass} ${alignClass}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
          {label}
        </span>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${negotiationMessageTypeBadgeClass(msg.type)}`}
        >
          {negotiationMessageTypeLabel(msg.type)}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{msg.message}</p>
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        <div className="flex gap-1">
          <dt className="text-zinc-400 dark:text-zinc-600">Qty:</dt>
          <dd>{msg.quantity ?? "—"}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-zinc-400 dark:text-zinc-600">Unit price:</dt>
          <dd>{msg.unitPrice !== null ? formatInr(msg.unitPrice) : "—"}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-zinc-400 dark:text-zinc-600">Delivery:</dt>
          <dd>{msg.deliveryDays !== null ? `${msg.deliveryDays} day(s)` : "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

function OutcomeCard({
  status,
  agreement,
  lastTurn,
  productName,
}: {
  status: NegotiationStatus;
  agreement: NegotiationAgreementDTO | null;
  lastTurn: TranscriptTurn | undefined;
  productName: string | null;
}) {
  if (status === "AGREED" && agreement) {
    return (
      <div className="flex flex-col gap-4 rounded-xl border-2 border-green-300 bg-green-50 p-5 dark:border-green-800 dark:bg-green-950/30">
        <div>
          <h3 className="text-lg font-bold tracking-tight text-green-900 dark:text-green-200">
            Agreement reached
          </h3>
          <p className="text-sm text-green-800/80 dark:text-green-300/80">
            Buyer and Merchant Agents reached an agreement.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
          <div>
            <dt className="text-green-700/70 dark:text-green-400/70">Product</dt>
            <dd className="font-medium text-green-900 dark:text-green-200">
              {productName ?? agreement.sku}
            </dd>
          </div>
          <div>
            <dt className="text-green-700/70 dark:text-green-400/70">Quantity</dt>
            <dd className="font-medium text-green-900 dark:text-green-200">
              {agreement.quantity}
            </dd>
          </div>
          <div>
            <dt className="text-green-700/70 dark:text-green-400/70">Final unit price</dt>
            <dd className="font-medium text-green-900 dark:text-green-200">
              {formatInr(agreement.unitPrice)}
            </dd>
          </div>
          <div>
            <dt className="text-green-700/70 dark:text-green-400/70">Delivery</dt>
            <dd className="font-medium text-green-900 dark:text-green-200">
              {agreement.deliveryDays} day(s)
            </dd>
          </div>
          <div>
            <dt className="text-green-700/70 dark:text-green-400/70">Total amount</dt>
            <dd className="font-medium text-green-900 dark:text-green-200">
              {formatInr(agreement.totalAmount)}
            </dd>
          </div>
        </dl>
        <button
          type="button"
          disabled
          title="Payment is not implemented yet"
          className="flex h-11 w-fit items-center justify-center rounded-full bg-zinc-400 px-6 text-sm font-medium text-white opacity-60 dark:bg-zinc-700"
        >
          Proceed to Payment
        </button>
      </div>
    );
  }

  const explanation =
    status === "REJECTED" || status === "EXPIRED" ? negotiationFailureExplanation(status) : null;

  return (
    <div className="flex flex-col gap-2 rounded-xl border-2 border-red-300 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/30">
      <h3 className="text-lg font-bold tracking-tight text-red-900 dark:text-red-200">
        Negotiation failed — {negotiationStatusLabel(status)}
      </h3>
      {explanation && <p className="text-sm text-red-800 dark:text-red-300">{explanation}</p>}
      <p className="text-sm text-red-800/80 dark:text-red-300/80">
        {lastTurn?.merchant?.message ?? "The negotiation ended without an agreement."}
      </p>
    </div>
  );
}
