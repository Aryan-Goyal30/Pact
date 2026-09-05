"use client";

// Shared slide-over shell — the "contextual intelligence panel" chrome
// used by both the negotiation Decision Trace panel and the dashboard's
// negotiation-detail drawer. Owns only presentation/lifecycle (backdrop,
// width, scroll lock, Escape-to-close); every caller supplies its own
// title/body content and real data.

import { useEffect, type ReactNode } from "react";

interface InspectorPanelProps {
  eyebrow: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** A touch wider than the default — used by the audit-trail drawer, which carries denser content than a single round's decision trace. */
  wide?: boolean;
}

export function InspectorPanel({ eyebrow, title, onClose, children, wide }: InspectorPanelProps) {
  // Unconditional set/restore, not a captured "previous value" — see
  // PaymentPanel.tsx's own scroll-lock effect for why capture-and-restore
  // is unsafe under React 19 Strict Mode's double-invocation in dev (a
  // second invocation's "previous value" can read back what the FIRST
  // invocation just set). "" is this app's only true rest state for
  // body.style.overflow.
  useEffect(() => {
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="animate-fade-in absolute inset-0 bg-black/70 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        className={`animate-slide-in-right relative flex h-full w-full flex-col gap-6 overflow-y-auto border-l border-border bg-background p-6 sm:p-8 ${
          wide ? "sm:max-w-xl" : "sm:max-w-lg"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-widest text-muted uppercase">{eyebrow}</p>
            <h2 className="text-display-3 font-semibold text-foreground">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full border border-border p-2 text-muted transition-colors hover:border-border-strong hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {children}
      </div>
    </div>
  );
}
