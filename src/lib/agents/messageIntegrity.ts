// Defensive validation for LLM-generated negotiation messages.
//
// Complements — does not replace — the prompt-level instructions in
// buyerAgent.ts / merchantAgent.ts. Even a well-instructed model can
// occasionally truncate a number, drop or swap a digit, or emit garbled
// text (observed in practice: "45,37" instead of "45,375", "10" instead
// of "100", "*** a Sentence"). Since price/quantity/delivery are real
// transaction data, the string actually shown to a user must never be
// trusted just because an LLM produced it — this module checks a
// generated message against the exact authoritative context it was
// given, and callers fall back to a deterministic, always-correct
// caption whenever the check fails.
//
// This never touches the structured decision itself (NegotiationResult
// / BuyerAction) — those are already fully decided by deterministic code
// before any LLM is called (see negotiationEngine.ts / buyerRules.ts).
// This module only gates which STRING is displayed alongside them.
//
// Deliberately does not import or modify anything under src/lib/llm/ —
// gemini.ts / provider.ts / claude.ts are untouched; this is purely a
// post-hoc check on the string those modules return.

const NUMBER_PATTERN = /\d[\d,]*\.?\d*/g;

/** Extracts every number-looking substring, stripped of thousands separators, as a plain number. */
function extractNumbers(text: string): number[] {
  const matches = text.match(NUMBER_PATTERN) ?? [];
  return matches.map((raw) => Number(raw.replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

const MIN_MESSAGE_LENGTH = 8;

/**
 * Catches empty/near-empty output and stray-symbol garbage (e.g. "***
 * a Sentence") that a numeric check alone wouldn't — a reject message
 * legitimately contains no numbers at all, so the numeric check can't be
 * the only line of defense.
 */
function looksGarbled(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_MESSAGE_LENGTH) return true;
  if (/[*#_~`]{2,}/.test(trimmed)) return true;
  const letters = (trimmed.match(/[a-zA-Z]/g) ?? []).length;
  return letters / trimmed.length < 0.35;
}

export interface MessageIntegrityResult {
  valid: boolean;
  /** Only present when invalid — for logging, never shown to a user. */
  reason?: string;
}

/**
 * Validates a generated agent message against the exact context it was
 * given.
 *
 * - `requiredNumbers`: values the message MUST state verbatim (e.g. the
 *   decided quantity/unitPrice/deliveryDays for this action). `null`/
 *   `undefined` entries are skipped, so callers can pass a fixed-shape
 *   array regardless of action type (e.g. a reject/rejection with no
 *   numeric terms).
 * - `context`: the exact object passed to generateAgentMessage. Every
 *   number found anywhere in it (via JSON.stringify) is the full set of
 *   numbers the message is allowed to mention — a message that states a
 *   number absent from that set is presumptively invented or corrupted
 *   (truncated, swapped, or hallucinated), so it fails the check.
 */
export function checkAgentMessageIntegrity(
  message: string,
  requiredNumbers: Array<number | null | undefined>,
  context: Record<string, unknown>,
): MessageIntegrityResult {
  if (looksGarbled(message)) {
    return { valid: false, reason: "Message is empty, too short, or contains stray symbol garbage." };
  }

  const messageNumbers = extractNumbers(message);
  const allowedNumbers = new Set(extractNumbers(JSON.stringify(context)));

  for (const num of messageNumbers) {
    if (!allowedNumbers.has(num)) {
      return {
        valid: false,
        reason: `Message contains "${num}", which does not appear anywhere in the authoritative context.`,
      };
    }
  }

  for (const required of requiredNumbers) {
    if (required === null || required === undefined) continue;
    if (!messageNumbers.includes(required)) {
      return { valid: false, reason: `Message is missing the required value "${required}".` };
    }
  }

  return { valid: true };
}
