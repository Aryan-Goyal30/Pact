"use client";

// Read-only Audit Trail viewer — Roadmap milestone: demonstrates
// Agent decision -> persisted AuditLog -> API -> UI, not "data that
// happens to still exist in React state." This panel NEVER reads the
// live transcript/decisionAudit state NegotiationDemo.tsx already holds
// — every entry rendered here comes from a fresh
// GET /api/negotiations/:id/audit-trail call, fetched only when the
// user asks for it (never proactively, never polled).

import { useState } from "react";
import type { AuditTrailEntryDTO, AuditTrailResponse } from "@/types/negotiation";
import type { TurnDecisionAudit } from "@/lib/negotiation/agentDecision";
import { AgentDecisionSide } from "./NegotiationDemo";
import { formatInr } from "./negotiationUi";

interface AuditTrailPanelProps {
  /** The negotiation session to inspect — null before a negotiation has actually been created (nothing to fetch yet). */
  sessionId: string | null;
  /** Display-only, for the AGREEMENT_CREATED card — the same product name OutcomeCard already resolves from the client's own product list; falls back to the persisted sku when unavailable. */
  productName: string | null;
}

export function AuditTrailPanel({ sessionId, productName }: AuditTrailPanelProps) {
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<AuditTrailEntryDTO[] | null>(null);

  async function handleViewAuditTrail() {
    if (!sessionId) return;
    setOpened(true);
    setLoading(true);
    setError(null);
    try {
      // A fresh network call, every time — this is the whole point of
      // the feature: reading back what was actually persisted, not
      // reformatting state this component already has.
      const response = await fetch(`/api/negotiations/${sessionId}/audit-trail`);
      const body = (await response.json()) as AuditTrailResponse & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not load the audit trail.");
        return;
      }
      setEntries(body.entries);
    } catch {
      setError("Could not reach the audit trail API.");
    } finally {
      setLoading(false);
    }
  }

  if (!sessionId) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-black/[.08] p-5 dark:border-white/[.145]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-black dark:text-zinc-50">Audit Trail</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Persisted events from this negotiation</p>
        </div>
        <button
          type="button"
          onClick={handleViewAuditTrail}
          disabled={loading}
          className="rounded-full border border-black/[.12] px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.18] dark:text-zinc-300 dark:hover:bg-white/[.06]"
        >
          {loading ? "Loading…" : opened ? "Refresh" : "View Audit Trail"}
        </button>
      </div>

      {opened && (
        <div className="flex flex-col gap-1">
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          {!error && entries && entries.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-500">No audit events recorded yet.</p>
          )}

          {!error && entries && entries.length > 0 && (
            <ol className="flex flex-col">
              {entries.map((entry, i) => (
                <li key={entry.id} className="flex flex-col">
                  <AuditTrailEntryCard entry={entry} productName={productName} />
                  {i < entries.length - 1 && (
                    <div aria-hidden className="flex justify-center py-1 text-zinc-300 dark:text-zinc-700">
                      ↓
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function AuditTrailEntryCard({
  entry,
  productName,
}: {
  entry: AuditTrailEntryDTO;
  productName: string | null;
}) {
  if (entry.eventType === "NEGOTIATION_DECISION" && entry.decision) {
    return <NegotiationDecisionEntry entry={entry} decision={entry.decision} />;
  }
  if (entry.eventType === "AGREEMENT_CREATED") {
    return <AgreementCreatedEntry entry={entry} productName={productName} />;
  }
  return <GenericAuditEntry entry={entry} />;
}

/**
 * A persisted NEGOTIATION_DECISION row — reuses AgentDecisionSide (the
 * exact component the live Agent Activity panel already uses) so the
 * rendering logic exists in exactly one place, whether it's fed from a
 * live turn response or a persisted audit row.
 */
function NegotiationDecisionEntry({
  entry,
  decision,
}: {
  entry: AuditTrailEntryDTO;
  decision: TurnDecisionAudit;
}) {
  return (
    <div className="rounded-lg border border-dashed border-black/[.12] p-3 text-xs dark:border-white/[.18]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
          Round {entry.turn} decision
        </span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-600">{formatTimestamp(entry.createdAt)}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <AgentDecisionSide label="Buyer" tone="blue" record={decision.buyer} />
        <AgentDecisionSide label="Merchant" tone="amber" record={decision.merchant ?? null} />
      </div>
    </div>
  );
}

function AgreementCreatedEntry({
  entry,
  productName,
}: {
  entry: AuditTrailEntryDTO;
  productName: string | null;
}) {
  const payload = entry.payload ?? {};
  const sku = typeof payload.sku === "string" ? payload.sku : null;
  const quantity = typeof payload.quantity === "number" ? payload.quantity : null;
  const unitPrice = typeof payload.unitPrice === "number" ? payload.unitPrice : null;
  const deliveryDays = typeof payload.deliveryDays === "number" ? payload.deliveryDays : null;
  const totalAmount = typeof payload.totalAmount === "number" ? payload.totalAmount : null;

  return (
    <div className="rounded-lg border-2 border-green-300 bg-green-50 p-3 text-xs dark:border-green-800 dark:bg-green-950/30">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-green-700 dark:text-green-400">
          Agreement Created
        </span>
        <span className="text-[11px] text-green-700/70 dark:text-green-400/70">
          {formatTimestamp(entry.createdAt)}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div>
          <dt className="text-green-700/70 dark:text-green-400/70">Product</dt>
          <dd className="font-medium text-green-900 dark:text-green-200">{productName ?? sku ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-green-700/70 dark:text-green-400/70">Quantity</dt>
          <dd className="font-medium text-green-900 dark:text-green-200">{quantity ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-green-700/70 dark:text-green-400/70">Unit price</dt>
          <dd className="font-medium text-green-900 dark:text-green-200">
            {unitPrice !== null ? formatInr(unitPrice) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-green-700/70 dark:text-green-400/70">Delivery</dt>
          <dd className="font-medium text-green-900 dark:text-green-200">
            {deliveryDays !== null ? `${deliveryDays} day(s)` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-green-700/70 dark:text-green-400/70">Total amount</dt>
          <dd className="font-medium text-green-900 dark:text-green-200">
            {totalAmount !== null ? formatInr(totalAmount) : "—"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  PAYMENT_ORDER_CREATED: "Payment order created",
  PAYMENT_VERIFICATION_STARTED: "Payment verification started",
  PAYMENT_SUCCEEDED: "Payment succeeded",
  PAYMENT_FAILED: "Payment failed",
  RECOVERY_STARTED: "Recovery started",
  RECOVERY_SUCCEEDED: "Recovery succeeded",
  RECOVERY_FAILED: "Recovery failed",
  WEBHOOK_RECEIVED: "Webhook received",
  PAYMENT_FAILURE_REPORTED: "Payment failure reported",
};

const EVENT_TYPE_TONE_CLASS: Record<string, string> = {
  PAYMENT_SUCCEEDED: "text-green-700 dark:text-green-400",
  RECOVERY_SUCCEEDED: "text-green-700 dark:text-green-400",
  PAYMENT_FAILED: "text-red-700 dark:text-red-400",
  RECOVERY_FAILED: "text-red-700 dark:text-red-400",
  PAYMENT_FAILURE_REPORTED: "text-red-700 dark:text-red-400",
};

function humanizeFactKey(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function formatFactValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Every other persisted event type (AGREEMENT_CREATED is handled above;
 * everything payment/recovery/webhook-related, plus any future event
 * type this panel doesn't know about yet, lands here) — a compact
 * timeline row of real business facts, never a raw JSON dump.
 * WEBHOOK_RECEIVED's own `rawPayload` is deliberately excluded from the
 * summary facts and only reachable via a collapsed <details>, per this
 * milestone's own "keep the default view compact" requirement.
 */
function GenericAuditEntry({ entry }: { entry: AuditTrailEntryDTO }) {
  const label = EVENT_TYPE_LABELS[entry.eventType] ?? entry.eventType;
  const toneClass = EVENT_TYPE_TONE_CLASS[entry.eventType] ?? "text-zinc-600 dark:text-zinc-400";
  const { rawPayload, ...facts } = entry.payload ?? {};
  const factEntries = Object.entries(facts).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );

  return (
    <div className="rounded-lg border border-black/[.08] bg-black/[.02] p-3 text-xs dark:border-white/[.1] dark:bg-white/[.03]">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className={`text-xs font-semibold uppercase tracking-wider ${toneClass}`}>{label}</span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-600">{formatTimestamp(entry.createdAt)}</span>
      </div>
      {factEntries.length > 0 && (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-zinc-600 dark:text-zinc-400">
          {factEntries.map(([key, value]) => (
            <div key={key} className="flex gap-1">
              <dt className="text-zinc-400 dark:text-zinc-600">{humanizeFactKey(key)}:</dt>
              <dd>{formatFactValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {rawPayload !== undefined && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-zinc-400 dark:text-zinc-600">Raw webhook payload</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-black/[.04] p-2 text-[10px] text-zinc-600 dark:bg-white/[.05] dark:text-zinc-400">
            {JSON.stringify(rawPayload, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
