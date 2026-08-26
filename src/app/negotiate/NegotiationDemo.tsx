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
  merchantThinkingLabel,
  negotiationMessageTypeBadgeClass,
  negotiationMessageTypeLabel,
  negotiationStatusBadgeClass,
  negotiationStatusLabel,
  parseBuyerRequestForm,
  type BuyerRequestFormValues,
} from "./negotiationUi";

function formatInr(amount: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

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

  const [maxRounds, setMaxRounds] = useState<number | null>(null);
  const [round, setRound] = useState(0);
  const [status, setStatus] = useState<NegotiationStatus | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [thinking, setThinking] = useState<{ agent: "buyer" | "merchant"; label: string } | null>(
    null,
  );
  const [agreement, setAgreement] = useState<NegotiationAgreementDTO | null>(null);

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
    setTranscript([]);
    setAgreement(null);
    setRound(0);
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
  const latestBuyerOffer = lastTurn?.buyer ?? null;
  const latestMerchantOffer = lastTurn?.merchant ?? latestBuyerOffer;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-black dark:text-zinc-50">
          Start a negotiation
        </h2>
        <form
          onSubmit={handleSubmit}
          className="grid grid-cols-1 gap-4 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145] sm:grid-cols-4"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Product</span>
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

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Quantity</span>
            <input
              type="number"
              min={1}
              disabled={running}
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 disabled:opacity-50 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Max unit price (₹)</span>
            <input
              type="number"
              min={1}
              disabled={running}
              value={form.maxUnitPrice}
              onChange={(e) => setForm({ ...form, maxUnitPrice: e.target.value })}
              className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 disabled:opacity-50 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Delivery deadline (days)</span>
            <input
              type="number"
              min={1}
              disabled={running}
              value={form.deliveryDeadlineDays}
              onChange={(e) => setForm({ ...form, deliveryDeadlineDays: e.target.value })}
              className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 disabled:opacity-50 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
            />
          </label>

          <div className="sm:col-span-4">
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

      {(running || transcript.length > 0) && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-medium text-black dark:text-zinc-50">
                AI-to-AI Negotiation
              </h2>
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

            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs text-zinc-500 dark:text-zinc-500">Buyer Agent</p>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {latestBuyerOffer?.unitPrice !== undefined && latestBuyerOffer?.unitPrice !== null
                    ? formatInr(latestBuyerOffer.unitPrice)
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 dark:text-zinc-500">Merchant Agent</p>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {latestMerchantOffer?.unitPrice !== undefined &&
                  latestMerchantOffer?.unitPrice !== null
                    ? formatInr(latestMerchantOffer.unitPrice)
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 dark:text-zinc-500">Quantity</p>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {latestMerchantOffer?.quantity ?? "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 dark:text-zinc-500">Delivery</p>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {latestMerchantOffer?.deliveryDays !== undefined &&
                  latestMerchantOffer?.deliveryDays !== null
                    ? `${latestMerchantOffer.deliveryDays} day(s)`
                    : "—"}
                </p>
              </div>
            </div>
          </div>

          <ol className="flex flex-col gap-4">
            {transcript.map((turn) => (
              <li
                key={turn.turn}
                className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]"
              >
                <p className="mb-3 text-xs font-medium text-zinc-500 dark:text-zinc-500">
                  Turn {turn.turn}
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <MessageCard label="Buyer Agent" msg={turn.buyer} />
                  <MessageCard label="Merchant Agent" msg={turn.merchant} />
                </div>
              </li>
            ))}

            {thinking && (
              <li className="rounded-lg border border-dashed border-black/[.15] p-4 dark:border-white/[.25]">
                <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-500">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-zinc-400 dark:bg-zinc-600" />
                  <span className="font-medium">
                    {thinking.agent === "buyer" ? "Buyer Agent" : "Merchant Agent"}
                  </span>
                  <span>— {thinking.label}</span>
                </div>
              </li>
            )}
          </ol>

          {status && TERMINAL_STATUSES.includes(status) && (
            <OutcomeCard status={status} agreement={agreement} lastTurn={lastTurn} />
          )}
        </section>
      )}
    </div>
  );
}

function MessageCard({ label, msg }: { label: string; msg: NegotiationMessageDTO | null }) {
  if (!msg) {
    return (
      <div className="flex flex-col gap-2 rounded-md bg-black/[.03] p-3 opacity-40 dark:bg-white/[.04]">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
          {label}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-black/[.03] p-3 dark:bg-white/[.04]">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
          {label}
        </span>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${negotiationMessageTypeBadgeClass(msg.type)}`}
        >
          {negotiationMessageTypeLabel(msg.type)}
        </span>
      </div>
      <p className="text-sm text-zinc-800 dark:text-zinc-200">{msg.message}</p>
      <dl className="grid grid-cols-3 gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <div>
          <dt className="text-zinc-400 dark:text-zinc-600">Qty</dt>
          <dd>{msg.quantity ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-zinc-400 dark:text-zinc-600">Unit price</dt>
          <dd>{msg.unitPrice !== null ? formatInr(msg.unitPrice) : "—"}</dd>
        </div>
        <div>
          <dt className="text-zinc-400 dark:text-zinc-600">Delivery</dt>
          <dd>{msg.deliveryDays !== null ? `${msg.deliveryDays}d` : "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

function OutcomeCard({
  status,
  agreement,
  lastTurn,
}: {
  status: NegotiationStatus;
  agreement: NegotiationAgreementDTO | null;
  lastTurn: TranscriptTurn | undefined;
}) {
  if (status === "AGREED" && agreement) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-900/50 dark:bg-green-950/30">
        <h3 className="text-base font-semibold text-green-900 dark:text-green-200">
          Agreement reached
        </h3>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-green-700/70 dark:text-green-400/70">Quantity</dt>
            <dd className="font-medium text-green-900 dark:text-green-200">
              {agreement.quantity}
            </dd>
          </div>
          <div>
            <dt className="text-green-700/70 dark:text-green-400/70">Unit price</dt>
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

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/30">
      <h3 className="text-base font-semibold text-red-900 dark:text-red-200">
        Negotiation failed — {negotiationStatusLabel(status).toLowerCase()}
      </h3>
      <p className="text-sm text-red-800 dark:text-red-300">
        {lastTurn?.merchant?.message ?? "The negotiation ended without an agreement."}
      </p>
    </div>
  );
}
