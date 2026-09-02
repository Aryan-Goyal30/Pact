"use client";

// Client island for the Merchant Console's "Active negotiations"
// section — the surrounding page (page.tsx) stays a Server Component
// that reads Prisma directly and passes down plain, already-parsed
// data; this file owns only which row's detail drawer is open. Opening
// a negotiation never calls anything beyond the EXISTING, already-built
// GET /api/negotiations/:id/audit-trail (see AuditTrailPanel, reused
// verbatim here) — no new backend behavior, no negotiation state ever
// written from this console.

import { useEffect, useState } from "react";
import { AuditTrailPanel } from "@/app/negotiate/AuditTrailPanel";

export interface ActiveNegotiationSummary {
  sessionId: string;
  sku: string;
  quantity: number | null;
  buyerTarget: number | null;
  currentOffer: number | null;
  statusLabel: string;
  round: number;
  maxRounds: number;
}

function formatInr(amount: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function ActiveNegotiationsList({ sessions }: { sessions: ActiveNegotiationSummary[] }) {
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const open = sessions.find((s) => s.sessionId === openSessionId) ?? null;

  if (sessions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted">
        No negotiations in progress right now.
      </div>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-2">
        {sessions.map((session) => (
          <li key={session.sessionId}>
            <button
              type="button"
              onClick={() => setOpenSessionId(session.sessionId)}
              className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:border-border-strong hover:bg-white/[.02]"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">
                  {session.quantity ?? "—"} × {session.sku}
                </span>
                <span className="text-xs text-muted">
                  Buyer target: {session.buyerTarget !== null ? formatInr(session.buyerTarget) : "—"} · Current
                  offer: {session.currentOffer !== null ? formatInr(session.currentOffer) : "—"} · Round{" "}
                  {session.round}/{session.maxRounds}
                </span>
              </div>
              <span className="rounded-full border border-yellow-500/30 px-3 py-1 text-xs font-medium text-yellow-300">
                {session.statusLabel}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {open && <NegotiationDrawer session={open} onClose={() => setOpenSessionId(null)} />}
    </>
  );
}

function NegotiationDrawer({ session, onClose }: { session: ActiveNegotiationSummary; onClose: () => void }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="animate-fade-in absolute inset-0 bg-black/70" onClick={onClose} aria-hidden />
      <div className="animate-slide-in-right relative flex h-full w-full max-w-lg flex-col gap-6 overflow-y-auto border-l border-border bg-background p-6 sm:p-8">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-widest text-muted uppercase">Negotiation detail</p>
            <h2 className="text-xl font-medium text-foreground">
              {session.quantity ?? "—"} × {session.sku}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full border border-border p-2 text-muted transition-colors hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-4 rounded-xl border border-border p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Status</dt>
            <dd className="font-medium text-foreground">{session.statusLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Round</dt>
            <dd className="font-medium text-foreground">
              {session.round}/{session.maxRounds}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Buyer target</dt>
            <dd className="font-medium text-foreground">
              {session.buyerTarget !== null ? formatInr(session.buyerTarget) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Current offer</dt>
            <dd className="font-medium text-foreground">
              {session.currentOffer !== null ? formatInr(session.currentOffer) : "—"}
            </dd>
          </div>
        </dl>

        {/* The exact same persisted audit trail the buyer-facing page
            uses — reused verbatim, never a second implementation. */}
        <AuditTrailPanel sessionId={session.sessionId} productName={session.sku} />
      </div>
    </div>
  );
}
