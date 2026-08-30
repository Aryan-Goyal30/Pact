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
  buildMockVerifyRequestBody,
  buildReportedFailureRequestBody,
  paymentFailureLabel,
  paymentStatusLabel,
  type VerifyRequestBody,
} from "@/app/negotiate/paymentUi";

const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

interface RazorpayCheckoutHandlerResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayCheckoutFailedResponse {
  error?: { code?: string; description?: string };
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
        setErrorMessage("Could not load the payment checkout. Please try again.");
        setPhase("error");
        return;
      }

      if (!window.Razorpay) {
        setErrorMessage("Payment checkout is unavailable.");
        setPhase("error");
        return;
      }

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
          ondismiss: () => setPhase("idle"),
        },
      });
      checkout.on("payment.failed", (response) => {
        void submitVerification(buildReportedFailureRequestBody(order.razorpayOrderId, response.error?.code));
      });
      checkout.open();
    },
    [productName, submitVerification],
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
      await runCheckout((await response.json()) as PaymentOrderResponseDTO);
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
      await runCheckout((await response.json()) as PaymentOrderResponseDTO);
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
          {busy ? busyLabel : "Pay Now"}
        </button>
      )}

      {status.agreementStatus === "failed" && status.recoveryAvailable && (
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={busy}
          className="flex h-11 w-fit items-center justify-center rounded-full bg-amber-600 px-6 text-sm font-medium text-white transition hover:bg-amber-700 disabled:opacity-60"
        >
          {busy ? busyLabel : "Retry payment"}
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
