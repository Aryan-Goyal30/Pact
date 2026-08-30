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
}

export function PaymentPanel({ agreementId, productName }: PaymentPanelProps) {
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

  return (
    <div className="flex flex-col gap-3 border-t border-green-200 pt-4 dark:border-green-900/50">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-green-900 dark:text-green-200">
          {paymentStatusLabel(status.agreementStatus)}
        </span>
        {latestAttempt && (
          <span className="text-xs text-green-700/70 dark:text-green-400/70">
            {attemptProgressLabel(latestAttempt.attemptNumber, latestAttempt.isRecovery, status.maxAttempts)}
          </span>
        )}
      </div>

      {latestAttempt?.status === "failed" && (
        <p className="text-xs text-red-700 dark:text-red-400">{paymentFailureLabel(latestAttempt.failureReason)}</p>
      )}
      {isResumable && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          A previous payment attempt is still open — resuming it rather than starting a new one.
        </p>
      )}
      {errorMessage && <p className="text-xs text-red-700 dark:text-red-400">{errorMessage}</p>}

      {(status.agreementStatus === "paid" || status.agreementStatus === "recovered") && (
        <p className="text-sm font-medium text-green-800 dark:text-green-300">✓ Payment successful</p>
      )}

      {status.agreementStatus === "pending_payment" && (
        <button
          type="button"
          onClick={() => void handlePayNow()}
          disabled={busy}
          className="flex h-11 w-fit items-center justify-center rounded-full bg-green-700 px-6 text-sm font-medium text-white transition hover:bg-green-800 disabled:opacity-60 dark:bg-green-600 dark:hover:bg-green-500"
        >
          {busy ? busyLabel : isResumable ? "Resume payment" : "Pay Now"}
        </button>
      )}

      {status.agreementStatus === "failed" && status.recoveryAvailable && (
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={busy}
          className="flex h-11 w-fit items-center justify-center rounded-full bg-amber-600 px-6 text-sm font-medium text-white transition hover:bg-amber-700 disabled:opacity-60"
        >
          {busy ? busyLabel : isResumable ? "Resume payment" : "Retry payment"}
        </button>
      )}

      {status.agreementStatus === "failed" && !status.recoveryAvailable && (
        <p className="text-xs text-red-700 dark:text-red-400">
          Payment could not be completed after {status.maxAttempts} attempts.
        </p>
      )}
    </div>
  );
}
