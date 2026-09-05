"use client";

// Small client-only hooks shared across /negotiate's presentation
// components — extracted out of NegotiationDemo.tsx (where both already
// lived, used only by RoundRow) so BuyerConversation.tsx can reuse the
// exact same reveal/motion logic instead of duplicating it. No behavior
// change from the versions this replaces.

import { useEffect, useState } from "react";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReduced(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  return reduced;
}

/**
 * Presentation-only progressive reveal of an ALREADY-COMPLETE string —
 * never a fake backend stream. The full `text` is known synchronously
 * the instant this hook receives it; this only paces how many of its
 * characters are shown, via requestAnimationFrame. See RoundRow's
 * original use of this (NegotiationDemo.tsx) and BuyerConversation's
 * AgentMessage for the two current call sites.
 *
 * Every setState call lives inside a rAF callback, never directly in
 * the effect body (see react-hooks/set-state-in-effect).
 *
 * Race-safety: `state.source` records which exact string the current
 * `count` belongs to. If `text` changes while a reveal is mid-flight,
 * the effect's cleanup cancels the in-flight rAF (also covering
 * unmount) and a fresh effect run starts counting from 0 against the
 * NEW string — but render-time derivation below never trusts `state`
 * unless `state.source` still matches the CURRENT `text` prop, so even
 * the one-frame gap before that fresh run's first tick lands renders
 * empty rather than a stale character from a previous value.
 */
export function useTypewriterReveal(text: string | null, reduced: boolean): { text: string; complete: boolean } {
  const [state, setState] = useState<{ source: string | null; count: number }>({ source: null, count: 0 });

  useEffect(() => {
    let rafId: number | null = null;
    let cancelled = false;

    if (!text) {
      rafId = requestAnimationFrame(() => {
        if (!cancelled) setState({ source: null, count: 0 });
      });
    } else if (reduced) {
      // Reduced motion: no progressive reveal, no animation loop — the
      // complete real text renders as soon as this one deferred-to-next-
      // frame update lands (deferred only to keep the setState call
      // inside a callback rather than the effect body itself).
      rafId = requestAnimationFrame(() => {
        if (!cancelled) setState({ source: text, count: text.length });
      });
    } else {
      const length = text.length;
      // Fixed total-time budget, not a fixed per-character delay — a
      // short sentence still reveals briskly, and a long one speeds up
      // per-character to stay within the same short budget, never
      // making the user wait several seconds for a one-liner.
      const durationMs = Math.min(900, Math.max(220, length * 14));
      const startTime = performance.now();
      const tick = (now: number) => {
        if (cancelled) return;
        const progress = Math.min(1, (now - startTime) / durationMs);
        setState({ source: text, count: Math.ceil(progress * length) });
        if (progress < 1) {
          rafId = requestAnimationFrame(tick);
        }
      };
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [text, reduced]);

  const valid = text !== null && state.source === text;
  return {
    text: valid ? text.slice(0, state.count) : "",
    complete: text === null || (valid && state.count >= text.length),
  };
}
