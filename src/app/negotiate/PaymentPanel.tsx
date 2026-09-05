"use client";

// The payment panel — PACT V2 Milestone 13. Deliberately its own small
// component (not folded into NegotiationDemo.tsx's own state) so the
// (already large) negotiation demo file doesn't grow further — same
// "small payment panel, not a big new dashboard" scope this milestone
// was given. Owns only payment-turn state; it never touches negotiation
// state and is only ever rendered once an Agreement already exists.
//
// This is the ONLY file that loads Razorpay's checkout.js (from the
// official CDN — never self-hosted) and the only client-side file that
// references `window.Razorpay`. It never imports anything from
// src/lib/payment/ (server-only — prisma, node:crypto, the razorpay SDK)
// — only the browser-safe DTOs (types/payment.ts) and pure helpers
// (paymentUi.ts).

import { useCallback, useEffect, useState } from "react";
import type { PaymentOrderResponseDTO, PaymentStatusResponseDTO } from "@/types/payment";
import {
  attemptProgressLabel,
  buildCheckoutSuccessRequestBody,
  buildFailureReportRequestBody,
  buildMockVerifyRequestBody,
  formatInr,
  paymentFailureLabel,
  paymentStatusLabel,
  type FailureReportRequestBody,
  type VerifyRequestBody,
} from "@/app/negotiate/paymentUi";

const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

interface RazorpayCheckoutHandlerResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayCheckoutFailedResponse {
  // Razorpay's real payment.failed event nests a payment_id (when a
  // payment object was actually created before failing) inside
  // error.metadata — see M13.1 §7.
  error?: { code?: string; description?: string; metadata?: { payment_id?: string; order_id?: string } };
}

interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description?: string;
  handler: (response: RazorpayCheckoutHandlerResponse) => void;
  modal?: { ondismiss?: () => void };
  /**
   * Presentation only — official Razorpay Standard Checkout configuration
   * (never a CSS/DOM hack against the cross-origin checkout iframe).
   * `color` tints Razorpay's own header/CTA chrome to PACT's accent;
   * `backdrop_color` sets RAZORPAY'S OWN backdrop layer (distinct from
   * PACT's own dimmed backdrop below) to a dark tone so the two don't
   * visually seam. The checkout card's own interior — the payment
   * method list/card-entry form — is Razorpay-controlled cross-origin
   * content and is not reachable or restyled by either option; see this
   * file's own investigation notes.
   */
  theme?: { color?: string; backdrop_color?: string };
}

interface RazorpayCheckoutInstance {
  open: () => void;
  on: (event: "payment.failed", handler: (response: RazorpayCheckoutFailedResponse) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => RazorpayCheckoutInstance;
  }
}

let checkoutScriptPromise: Promise<void> | null = null;

/** Loads checkout.js from Razorpay's own CDN exactly once per page load — never self-hosted, never loaded until a real "Pay Now"/"Retry" click actually needs it. */
function loadRazorpayCheckoutScript(): Promise<void> {
  if (typeof window !== "undefined" && window.Razorpay) return Promise.resolve();
  if (checkoutScriptPromise) return checkoutScriptPromise;
  checkoutScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Razorpay Checkout."));
    document.body.appendChild(script);
  });
  return checkoutScriptPromise;
}

type PanelPhase = "idle" | "starting" | "awaiting_checkout" | "verifying" | "error";

interface PaymentPanelProps {
  agreementId: string;
  productName: string;
  /**
   * Real, already-known agreement terms — passed straight through from
   * AgreementFocal's own PersistedAgreementDTO (NegotiationDemo.tsx),
   * never re-fetched here. Optional purely so this panel stays usable
   * anywhere that context isn't available; when present, they drive the
   * "Secure payment" transition card's real quantity/unit-price/total
   * line — never fabricated, never derived from the Razorpay order
   * (which only carries the total in paise, no quantity/unit breakdown).
   */
  quantity?: number;
  unitPrice?: number;
  totalAmount?: number;
  /** Presentation-only: resets NegotiationDemo's local UI state so a settled deal doesn't strand the user — see NegotiationDemo.tsx's own handleStartOver. Optional so this panel stays usable anywhere a "start over" concept doesn't apply. */
  onStartOver?: () => void;
}

export function PaymentPanel({ agreementId, productName, quantity, unitPrice, totalAmount, onStartOver }: PaymentPanelProps) {
  const [status, setStatus] = useState<PaymentStatusResponseDTO | null>(null);
  const [phase, setPhase] = useState<PanelPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const response = await fetch(`/api/agreements/${agreementId}/payment`);
    if (response.ok) {
      setStatus((await response.json()) as PaymentStatusResponseDTO);
    }
  }, [agreementId]);

  // Fetch-on-mount, with a cancellation guard so a stale response (e.g.
  // from an agreementId that changed before this request resolved) never
  // overwrites newer state — the standard safe shape for an effect whose
  // job is "load once and sync into local state," not a race with
  // itself.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const response = await fetch(`/api/agreements/${agreementId}/payment`);
      if (!cancelled && response.ok) {
        setStatus((await response.json()) as PaymentStatusResponseDTO);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [agreementId]);

  // Preloads checkout.js as soon as this panel exists (an Agreement
  // already does), rather than only on the first "Pay Now" click — pure
  // lifecycle timing, not a change to what gets loaded or how Checkout
  // itself is configured. Removes the only realistic window in which a
  // slow/first-time script fetch could delay `.open()` actually
  // presenting the overlay. Best-effort: a failure here is silently
  // retried by runCheckout's own loadRazorpayCheckoutScript call when a
  // real click happens, which still surfaces its own error state.
  useEffect(() => {
    loadRazorpayCheckoutScript().catch(() => {
      // Ignored here — see comment above.
    });
  }, []);

  // Razorpay's Standard Checkout already renders its own iframe overlay
  // (appended to document.body with a very high z-index) the instant
  // `.open()` is called below — this never navigates the page. What it
  // does NOT do on its own is guarantee the page behind it visibly reads
  // as "the same PACT negotiation screen, dimmed underneath a modal"
  // rather than "something else happened" — so this panel now renders
  // its own explicit dimmed backdrop (see the JSX below) and locks page
  // scroll for exactly the lifetime of that overlay, keyed off the same
  // `phase` state machine `runCheckout` already drives. No payment
  // logic, order data, or Checkout option changes anywhere in this
  // effect — purely a same-page presentation guarantee.
  useEffect(() => {
    // Redesign: also locks during "starting" (the order-creation network
    // round trip right after clicking Pay Now), not just once Checkout is
    // actually open — closes the brief plain-page gap between clicking
    // and Checkout appearing that previously showed no dimming at all.
    if (phase !== "starting" && phase !== "awaiting_checkout") return;
    document.body.style.overflow = "hidden";
    // Deliberately restores to "" (this app's own true rest state — see
    // globals.css/layout.tsx, nothing else in this codebase ever sets
    // body.style.overflow) rather than a captured "previous value".
    // Capturing-and-restoring is the textbook footgun here: React 19's
    // Strict Mode double-invokes this effect in development
    // (setup -> cleanup -> setup again) on the SAME phase transition, so
    // a second invocation's "previous value" would read back whatever
    // the FIRST invocation just set ("hidden") instead of the real
    // original — leaving the page permanently scroll-locked after a
    // real dismiss, confirmed live via Razorpay's own "Yes, exit" flow.
    return () => {
      document.body.style.overflow = "";
    };
  }, [phase]);

  const submitVerification = useCallback(
    async (body: VerifyRequestBody) => {
      setPhase("verifying");
      try {
        const response = await fetch(`/api/agreements/${agreementId}/payment/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const err = (await response.json()) as { error?: string };
          setErrorMessage(err.error ?? "Could not verify the payment.");
          setPhase("error");
          return;
        }
        setPhase("idle");
        await refreshStatus();
      } catch {
        setErrorMessage("Could not verify the payment.");
        setPhase("error");
      }
    },
    [agreementId, refreshStatus],
  );

  // M13.2 — reports a REAL Checkout `payment.failed` event purely for
  // audit/diagnostics. Deliberately NOT routed through submitVerification:
  // it must never set `phase` to "error"/"verifying", never touch
  // `errorMessage`, and never refresh status as if something changed —
  // nothing did. Best-effort and silent on failure (a network hiccup
  // recording a decline must never disrupt an otherwise still-open
  // Checkout session, e.g. Razorpay's own native in-modal retry).
  const submitFailureReport = useCallback(
    async (body: FailureReportRequestBody) => {
      try {
        await fetch(`/api/agreements/${agreementId}/payment/report-failure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        // Best-effort — see comment above.
      }
    },
    [agreementId],
  );

  const runCheckout = useCallback(
    async (order: PaymentOrderResponseDTO) => {
      setPhase("awaiting_checkout");

      if (order.mockForceOutcome) {
        // Demo-safe mock path (Milestone 13 §16) — never opens real
        // Checkout.js. The success/failure decision was already made
        // server-side (order.mockForceOutcome); this only relays it
        // through the exact same /verify call a real checkout would use.
        await submitVerification(buildMockVerifyRequestBody(order));
        return;
      }

      try {
        await loadRazorpayCheckoutScript();
      } catch {
        // The PaymentAttempt the server already created/returned
        // (order.razorpayOrderId) is left completely untouched — no
        // status change, no new attempt. `status` was already refreshed
        // by the caller before this function ran, so it already reflects
        // that attempt; the next "Retry"/"Resume" click will correctly
        // resume the SAME unresolved attempt (see recoveryService.ts's
        // own resume branch) rather than create a new one.
        setErrorMessage("Could not load the payment checkout. Please try again.");
        setPhase("error");
        return;
      }

      if (!window.Razorpay) {
        setErrorMessage("Payment checkout is unavailable.");
        setPhase("error");
        return;
      }

      // M13.1: the real-provider hardening fix — a synchronous exception
      // from the Razorpay SDK itself (constructing the instance, or
      // .open()) previously propagated uncaught out of this function,
      // only ever surfacing as the OUTER caller's generic "Could not
      // start the payment/recovery." message, with no chance to preserve
      // context. Caught here instead, with the real SDK message
      // preserved where available — and, same as the script-load
      // failure above, nothing about the attempt/Agreement state is
      // touched: it stays exactly as the server already has it,
      // resumable on the next click.
      try {
        // M13.2 — Razorpay's Checkout `retry` option defaults to enabled
        // and is deliberately never overridden here (see this file's own
        // constraint: PACT relies on Razorpay's own native in-modal
        // retry UX). That means after a decline the modal stays open and
        // THIS SAME `handler` callback may still receive a later,
        // genuinely successful payment against the SAME order_id — so
        // `payment.failed` below must never terminalize anything; only a
        // real `handler` success (verified server-side) or an
        // authoritative webhook may ever resolve the attempt.
        const checkout = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.razorpayOrderId,
          name: "PACT",
          description: productName,
          handler: (response) => {
            void submitVerification(buildCheckoutSuccessRequestBody(response));
          },
          // Presentation-only Standard Checkout config — see this option's
          // own doc comment above. Not an order/amount/handler change.
          theme: { color: "#c98f4f", backdrop_color: "rgba(10, 10, 12, 0.92)" },
          modal: {
            ondismiss: () => {
              // The modal actually closed (success, the user closed it
              // manually, or Razorpay's own retry was exhausted) — refresh
              // status so the UI reflects whatever the real current state
              // is (it may already be resolved via the handler above, or
              // still genuinely unresolved — see this file's own header
              // comment on why an unresolved attempt is never invented
              // into a terminal failure here).
              setPhase("idle");
              void refreshStatus();
            },
          },
        });
        checkout.on("payment.failed", (response) => {
          // Informational/audit-only — see this function's own comment
          // above. Deliberately does NOT call submitVerification: doing
          // so was the exact real-provider bug this milestone fixes (a
          // single decline terminalizing the attempt while Checkout's own
          // retry was still open, so a later genuine success could no
          // longer find an unresolved attempt to resolve).
          void submitFailureReport(
            buildFailureReportRequestBody(
              order.razorpayOrderId,
              response.error?.code,
              response.error?.description,
              response.error?.metadata?.payment_id,
            ),
          );
        });
        checkout.open();
      } catch (error) {
        setErrorMessage(
          error instanceof Error && error.message
            ? `Could not open the payment checkout: ${error.message}`
            : "Could not open the payment checkout. Please try again.",
        );
        setPhase("error");
      }
    },
    [productName, submitVerification, submitFailureReport, refreshStatus],
  );

  async function handlePayNow() {
    setErrorMessage(null);
    setPhase("starting");
    try {
      const response = await fetch(`/api/agreements/${agreementId}/payment/order`, { method: "POST" });
      if (!response.ok) {
        const err = (await response.json()) as { error?: string };
        setErrorMessage(err.error ?? "Could not start the payment.");
        setPhase("error");
        return;
      }
      const order = (await response.json()) as PaymentOrderResponseDTO;
      // M13.1: refresh server-authoritative status BEFORE opening
      // Checkout, so `status` already reflects the real attempt this
      // order belongs to — never stale — regardless of what happens
      // next inside the (third-party, unpredictable) Checkout modal.
      await refreshStatus();
      await runCheckout(order);
    } catch {
      setErrorMessage("Could not start the payment.");
      setPhase("error");
    }
  }

  async function handleRetry() {
    setErrorMessage(null);
    setPhase("starting");
    try {
      const response = await fetch(`/api/agreements/${agreementId}/payment/recover`, { method: "POST" });
      if (!response.ok) {
        const err = (await response.json()) as { error?: string };
        setErrorMessage(err.error ?? "Could not start recovery.");
        setPhase("error");
        return;
      }
      const order = (await response.json()) as PaymentOrderResponseDTO;
      // Same reasoning as handlePayNow — this is the fix for the
      // real-provider finding: previously `status` stayed stuck showing
      // attempt #1's stale "failed" state throughout the entire recovery
      // Checkout interaction, since nothing refreshed it until a /verify
      // call succeeded (which, per the observed real failure, never
      // happened). Now the UI immediately reflects that attempt #2
      // exists (isRecovery=true, status="created") before Checkout even
      // opens — including when this call resumed an already-open
      // attempt rather than creating a new one (see recoveryService.ts).
      await refreshStatus();
      await runCheckout(order);
    } catch {
      setErrorMessage("Could not start recovery.");
      setPhase("error");
    }
  }

  if (!status) {
    return null;
  }

  const busy = phase === "starting" || phase === "awaiting_checkout" || phase === "verifying";
  const latestAttempt = status.attempts[status.attempts.length - 1];
  const busyLabel = phase === "verifying" ? "Verifying…" : "Starting…";
  // M13.1 (extended by M13.2): an unresolved (status="created") attempt
  // — a Checkout session that never completed its round trip back to
  // /verify (closed/abandoned, a page refresh, or Razorpay's own native
  // retry declined more than once before the user gave up) while the
  // payment may still genuinely resolve — is a RESUMABLE attempt, not a
  // dead end. Whichever button is currently visible ("Pay Now" while the
  // Agreement is still "pending_payment" — attempt #1's own case, since
  // M13.2 no longer terminalizes it to "failed" from a mere decline — or
  // "Retry payment" once the Agreement genuinely IS "failed") calls the
  // SAME endpoint (.../order or .../recover respectively) that already
  // idempotently resumes this exact attempt/order rather than creating a
  // new one (see createOrderForAgreement / recoveryService.ts). This flag
  // only controls the LABEL shown, never which endpoint is called.
  // `currentRazorpayOrderId` (already returned by GET .../payment) is
  // what confirms there is a real, specific order to resume, rather than
  // inferring purely from the attempt list shape.
  const isResumable = latestAttempt?.status === "created" && status.currentRazorpayOrderId !== null;

  const isSettled = status.agreementStatus === "paid" || status.agreementStatus === "recovered";

  // Our own explicit dimmed overlay, present from the moment "Pay Now" is
  // clicked (phase "starting" — the order-creation round trip) through
  // the lifetime of Razorpay's real Checkout ("awaiting_checkout") — see
  // the scroll-lock effect above for why both phases are covered. z-40
  // sits below Razorpay's own (~2147483647) iframe container so its
  // modal always renders on top of this dim layer — confirmed live via
  // direct DOM inspection (see this file's own investigation notes) —
  // which sits above the rest of the negotiation page.
  //
  // The richer "Secure payment" card below is deliberately shown ONLY
  // during "starting": that's the one window where PACT's own backdrop
  // is actually the thing on screen (before Razorpay's real, full-
  // viewport iframe opens and covers it). Once "awaiting_checkout"
  // begins, this renders nothing but the plain dim layer — Razorpay's
  // real checkout is the payment surface at that point, and duplicating
  // any of its own form/copy would be misleading given it already fully
  // occludes this backdrop.
  const checkoutBackdrop = (phase === "starting" || phase === "awaiting_checkout") && (
    <div aria-hidden className="animate-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-[2px]">
      {phase === "starting" && (
        <div className="mx-4 flex w-full max-w-xs flex-col gap-4 rounded-2xl border border-border bg-surface p-6 text-center">
          <p className="text-[11px] font-semibold tracking-widest text-accent uppercase">Secure payment</p>
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted">Your agreement is ready.</p>
            <p className="text-base font-medium text-foreground">{productName}</p>
            {quantity !== undefined && unitPrice !== undefined && (
              <p className="tabular-nums text-sm text-muted">
                {quantity} × {formatInr(unitPrice)}
              </p>
            )}
          </div>
          {totalAmount !== undefined && (
            <div className="border-t border-border pt-3">
              <p className="text-xs text-muted">Total</p>
              <p className="tabular-nums text-2xl font-semibold text-foreground">{formatInr(totalAmount)}</p>
            </div>
          )}
          <p className="flex items-center justify-center gap-2 text-sm font-medium text-foreground/80">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Opening secure checkout…
          </p>
          <div className="border-t border-border pt-3">
            <p className="text-xs text-muted">Protected by Razorpay</p>
          </div>
        </div>
      )}
    </div>
  );

  if (isSettled) {
    return (
      <div className="animate-fade-in flex flex-col gap-4 rounded-xl border border-emerald-500/25 bg-emerald-400/[.05] p-5">
        <div>
          <p className="text-xs font-semibold tracking-widest text-emerald-300 uppercase">Transaction complete</p>
          <p className="mt-1 text-lg font-medium text-foreground">Payment complete.</p>
        </div>

        {/* Real order context — the same quantity/unitPrice/totalAmount
            AgreementFocal already threads through as props, never
            re-fetched or recomputed here. Absent entirely (rather than
            showing "—") when a caller doesn't supply them, same as the
            "starting" transition card above. */}
        {(productName || (quantity !== undefined && unitPrice !== undefined) || totalAmount !== undefined) && (
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-emerald-500/20 pb-4">
            <div className="flex flex-col gap-1">
              {productName && <p className="text-sm font-medium text-foreground">{productName}</p>}
              {quantity !== undefined && unitPrice !== undefined && (
                <p className="tabular-nums text-sm text-muted">
                  {quantity} × {formatInr(unitPrice)}
                </p>
              )}
            </div>
            {totalAmount !== undefined && (
              <p className="tabular-nums text-2xl font-semibold text-emerald-300">{formatInr(totalAmount)}</p>
            )}
          </div>
        )}

        <ul className="flex flex-col gap-1.5 text-sm text-foreground">
          <li className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span> Agreement
          </li>
          <li className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span> Payment
          </li>
          <li className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span> Audit trail
          </li>
        </ul>

        <div className="flex flex-wrap items-center gap-4 border-t border-emerald-500/20 pt-3">
          <a
            href="#audit-trail"
            className="text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            View audit trail ↓
          </a>
          {onStartOver && (
            <button
              type="button"
              onClick={onStartOver}
              className="text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              Start new negotiation
            </button>
          )}
        </div>
      </div>
    );
  }

  // Shown when the user has returned here having genuinely attempted
  // payment before (a real PaymentAttempt exists — status="created" from
  // a dismissed/abandoned Checkout, or "failed") and isn't mid-action
  // right now. Not a new payment state: `status`/`totalAmount` are the
  // exact same real, already-fetched values the row below already uses
  // — this is presentation only, making the "you're returning from
  // checkout, the agreement is still here" moment legible rather than
  // silently reappearing identical to the very first "Pay Now" view.
  const returnedFromAttempt = latestAttempt && !busy && (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-xs font-semibold tracking-widest text-muted uppercase">Payment not completed</p>
        <p className="text-xs text-muted">Your agreement is still active.</p>
      </div>
      {totalAmount !== undefined && (
        <p className="text-2xl font-semibold tabular-nums text-foreground">{formatInr(totalAmount)}</p>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      {checkoutBackdrop}
      {returnedFromAttempt}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{paymentStatusLabel(status.agreementStatus)}</span>
        {latestAttempt && (
          <span className="text-xs text-muted">
            {attemptProgressLabel(latestAttempt.attemptNumber, latestAttempt.isRecovery, status.maxAttempts)}
          </span>
        )}
      </div>

      {latestAttempt?.status === "failed" && (
        <p className="text-xs text-red-300">{paymentFailureLabel(latestAttempt.failureReason)}</p>
      )}
      {isResumable && (
        <p className="text-xs text-amber-300">
          A previous payment attempt is still open — resuming it rather than starting a new one.
        </p>
      )}
      {errorMessage && <p className="text-xs text-red-300">{errorMessage}</p>}

      {status.agreementStatus === "pending_payment" && (
        <button
          type="button"
          onClick={() => void handlePayNow()}
          disabled={busy}
          className="flex h-11 w-fit items-center justify-center rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition-colors hover:brightness-110 disabled:opacity-60"
        >
          {busy ? busyLabel : isResumable ? "Resume payment" : "Pay Now"}
        </button>
      )}

      {status.agreementStatus === "failed" && status.recoveryAvailable && (
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={busy}
          className="flex h-11 w-fit items-center justify-center rounded-full bg-amber-500 px-6 text-sm font-medium text-black transition hover:bg-amber-400 disabled:opacity-60"
        >
          {busy ? busyLabel : isResumable ? "Resume payment" : "Retry payment"}
        </button>
      )}

      {status.agreementStatus === "failed" && !status.recoveryAvailable && (
        <p className="text-xs text-red-300">Payment could not be completed after {status.maxAttempts} attempts.</p>
      )}
    </div>
  );
}
