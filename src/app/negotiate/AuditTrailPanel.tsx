"use client";

// Read-only Audit Trail viewer — demonstrates
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
  /** Display-only, for the AGREEMENT_CREATED row — the same product name OutcomeCard already resolves from the client's own product list; falls back to the persisted sku when unavailable. */
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
    <div id="audit-trail" className="flex scroll-mt-24 flex-col gap-5 rounded-2xl border border-border bg-surface/60 p-6 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold tracking-widest text-muted uppercase">Transaction history</p>
          <h2 className="text-display-3 font-semibold text-foreground">Audit Trail</h2>
          <p className="text-sm text-muted">
            Every persisted decision and payment event for this negotiation
            {opened && entries && entries.length > 0 && (
              <span className="tabular-nums text-muted"> · {entries.length} recorded</span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={handleViewAuditTrail}
          disabled={loading}
          className="rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-border-strong disabled:opacity-50"
        >
          {loading ? "Loading…" : opened ? "Refresh" : "View Audit Trail"}
        </button>
      </div>

      {opened && (
        <div className="animate-fade-in flex flex-col">
          {error && <p className="text-sm text-red-300">{error}</p>}

          {!error && entries && entries.length === 0 && (
            <p className="text-sm text-muted">No audit events recorded yet.</p>
          )}

          {!error && entries && entries.length > 0 && (
            <ol className="flex flex-col border-l border-border pl-5">
              {entries.map((entry) => (
                <AuditTrailEntryRow key={entry.id} entry={entry} productName={productName} />
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

const FAILURE_EVENT_TYPES = new Set(["PAYMENT_FAILED", "RECOVERY_FAILED", "PAYMENT_FAILURE_REPORTED"]);

/** A short, human label for the checklist row — never fabricated, always derived from the row's own real eventType/turn. */
function entryLabel(entry: AuditTrailEntryDTO): string {
  if (entry.eventType === "NEGOTIATION_DECISION") {
    return `Round ${entry.turn ?? "?"} decision`;
  }
  if (entry.eventType === "AGREEMENT_CREATED") {
    return "Agreement created";
  }
  return EVENT_TYPE_LABELS[entry.eventType] ?? entry.eventType;
}

function hasExpandableDetail(entry: AuditTrailEntryDTO): boolean {
  if (entry.eventType === "NEGOTIATION_DECISION" || entry.eventType === "AGREEMENT_CREATED") return true;
  return Object.keys(entry.payload ?? {}).length > 0;
}

/**
 * One row of the checklist-style transaction timeline. A negotiation
 * that hasn't reached AGREED/paid yet simply has fewer rows — nothing
 * is ever added to fill the gap (see listAuditTrail — the underlying
 * query only ever returns rows that genuinely exist).
 */
function AuditTrailEntryRow({ entry, productName }: { entry: AuditTrailEntryDTO; productName: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = hasExpandableDetail(entry);
  const isFailure = FAILURE_EVENT_TYPES.has(entry.eventType);

  return (
    <li className="relative pb-1">
      <span
        className={`absolute top-4 -left-[26px] h-2.5 w-2.5 rounded-full ring-4 ring-background ${
          isFailure ? "bg-red-400" : "bg-emerald-400"
        }`}
        aria-hidden
      />
      <button
        type="button"
        onClick={() => expandable && setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={`flex w-full items-center gap-3 py-3 text-left ${expandable ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className="flex-1 text-sm font-medium text-foreground">{entryLabel(entry)}</span>
        <span className="tabular-nums text-xs text-muted">{formatTimestamp(entry.createdAt)}</span>
        {expandable && (
          <span className={`text-[10px] text-muted transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden>
            ⌄
          </span>
        )}
      </button>

      {expanded && (
        <div className="animate-fade-in pb-4 pl-8">
          {entry.eventType === "NEGOTIATION_DECISION" && entry.decision && (
            <NegotiationDecisionDetail decision={entry.decision} />
          )}
          {entry.eventType === "AGREEMENT_CREATED" && (
            <AgreementCreatedDetail payload={entry.payload ?? {}} productName={productName} />
          )}
          {entry.eventType !== "NEGOTIATION_DECISION" && entry.eventType !== "AGREEMENT_CREATED" && (
            <GenericEntryDetail payload={entry.payload ?? {}} />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * A persisted NEGOTIATION_DECISION row's expanded detail — reuses
 * AgentDecisionSide (the exact component the live negotiation timeline
 * already uses for "Why this move?") so the rendering logic exists in
 * exactly one place, whether it's fed from a live turn response or a
 * persisted audit row.
 */
function NegotiationDecisionDetail({ decision }: { decision: TurnDecisionAudit }) {
  return (
    <div className="grid grid-cols-1 gap-4 rounded-xl border border-border bg-surface p-4 text-xs sm:grid-cols-2">
      <AgentDecisionSide label="Buyer" tone="blue" record={decision.buyer} />
      <AgentDecisionSide label="Merchant" tone="amber" record={decision.merchant ?? null} />
    </div>
  );
}

function AgreementCreatedDetail({
  payload,
  productName,
}: {
  payload: Record<string, unknown>;
  productName: string | null;
}) {
  const sku = typeof payload.sku === "string" ? payload.sku : null;
  const quantity = typeof payload.quantity === "number" ? payload.quantity : null;
  const unitPrice = typeof payload.unitPrice === "number" ? payload.unitPrice : null;
  const deliveryDays = typeof payload.deliveryDays === "number" ? payload.deliveryDays : null;
  const totalAmount = typeof payload.totalAmount === "number" ? payload.totalAmount : null;

  return (
    <dl className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-surface p-4 text-xs sm:grid-cols-5">
      <div>
        <dt className="text-muted">Product</dt>
        <dd className="font-medium text-foreground">{productName ?? sku ?? "—"}</dd>
      </div>
      <div>
        <dt className="text-muted">Quantity</dt>
        <dd className="font-medium text-foreground">{quantity ?? "—"}</dd>
      </div>
      <div>
        <dt className="text-muted">Unit price</dt>
        <dd className="font-medium text-foreground">{unitPrice !== null ? formatInr(unitPrice) : "—"}</dd>
      </div>
      <div>
        <dt className="text-muted">Delivery</dt>
        <dd className="font-medium text-foreground">{deliveryDays !== null ? `${deliveryDays} day(s)` : "—"}</dd>
      </div>
      <div>
        <dt className="text-muted">Total</dt>
        <dd className="font-medium text-foreground">{totalAmount !== null ? formatInr(totalAmount) : "—"}</dd>
      </div>
    </dl>
  );
}

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
 * Every payment/recovery/webhook event's expanded detail — compact
 * business facts, never a raw JSON dump. WEBHOOK_RECEIVED's own
 * `rawPayload` is deliberately excluded from the summary facts and only
 * reachable via a collapsed nested <details>, per the "keep the default
 * view compact" requirement.
 */
function GenericEntryDetail({ payload }: { payload: Record<string, unknown> }) {
  const { rawPayload, ...facts } = payload;
  const factEntries = Object.entries(facts).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );

  return (
    <div className="rounded-xl border border-border bg-surface p-4 text-xs">
      {factEntries.length > 0 ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-1.5 text-muted">
          {factEntries.map(([key, value]) => (
            <div key={key} className="flex gap-1.5">
              <dt className="text-muted/70">{humanizeFactKey(key)}:</dt>
              <dd className="text-foreground">{formatFactValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted">No additional details.</p>
      )}
      {rawPayload !== undefined && (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted">Raw webhook payload</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-black/30 p-2 text-[10px] text-muted">
            {JSON.stringify(rawPayload, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
