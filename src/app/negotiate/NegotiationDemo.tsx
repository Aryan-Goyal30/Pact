"use client";

import { useState, type FormEvent } from "react";
import type { PublicManifestProduct } from "@/types/manifest";
import type { NegotiationRunResponse } from "@/types/negotiation";
import {
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

const MESSAGE_TYPE_LABELS: Record<string, string> = {
  request: "Request",
  offer: "Offer",
  counter_offer: "Counter-offer",
  accept: "Accept",
  reject: "Reject",
};

interface NegotiationDemoProps {
  products: PublicManifestProduct[];
}

// Client Component: owns only form state and the fetch call to
// POST /api/negotiations. It never computes a price, quantity, delivery
// day, or outcome itself — every structured value rendered below comes
// straight from that API response, which is built entirely by the
// existing deterministic orchestrator/rule engine.
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
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [result, setResult] = useState<NegotiationRunResponse | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setApiError(null);

    const parsed = parseBuyerRequestForm(form);
    if (typeof parsed === "string") {
      setFormError(parsed);
      return;
    }

    setLoading(true);
    setResult(null);
    try {
      const response = await fetch("/api/negotiations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const body = await response.json();
      if (!response.ok) {
        setApiError(typeof body?.error === "string" ? body.error : "Negotiation failed.");
        return;
      }
      setResult(body as NegotiationRunResponse);
    } catch {
      setApiError("Could not reach the negotiation API.");
    } finally {
      setLoading(false);
    }
  }

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
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
              className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
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
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Max unit price (₹)</span>
            <input
              type="number"
              min={1}
              value={form.maxUnitPrice}
              onChange={(e) => setForm({ ...form, maxUnitPrice: e.target.value })}
              className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Delivery deadline (days)</span>
            <input
              type="number"
              min={1}
              value={form.deliveryDeadlineDays}
              onChange={(e) => setForm({ ...form, deliveryDeadlineDays: e.target.value })}
              className="rounded-md border border-black/[.15] bg-white px-3 py-2 text-zinc-900 dark:border-white/[.2] dark:bg-black dark:text-zinc-100"
            />
          </label>

          <div className="sm:col-span-4">
            {formError && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{formError}</p>}
            {apiError && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{apiError}</p>}
            <button
              type="submit"
              disabled={loading}
              className="flex h-11 items-center justify-center rounded-full bg-foreground px-6 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
            >
              {loading ? "Negotiating…" : "Start Negotiation"}
            </button>
          </div>
        </form>
      </section>

      {result && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-medium text-black dark:text-zinc-50">
              Negotiation transcript
            </h2>
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium ${negotiationStatusBadgeClass(result.finalStatus)}`}
            >
              {negotiationStatusLabel(result.finalStatus)}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-500">
              {result.rounds} / {result.maxRounds} round(s)
            </span>
          </div>

          <ol className="flex flex-col gap-4">
            {result.transcript.map((turn) => (
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
          </ol>

          <OutcomeCard result={result} />
        </section>
      )}
    </div>
  );
}

function MessageCard({
  label,
  msg,
}: {
  label: string;
  msg: NegotiationRunResponse["transcript"][number]["buyer"];
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-black/[.03] p-3 dark:bg-white/[.04]">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
          {label}
        </span>
        <span className="rounded bg-black/[.06] px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-white/[.08] dark:text-zinc-300">
          {MESSAGE_TYPE_LABELS[msg.type] ?? msg.type}
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

function OutcomeCard({ result }: { result: NegotiationRunResponse }) {
  if (result.finalStatus === "AGREED" && result.agreement) {
    const { agreement } = result;
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

  const lastTurn = result.transcript[result.transcript.length - 1];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/30">
      <h3 className="text-base font-semibold text-red-900 dark:text-red-200">
        No agreement reached — {negotiationStatusLabel(result.finalStatus).toLowerCase()}
      </h3>
      <p className="text-sm text-red-800 dark:text-red-300">
        {lastTurn?.merchant.message ?? "The negotiation ended without an agreement."}
      </p>
    </div>
  );
}
