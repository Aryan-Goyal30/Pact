"use client";

// Client island for the Merchant Console's "Active negotiations"
// section — the surrounding page (page.tsx) stays a Server Component
// that reads Prisma directly and passes down plain, already-parsed
// data; this file owns only which row's detail drawer is open. Opening
// a negotiation never calls anything beyond the EXISTING, already-built
// GET /api/negotiations/:id/audit-trail (see AuditTrailPanel, reused
// verbatim here) — no new backend behavior, no negotiation state ever
// written from this console.

import { useState } from "react";
import { AuditTrailPanel } from "@/app/negotiate/AuditTrailPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { formatInr, formatRelativeTime } from "./dashboardUi";
import { useNow } from "./useNow";

export interface ActiveNegotiationSummary {
  sessionId: string;
  sku: string;
  quantity: number | null;
  buyerTarget: number | null;
  currentOffer: number | null;
  statusLabel: string;
  round: number;
  maxRounds: number;
  /** ISO 8601 — NegotiationSession.updatedAt, i.e. the last real turn activity on this session. */
  updatedAt: string;
  /** Real server-computed comparison (page.tsx's own requestTime vs updatedAt) — never a client-side timer pretending something just changed. Drives a brief, restrained highlight only. */
  recentlyUpdated: boolean;
}

export function ActiveNegotiationsList({ sessions }: { sessions: ActiveNegotiationSummary[] }) {
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const open = sessions.find((s) => s.sessionId === openSessionId) ?? null;
  // Client-only, mount-deferred — see useNow's own doc comment for why
  // this must never be read directly during render.
  const now = useNow();

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col gap-1 border-t border-border py-8 text-center">
        <p className="text-sm font-medium text-foreground">No negotiations in progress.</p>
        <p className="text-xs text-muted">Your agent will surface new activity here when a buyer starts negotiating.</p>
      </div>
    );
  }

  return (
    <>
      {/* Column header — real labels once, not repeated per row (keeps
          each row compact rather than re-stating "Buyer target"/"Gap"
          five times over). Desktop/tablet only; the mobile stack below
          relies on position + color instead, same convention the rest
          of this redesign already uses. */}
      <div className="hidden border-t border-border px-1 pt-3 text-[10px] font-semibold tracking-widest text-muted uppercase sm:grid sm:grid-cols-[auto_1fr_auto_auto_auto_auto] sm:gap-4">
        <span>Status</span>
        <span>Product</span>
        <span>Target → current</span>
        <span className="text-right">Gap</span>
        <span className="text-right">Round · updated</span>
        <span aria-hidden />
      </div>

      <ul className="flex flex-col divide-y divide-border">
        {sessions.map((session) => {
          const gap =
            session.buyerTarget !== null && session.currentOffer !== null
              ? Math.abs(session.currentOffer - session.buyerTarget)
              : null;
          return (
            <li key={session.sessionId}>
              <button
                type="button"
                onClick={() => setOpenSessionId(session.sessionId)}
                className={`grid w-full grid-cols-1 items-center gap-2 px-1 py-3.5 text-left transition-colors hover:bg-white/[.03] sm:grid-cols-[auto_1fr_auto_auto_auto_auto] sm:gap-4 ${
                  session.recentlyUpdated ? "bg-accent/[.04]" : ""
                }`}
              >
                <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-yellow-300 uppercase">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
                  {session.statusLabel}
                </span>

                <span className="font-medium text-foreground">
                  {session.quantity ?? "—"} × {session.sku}
                </span>

                <span className="tabular-nums text-sm text-muted">
                  {session.buyerTarget !== null ? formatInr(session.buyerTarget) : "—"}
                  <span className="mx-1 text-muted/50">→</span>
                  <span className="text-foreground">
                    {session.currentOffer !== null ? formatInr(session.currentOffer) : "—"}
                  </span>
                </span>

                <span className="tabular-nums text-right text-sm font-medium text-accent">
                  {gap !== null ? formatInr(gap) : "—"}
                </span>

                <span className="tabular-nums text-right text-[11px] text-muted">
                  Round {session.round}/{session.maxRounds}
                  {now !== null && (
                    <>
                      <span className="mx-1 text-muted/40">·</span>
                      {formatRelativeTime(session.updatedAt, now)}
                    </>
                  )}
                </span>

                <span className="hidden shrink-0 items-center gap-1 text-[11px] font-medium text-muted sm:flex">
                  View <span aria-hidden>→</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {open && <NegotiationDrawer session={open} now={now} onClose={() => setOpenSessionId(null)} />}
    </>
  );
}

function NegotiationDrawer({
  session,
  now,
  onClose,
}: {
  session: ActiveNegotiationSummary;
  now: number | null;
  onClose: () => void;
}) {
  return (
    <InspectorPanel eyebrow="Negotiation detail" title={`${session.quantity ?? "—"} × ${session.sku}`} onClose={onClose} wide>
      <dl className="grid grid-cols-2 gap-4 rounded-xl border border-border p-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Status</dt>
          <dd className="font-medium text-foreground">{session.statusLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Round</dt>
          <dd className="tabular-nums font-medium text-foreground">
            {session.round}/{session.maxRounds}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Buyer target</dt>
          <dd className="tabular-nums font-medium text-foreground">
            {session.buyerTarget !== null ? formatInr(session.buyerTarget) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Current offer</dt>
          <dd className="tabular-nums font-medium text-foreground">
            {session.currentOffer !== null ? formatInr(session.currentOffer) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Last activity</dt>
          <dd className="font-medium text-foreground">{now !== null ? formatRelativeTime(session.updatedAt, now) : "—"}</dd>
        </div>
      </dl>

      <p className="text-xs leading-5 text-muted">
        Merchant Agent is handling this negotiation automatically, operating within this product&rsquo;s
        configured price, stock, and delivery constraints — see the Catalog table below for the exact bounds.
      </p>

      {/* The exact same persisted audit trail the buyer-facing page
          uses — reused verbatim, never a second implementation. */}
      <AuditTrailPanel sessionId={session.sessionId} productName={session.sku} />
    </InspectorPanel>
  );
}
