// Provider-agnostic Razorpay boundary — PACT V2 Milestone 13.
//
// Mirrors llm/provider.ts exactly:
//
//   paymentService.ts / recoveryService.ts -> PaymentProvider -> concrete provider
//
// This is the ONLY file that imports the `razorpay` SDK or uses `crypto`
// to compute a Razorpay signature. paymentService.ts, recoveryService.ts,
// and paymentRepository.ts never see the SDK, never see a raw Razorpay
// error object, and never compute a signature themselves — they only ever
// call the small interface below. mockRazorpayAdapter.ts (Milestone 13's
// demo-safe second implementation) is the exact counterpart to
// llm/claude.ts alongside llm/gemini.ts: same interface, same convention,
// no shared implementation.
//
// Deliberately NOT a generic multi-provider payment framework — exactly
// two operations, because those are the only two PACT actually needs
// (create an order server-side before Checkout; verify the signature
// Checkout hands back). Webhook signature verification is a separate,
// always-real, pure-crypto concern (see verifyWebhookSignature below) —
// it needs no network call and so is never part of the swappable
// interface; it's a standalone function every provider mode uses
// identically, keyed only on whichever webhook secret is configured.

import { randomUUID } from "node:crypto";
import { createHmac, timingSafeEqual } from "node:crypto";
// Type-only — the real SDK is loaded via a dynamic `import()` inside
// RealRazorpayProvider.getClient() below, so a missing/misconfigured
// `razorpay` install never breaks the mock-provider path at module-load
// time; this line contributes nothing to the compiled output.
import type RazorpaySdk from "razorpay";
// A live-binding circular import (mockRazorpayAdapter.ts imports this
// file's TYPES and generateMockOrderId back): safe in ESM because
// `mockRazorpayProvider` is only ever read inside getPaymentProvider's
// function body below, never at this file's own top-level/module-eval
// time — by the time getPaymentProvider() actually runs, both modules
// have finished initializing.
import { mockRazorpayProvider } from "@/lib/payment/mockRazorpayAdapter";

export interface CreateOrderInput {
  /** Razorpay's own amount unit — the currency subunit (paise for INR). Never rupees. See rupeesToPaise below; callers must never pass a rupee amount here. */
  amountPaise: number;
  currency: string;
  /** Razorpay's own "receipt" field — an opaque merchant-side reference. PACT always passes the Agreement id, so a Razorpay dashboard lookup can be traced back to one Agreement directly. */
  receipt: string;
}

export interface CreateOrderResult {
  /** Razorpay's own order id (e.g. "order_...") — persisted verbatim on PaymentAttempt.razorpayOrderId. */
  providerOrderId: string;
}

export interface VerifyCheckoutInput {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

/**
 * The small, closed set of Razorpay operations PACT actually needs.
 * Exactly two operations, deliberately — see this file's own header
 * comment for why a larger provider framework was not built.
 */
export interface PaymentProvider {
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  /** Pure, synchronous, no network call — HMAC-SHA256(orderId|paymentId) using the Key Secret, timing-safe compared against `signature`. */
  verifyCheckoutSignature(input: VerifyCheckoutInput): boolean;
}

/**
 * The ONE named helper for rupees -> paise (Razorpay's amount subunit for
 * INR), used everywhere an amount is sent to Razorpay. Never duplicated —
 * every call site in this codebase (paymentService.ts) imports this
 * function rather than re-deriving the multiplication inline.
 *
 * Math.round guards against floating-point drift (e.g. 45844 * 100 is
 * exact, but a totalAmount arising from a fractional pricePerUnit could
 * otherwise land a fraction of a paisa off) — Razorpay's Orders API
 * requires an integer amount; a non-integer would be rejected outright.
 */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/**
 * Verifies a Razorpay webhook's signature. Always real (never mocked —
 * see this file's own header comment): pure HMAC-SHA256 over the RAW
 * request body (never the parsed/re-serialized JSON, which is not
 * guaranteed to byte-for-byte match what Razorpay actually signed),
 * timing-safe compared against the `X-Razorpay-Signature` header value,
 * using RAZORPAY_WEBHOOK_SECRET — a distinct secret from RAZORPAY_KEY_SECRET,
 * never the same value (Razorpay issues webhook secrets separately, per
 * webhook endpoint, from the dashboard).
 */
export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  return safeCompareHex(computeHmacSha256Hex(rawBody, secret), signature);
}

function computeHmacSha256Hex(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Timing-safe hex-string comparison — never a plain `===`, which leaks timing information about how many leading characters matched. */
function safeCompareHex(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex ?? "", "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Thrown when RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not set and the
 * real provider was selected anyway. Distinct from a payment failure —
 * this is a configuration error, surfaced as a 500 by the API route, not
 * folded into the PaymentFailureReason taxonomy (which describes real
 * payment outcomes, not missing server config).
 */
export class MissingRazorpayCredentialsError extends Error {
  constructor() {
    super("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set. Add them to .env to enable real Razorpay payments.");
    this.name = "MissingRazorpayCredentialsError";
  }
}

/**
 * The real Razorpay-backed PaymentProvider. Uses the `razorpay` npm
 * package for order creation (a genuine network call to Razorpay's
 * Orders API) and Node's own `crypto` module for signature verification
 * (a pure local computation — deliberately NOT delegated to the SDK's own
 * `razorpay/dist/utils/razorpay-utils` deep-import helpers, which are an
 * internal subpath not guaranteed stable across SDK versions or exposed
 * under every module-resolution mode; HMAC-SHA256 is a standard,
 * unambiguous primitive this file can compute directly and test without
 * any SDK dependency at all).
 */
export class RealRazorpayProvider implements PaymentProvider {
  private client: RazorpaySdk | null = null;

  private async getClient(): Promise<RazorpaySdk> {
    if (this.client) return this.client;
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      throw new MissingRazorpayCredentialsError();
    }
    const { default: Razorpay } = await import("razorpay");
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    return this.client;
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const client = await this.getClient();
    const order = await client.orders.create({
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
    });
    return { providerOrderId: order.id };
  }

  verifyCheckoutSignature(input: VerifyCheckoutInput): boolean {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      throw new MissingRazorpayCredentialsError();
    }
    // Razorpay's own documented scheme: HMAC-SHA256("{order_id}|{payment_id}", key_secret).
    const payload = `${input.providerOrderId}|${input.providerPaymentId}`;
    return safeCompareHex(computeHmacSha256Hex(payload, keySecret), input.signature);
  }
}

export const realRazorpayProvider: PaymentProvider = new RealRazorpayProvider();

/**
 * Generates a structurally-plausible mock order id — used only by
 * mockRazorpayAdapter.ts. Lives here (not in that file) purely so
 * `randomUUID` has a single import site; the mock adapter itself still
 * owns every piece of actual mock BEHAVIOR (see that file).
 */
export function generateMockOrderId(): string {
  return `order_mock_${randomUUID().replace(/-/g, "")}`;
}

// ---------------------------------------------------------------------------
// Provider selection — mirrors llm/provider.ts's getLlmProvider() exactly.
// ---------------------------------------------------------------------------

/**
 * Returns the PaymentProvider PACT should use, selected by the
 * PAYMENT_PROVIDER env var ("razorpay" | "mock", case-insensitive;
 * defaults to "razorpay" — the safe default requires no special
 * configuration to accidentally activate). This is the single call site
 * paymentService.ts / recoveryService.ts go through — neither knows or
 * cares which concrete provider is selected.
 *
 * Production safety (explicit project requirement, not merely a default):
 * the mock provider can NEVER be selected when NODE_ENV === "production",
 * regardless of PAYMENT_PROVIDER's value — this check happens here, at
 * the one chokepoint every caller already goes through, rather than
 * being a convention callers must each remember to apply. There is no
 * query-parameter or request-body override anywhere in this codebase for
 * demo mode — it is exclusively a server env var, decided once at
 * process start, never per-request.
 */
export function getPaymentProvider(): PaymentProvider {
  const selected = (process.env.PAYMENT_PROVIDER ?? "razorpay").trim().toLowerCase();

  if (selected === "mock") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "PAYMENT_PROVIDER=mock is not permitted when NODE_ENV=production. Remove PAYMENT_PROVIDER or set it to \"razorpay\".",
      );
    }
    return mockRazorpayProvider;
  }

  if (selected !== "razorpay") {
    console.warn(`Unrecognized PAYMENT_PROVIDER "${process.env.PAYMENT_PROVIDER}" — falling back to razorpay.`);
  }
  return realRazorpayProvider;
}

/** True whenever the currently-selected provider is the mock one — used by paymentService.ts to decide whether to include the mock-only `mockForceOutcome` hint in an order-creation response. Never true in production (getPaymentProvider's own guard above). */
export function isMockProviderActive(): boolean {
  return (process.env.NODE_ENV !== "production") && (process.env.PAYMENT_PROVIDER ?? "razorpay").trim().toLowerCase() === "mock";
}
