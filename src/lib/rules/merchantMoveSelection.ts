// Merchant strategic move selection — PACT V2 Milestone 9.
//
// Replaces the old hand-coded priority (quantity trade checked first,
// delivery trade only considered when quantity did NOT fire) with a
// genuine generate-then-compare decision, mirroring
// buyerMoveSelection.ts's SHAPE — never its scoring logic, which must
// stay asymmetric (see scoreMerchantCandidate below). merchantTradeEvaluator.ts,
// merchantDeliveryTradeEvaluator.ts, and merchantReciprocity.ts are all
// called completely UNCHANGED — this module is purely the new
// coordination layer.
//
// The merchant has no pre-existing "should I hold instead of concede"
// decision the way buyerMoveSelector.ts already gave the buyer — a HOLD
// candidate is introduced here for the first time. It is gated on stock
// scarcity (resolveMerchantStockPressure), NOT on merchantReciprocity.ts's
// behavior classification — reciprocity was tried first and found,
// empirically, to conflict with its own calibration (see the HOLD gate's
// comment below for the full explanation). Stock scarcity is a
// pre-existing, already-calibrated signal too (merchantTradeEvaluator.ts
// already leans on it to refuse bulk discounts under low stock), and one
// that never overlaps with reciprocity's per-round dynamics, so it does
// not fight Milestone 4's calibration. Like the buyer's HOLD, this is a
// real eligibility gate, not a price comparison: since HOLD (the
// merchant's own last, higher price) is virtually always the highest-
// priced candidate once available, letting it be UNCONDITIONALLY
// available would mean the merchant never concedes again — exactly the
// degenerate outcome this gate exists to prevent. This is also not a
// leverage-based gate (section 5 of the Milestone 9 spec explicitly
// forbids that) — stock pressure is a concrete situational condition of
// the merchant's own inventory, not a leverage score.

import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";
import {
  computeMerchantConcessionPrice,
  type MerchantConcessionContext,
  type NegotiationRequest,
} from "@/lib/rules/negotiationEngine";
import {
  hasQuantityLeverage,
  resolveDeliveryTrade,
  resolveMerchantStockPressure,
  resolveLeverageSpeedFactor,
} from "@/lib/rules/negotiationStrategy";
import { evaluateMerchantTrade } from "@/lib/rules/merchantTradeEvaluator";
import { evaluateMerchantDeliveryTrade } from "@/lib/rules/merchantDeliveryTradeEvaluator";
import { evaluateMerchantPackageTrade } from "@/lib/rules/merchantPackageTradeEvaluator";
import { evaluateBuyerReciprocity } from "@/lib/rules/merchantReciprocity";
import type { CandidateMove } from "@/lib/rules/candidateMove";

export interface MerchantCandidateResult {
  candidates: CandidateMove[];
  /** The delivery days the WINNING candidate should carry — always resolveDeliveryTrade's own clamped value, independent of which candidate wins (accepting a later date costs the merchant nothing, so every candidate is happy to honor it). */
  deliveryDays: number;
  /**
   * evaluateBuyerReciprocity's own explanatory reason, re-exposed here so
   * applyMerchantConcession can still include it in the final reasons
   * array exactly as it did before Milestone 9 — reciprocity itself is
   * unchanged, only its home moved into this coordinator.
   */
  reciprocityReason: string;
}

/**
 * Generates every currently-eligible merchant candidate. Always returns
 * at least one candidate (the ordinary concession, which
 * computeMerchantConcessionPrice always produces). The trade candidates
 * are only included when their existing eligibility signal (the same
 * quantityIncreasedFromPrior / deliveryIncreasedFromPrior diffs
 * merchantAgent.ts already computed pre-Milestone-9) says so, AND the
 * evaluator's own verdict is ACCEPT or COUNTER — a HOLD or REJECT
 * verdict from evaluateMerchantTrade/evaluateMerchantDeliveryTrade means
 * that dimension isn't worth engaging as a distinct move this round, so
 * no redundant candidate (duplicating the ordinary one) is added.
 *
 * Quantity and delivery trades are evaluated INDEPENDENTLY here — the
 * old `!tradeEvaluation && ...` mutual-exclusion guard is gone. In
 * practice at most one fires per round anyway (the buyer's own
 * comparator, buyerMoveSelection.ts, only ever moves one dimension at a
 * time), but if both signals were ever simultaneously true, genuine
 * price comparison (not a hard-coded priority) is what should decide
 * between them — a real improvement, not a regression risk, since the
 * comparison step is exactly this milestone's subject.
 */
export function generateMerchantCandidates(
  item: CatalogItemSnapshot,
  /** Caller (applyMerchantConcession) must have already confirmed `request.maxUnitPrice !== undefined` — this function only ever runs once a genuine price negotiation is in play, matching every existing call site's own precondition. */
  request: NegotiationRequest & { maxUnitPrice: number },
  concessionContext: MerchantConcessionContext,
  priorBuyerUnitPrice: number | null | undefined,
  previousBuyerQuantity: number | null | undefined,
  previousBuyerDeliveryDays: number | null | undefined,
  /**
   * Milestone 12 correction: the merchant's own actual, authoritative,
   * stock-capped quantity for THIS round — evaluateNegotiationRequest's
   * `decision.offeredQuantity` (negotiationEngine.ts's checkQuantityAvailable
   * already computed `min(request.quantity, item.availableQty)` before this
   * function was ever called). Used ONLY as the quantity fed into the
   * quantity-driven PRICING evaluators (evaluateMerchantTrade,
   * evaluateMerchantPackageTrade) and the quantity carried on their
   * resulting candidates — never as an eligibility signal. Eligibility
   * ("is a quantity trade even worth considering this round") stays keyed
   * on `request.quantity`/`quantityIncreasedFromPrior` exactly as before:
   * whether the buyer's ASK was large or genuinely increased is a
   * request-side question the merchant can answer regardless of what it
   * can actually supply. What the merchant should NOT do is PRICE a
   * discount as though it were granting the buyer's raw ask when partial
   * fulfillment means it can only ever grant `authorizedQuantity` —
   * that was the actual pricing-fidelity bug this parameter fixes. Never
   * affects the hard inventory cap itself (decision.offeredQuantity,
   * already computed and already authoritative before this function
   * runs) — this only makes the PRICE math consistent with it.
   */
  authorizedQuantity: number,
  /**
   * Negotiation Engine V2 — the SAME live buyer-vs-merchant leverage
   * (leverage.ts, itself completely unchanged) already computed once per
   * round by the orchestrator for the buyer's own decision this round,
   * simply also read here for the merchant's. Optional and additive:
   * omitted (or undefined), every price this function computes reduces
   * to exactly its pre-this-milestone value — leverageSpeedFactor
   * defaults to a no-op 1.0 (see computeMerchantConcessionPrice's own
   * doc comment) exactly like reciprocitySpeedMultiplier already does.
   * Deliberately NOT used to gate HOLD's own eligibility above (section
   * 5 of the original Milestone 9 spec explicitly forbids that, and
   * this redesign does not revisit it) — only the PRICE the ordinary
   * CONCEDE/blind-baseline candidates compute.
   */
  leverageScores?: { buyer: number; merchant: number },
): MerchantCandidateResult {
  const trade =
    request.deliveryDeadlineDays !== undefined
      ? resolveDeliveryTrade(item, request.deliveryDeadlineDays, request.deliveryFlexible ?? false)
      : { deliveryDays: item.standardDeliveryDays, discount: 0, traded: false };

  const reciprocity = evaluateBuyerReciprocity(request.maxUnitPrice, priorBuyerUnitPrice);
  const leverageSpeedFactor = leverageScores
    ? resolveLeverageSpeedFactor(leverageScores.merchant, leverageScores.buyer)
    : undefined;

  const baselineConcessionPrice = computeMerchantConcessionPrice(item, request.maxUnitPrice, {
    ...concessionContext,
    deliveryTradeDiscount: trade.discount,
    reciprocitySpeedMultiplier: reciprocity.speedMultiplier,
    leverageSpeedFactor,
  });

  const candidates: CandidateMove[] = [
    {
      move: "CONCEDE",
      unitPrice: baselineConcessionPrice,
      reason: `Countering with an adjusted unit price of ${baselineConcessionPrice} instead of the listed ${item.listedPrice}.`,
    },
  ];

  // HOLD: gated on stock scarcity (resolveMerchantStockPressure — a
  // static, per-item signal, already reused throughout this codebase to
  // justify merchant firmness), NOT on reciprocity. This was a real
  // finding from empirical testing, not an assumption: reciprocity's own
  // behavior classification (HELD/WITHDREW) is ALREADY expressed as a
  // CONTINUOUS speed-dampening multiplier baked into the ordinary
  // CONCEDE candidate (merchantReciprocity.ts, Milestone 4) — its own
  // docstring is explicit that even the most conservative case (WITHDREW)
  // "is NOT a hard freeze." Gating a discrete HOLD candidate on that same
  // signal — at ANY severity — silently overrides that calibration,
  // since HOLD's repeated price is always at least as high as any fresh
  // concession, confirmed directly against the Milestone 4 regression
  // suite. Stock scarcity is a genuinely independent, orthogonal signal:
  // a merchant with real inventory scarcity has its own, separate
  // grounds to hold firm on price — the exact same reasoning
  // merchantTradeEvaluator.ts already applies when refusing a bulk
  // discount under low stock pressure, just extended from "decline this
  // one trade" to "hold price in general."
  // Additionally requires the ordinary concession to still have real room
  // to move (i.e. it hasn't already been floor-clamped to item.minPrice).
  // Found empirically: without this, an extreme/unreasonable buyer ask
  // (one so low the ordinary concession is forced to the floor anyway)
  // let HOLD win with the merchant's stale, higher last-round price —
  // silently overriding the floor-driven counter that is meant to be the
  // negotiation's real bottom line. Holding is a genuine strategic
  // CHOICE among viable positions, not an escape hatch from being forced
  // to the floor; when the floor already IS the answer, countering there
  // (never simply refusing to move) is what "still counters rather than
  // caving outright" means throughout this codebase.
  //
  // Final-round correctness fix: also requires real rounds to remain
  // (roundsLeft > 2) — symmetric to decideBuyerConcessionMove's own
  // unconditional roundsLeft<=2 override (buyerMoveSelector.ts) and to
  // computeMerchantConcessionPrice's own roundsLeft<=2 branch
  // (negotiationEngine.ts), both of which force convergence toward the
  // buyer's ceiling once only the final two rounds remain. HOLD had no
  // equivalent override: it always repeats a price at least as high as
  // any fresh concession, so once eligible it would keep winning the
  // candidate comparison even after the ordinary CONCEDE candidate had
  // already been correctly forced all the way down to the buyer's
  // ceiling — silently defeating the guaranteed-convergence property
  // every other strategic overlay in this codebase already respects. A
  // read-only calibration audit found this produces real, reproducible
  // false EXPIRED (walk-away) outcomes: HOLD freezes at a price above
  // the buyer's reachable ceiling and is never released in time for
  // CONCEDE's own final-round convergence to close an otherwise-genuine
  // deal. roundsLeft is computed exactly like every other final-round
  // check in this codebase — never a new formula, and this is the only
  // new condition added; the stock-pressure signal, the floor-safety
  // check, and every other gate above are unchanged.
  const roundsLeft = Math.max(1, concessionContext.maxRounds - concessionContext.round + 1);
  //
  // Mutual-freeze correctness fix: also requires the buyer/merchant
  // reciprocity behavior computed above to not already be HELD. This
  // refines the "NOT on reciprocity" finding this gate's own comment
  // above describes — that finding is still correct as far as it goes
  // (reciprocity must never GATE HOLD's eligibility the way stock
  // scarcity does, and this remains true here), but a real breadth
  // investigation (2,340 real-orchestrator configurations) found a
  // second, distinct false-EXPIRED pattern the original gate didn't
  // cover: once HOLD repeats the merchant's own price for one round, the
  // buyer's ordinary CONCEDE formula (computeBuyerConcessionPrice) is
  // memoryless with respect to prior rounds — it recomputes the exact
  // same value from that now-frozen merchant offer, WITHOUT the buyer
  // ever needing to invoke its own HOLD branch. reciprocity.behavior is
  // already HELD at that exact point (the buyer's current ask already
  // equals its prior one — the same condition, already computed above
  // for the CONCEDE candidate), so the mutual freeze is detected and
  // released one round before arePositionsRepeated (walkAway.ts, itself
  // completely unchanged) would otherwise close the negotiation as a
  // false walk-away. Proven (same investigation) to resolve 254/254
  // real false-EXPIRED cases with zero effect on any of the 7 demo
  // presets and zero effect on genuine stalemates (cases where the
  // merchant has hit its real floor and/or a quantity shortfall cannot
  // be price-compensated still expire, unaffected — this condition only
  // ever removes a candidate, never changes what arePositionsRepeated
  // itself does). This also directly aligns HOLD with
  // merchantReciprocity.ts's own already-documented philosophy, quoted
  // above, that non-reciprocation should slow concession, never produce
  // a permanent hard freeze — HOLD compounded with itself was the one
  // place that philosophy was still being violated.
  if (
    roundsLeft > 2 &&
    reciprocity.behavior !== "HELD" &&
    resolveMerchantStockPressure(item) === "low" &&
    concessionContext.previousOfferUnitPrice !== undefined &&
    baselineConcessionPrice > item.minPrice
  ) {
    candidates.push({
      move: "HOLD",
      unitPrice: concessionContext.previousOfferUnitPrice,
      reason: "The buyer is not reciprocating, so the merchant holds its own position rather than conceding further.",
    });
  }

  const quantityIncreasedFromPrior =
    previousBuyerQuantity !== null &&
    previousBuyerQuantity !== undefined &&
    request.quantity > previousBuyerQuantity;

  if (hasQuantityLeverage(request.quantity) || quantityIncreasedFromPrior) {
    // Milestone 12 correction, refined: evaluateMerchantTrade's `quantity`
    // input is used for TWO different things internally — its own
    // hasQuantityLeverage(proposal.quantity) threshold gate (deciding
    // whether this ask is even large enough to be considered a bulk deal
    // at all, mirroring the OUTER gate immediately above) and, once past
    // that gate, the actual price formula, which depends only on
    // resolveMerchantStockPressure(item) — NEVER on the quantity number
    // itself. Substituting authorizedQuantity here was tried and found,
    // empirically, to be a real regression: it fed the STOCK-CAPPED
    // number into the THRESHOLD gate too, so a genuinely bulk-sized ask
    // against scarce stock (e.g. 300 requested, 15 fulfillable) stopped
    // being recognized as a bulk deal at all — silently downgrading a
    // correctly-calibrated HOLD ("inventory is limited, so the larger
    // order does not currently justify an additional discount") into a
    // misleading COUNTER ("the requested quantity is not large enough"),
    // which is simply false — the request WAS large; the merchant just
    // can't extend a bulk discount for it. So `request.quantity` stays
    // here, unchanged, exactly as before this correction: it is the
    // correct input for "is this being negotiated as a bulk deal," and,
    // per the formula above, provably has NO effect on the resulting
    // PRICE either way. Only the quantity actually RECORDED on the
    // resulting candidate (below) reflects what the merchant can really
    // offer — that field, not this evaluator input, was the fidelity
    // problem this correction fixes.
    const quantityEvaluation = evaluateMerchantTrade(
      item,
      { quantity: request.quantity, unitPrice: request.maxUnitPrice },
      { baselineConcessionPrice, hasGenuineIncrease: quantityIncreasedFromPrior },
    );
    if (quantityEvaluation.verdict === "ACCEPT" || quantityEvaluation.verdict === "COUNTER") {
      candidates.push({
        move: "QUANTITY_FOR_PRICE",
        unitPrice: quantityEvaluation.unitPrice,
        quantity: authorizedQuantity,
        reason: quantityEvaluation.reason,
      });
    } else {
      // HOLD/REJECT verdict: mirrors the delivery evaluator's own
      // else-branch immediately below — not a distinct trade move, but
      // its reason (e.g. "inventory is limited, so the larger order does
      // not currently justify an additional discount") still needs to
      // surface, exactly as it always did pre-Milestone-9. Its unitPrice
      // is the same quantity-blind baseline already in candidates[0], so
      // this is a reason-only merge in practice, not a price change.
      candidates[0] = {
        ...candidates[0],
        unitPrice: quantityEvaluation.unitPrice,
        reason: `${candidates[0].reason} ${quantityEvaluation.reason}`,
      };
    }
  }

  const deliveryIncreasedFromPrior =
    previousBuyerDeliveryDays !== null &&
    previousBuyerDeliveryDays !== undefined &&
    request.deliveryDeadlineDays !== undefined &&
    request.deliveryDeadlineDays > previousBuyerDeliveryDays &&
    (request.deliveryFlexible ?? false);

  if (deliveryIncreasedFromPrior) {
    // Evaluated against a DELIVERY-BLIND baseline (deliveryTradeDiscount
    // deliberately excluded) so this evaluator's own discount is the
    // complete delivery-driven adjustment, never stacked on the legacy
    // automatic formula already folded into baselineConcessionPrice above.
    const deliveryBlindBaseline = computeMerchantConcessionPrice(item, request.maxUnitPrice, {
      ...concessionContext,
      reciprocitySpeedMultiplier: reciprocity.speedMultiplier,
      leverageSpeedFactor,
    });
    const deliveryEvaluation = evaluateMerchantDeliveryTrade(
      item,
      { extraDays: trade.deliveryDays - item.standardDeliveryDays, unitPrice: request.maxUnitPrice },
      { baselineConcessionPrice: deliveryBlindBaseline },
    );
    if (deliveryEvaluation.verdict === "ACCEPT" || deliveryEvaluation.verdict === "COUNTER") {
      candidates.push({
        move: "DELIVERY_FOR_PRICE",
        unitPrice: deliveryEvaluation.unitPrice,
        deliveryDays: trade.deliveryDays,
        reason: deliveryEvaluation.reason,
      });
    } else {
      // HOLD/REJECT verdict: not worth flagging as its own distinct
      // trade move, but the evaluator still genuinely ran and decided
      // something — pre-Milestone-9 behavior always let its verdict
      // override the ordinary candidate's price too (never silently
      // falling back to the legacy, stock-blind per-day discount folded
      // into baselineConcessionPrice above), and always surfaced its
      // reason. Most visible for abundant stock (REJECT/HOLD with
      // discount withheld): the ordinary candidate must reflect "no real
      // operational value", not the legacy automatic delivery discount.
      candidates[0] = {
        ...candidates[0],
        unitPrice: deliveryEvaluation.unitPrice,
        reason: `${candidates[0].reason} ${deliveryEvaluation.reason}`,
      };
    }
  }

  // Milestone 12: the combined quantity+delivery package — evaluated as
  // ONE economic proposal (merchantPackageTradeEvaluator.ts), never by
  // calling evaluateMerchantTrade/evaluateMerchantDeliveryTrade above
  // and stacking their two independent outputs (see that module's own
  // header comment for why). Only recognized when BOTH dimensions
  // genuinely increased together in THIS SAME round
  // (quantityIncreasedFromPrior && deliveryIncreasedFromPrior) — a
  // deliberate, joint buyer move, never an absolute-bulk-threshold
  // shortcut (unlike the solo quantity trade's own hasQuantityLeverage
  // fallback) and never two coincidentally-unrelated single-dimension
  // signals from different rounds.
  if (quantityIncreasedFromPrior && deliveryIncreasedFromPrior) {
    // Genuinely blind to BOTH dimensions — neither solo evaluator's own
    // "blind" baseline above excludes both factors at once.
    const jointBlindBaseline = computeMerchantConcessionPrice(item, request.maxUnitPrice, {
      ...concessionContext,
      reciprocitySpeedMultiplier: reciprocity.speedMultiplier,
      leverageSpeedFactor,
    });
    // Milestone 12 correction: same discipline as the solo quantity
    // block above — eligibility (checked before this block) stays keyed
    // on the buyer's raw ask; PRICE evaluation uses authorizedQuantity
    // so the combined package's discount is sized to what the merchant
    // can actually deliver, not to a quantity that may exceed real stock.
    const packageEvaluation = evaluateMerchantPackageTrade(
      item,
      {
        quantity: authorizedQuantity,
        extraDays: trade.deliveryDays - item.standardDeliveryDays,
        unitPrice: request.maxUnitPrice,
      },
      { jointBlindBaselinePrice: jointBlindBaseline },
    );
    if (packageEvaluation.verdict === "ACCEPT" || packageEvaluation.verdict === "COUNTER") {
      candidates.push({
        move: "QUANTITY_AND_DELIVERY_FOR_PRICE",
        unitPrice: packageEvaluation.unitPrice,
        quantity: authorizedQuantity,
        deliveryDays: trade.deliveryDays,
        reason: packageEvaluation.reason,
      });
    }
    // HOLD/REJECT verdict: deliberately NOT merged into candidates[0]
    // here, unlike the two solo evaluators above — candidates[0] has
    // already potentially been overwritten by either or both of those,
    // and a package-level HOLD/REJECT reason merged on top would risk
    // an incoherent, triple-stacked reason string. The solo evaluators'
    // own reasons (already merged above, if applicable) remain
    // sufficient explanation when the combined form isn't worth it.
  }

  return { candidates, deliveryDays: trade.deliveryDays, reciprocityReason: reciprocity.reason };
}

/**
 * The merchant's objective — higher is better, the exact opposite of
 * scoreBuyerCandidate. A separate, explicit function (not a shared
 * "invert the buyer's score" trick) so the merchant's own asymmetric
 * objective stays plainly visible at the call site, per the Milestone 9
 * requirement that candidate quality must never be mirrored between
 * sides. Introduced in Milestone 9; RETAINED here, unused by
 * selectBestMerchantCandidate itself, purely so
 * merchantMoveSelection.oldVsNew.test.ts can reconstruct exactly
 * Milestone 9/10's two-tier selection (below, via isTradeCandidate) and
 * prove Milestone 11's package comparator (compareMerchantPackages) is
 * behaviorally equivalent to it.
 */
export function scoreMerchantCandidate(candidate: CandidateMove): number {
  return candidate.unitPrice;
}

/**
 * Exported (Milestone 11) so the old-vs-new regression test can
 * reconstruct the pre-Milestone-11 two-tier filter+reduce selection
 * exactly, using the SAME trade/non-trade classification
 * compareMerchantPackages now uses internally — never a second,
 * independently-drifting definition of "is this a trade."
 */
export function isTradeCandidate(candidate: CandidateMove): boolean {
  return (
    candidate.move === "QUANTITY_FOR_PRICE" ||
    candidate.move === "DELIVERY_FOR_PRICE" ||
    // Milestone 12: the combined package is a trade too — its own
    // evaluator (merchantPackageTradeEvaluator.ts) already vetted it as
    // ACCEPT/COUNTER before it was ever added as a candidate, exactly
    // like the two solo trades. Without this, the combined candidate
    // would be misclassified into the non-trade tier and lose the
    // trade-tier's unconditional priority — this is the one place
    // recognizing the new move type is required for correctness; the
    // comparison ALGORITHM itself (compareMerchantPackages, below) is
    // unchanged.
    candidate.move === "QUANTITY_AND_DELIVERY_FOR_PRICE"
  );
}

/**
 * Milestone 11: package/deal-value comparison — PACT V2, merchant side.
 *
 * Preserves the EXACT asymmetric two-tier structure Milestone 9 already
 * established (see the extensive rationale that used to live on
 * selectBestMerchantCandidate, now here) — restructured as an explicit
 * pairwise comparator instead of a filter+reduce, so it shares the same
 * SHAPE as compareBuyerPackages without sharing its content (the
 * Milestone 9 requirement that candidate quality must never be mirrored
 * between sides still holds: this file's tiers and their meaning are
 * entirely different from buyerMoveSelection.ts's):
 *
 *  1. Trade tier: an eligible trade (QUANTITY_FOR_PRICE / DELIVERY_FOR_PRICE
 *     — already vetted ACCEPT/COUNTER by its own evaluator) is preferred
 *     over HOLD/CONCEDE UNCONDITIONALLY, regardless of raw price. A
 *     trade's own resulting price is never higher than the ordinary
 *     baseline it was computed from (see both evaluators' COUNTER math),
 *     so comparing on price alone would make CONCEDE win by construction
 *     every time — exactly the bug Milestone 9 found and fixed.
 *  2. Unit price, only within the same tier — higher wins. This is where
 *     a genuine quantity-vs-delivery trade choice happens (both already
 *     represent "a price concession in exchange for something," a fair
 *     comparison), and where HOLD vs CONCEDE is decided (an
 *     apples-to-apples "how much to move on price alone" question).
 *
 * Deliberately NOT "maximize total order value" or "maximize unit price
 * alone" in any other shape — the current code already establishes only
 * this specific two-tier behavior, and this milestone preserves it
 * exactly rather than replacing it with something new (see the
 * Milestone 11 design review, section F: today's trade evaluators
 * already convert quantity/delivery value into their own candidate's
 * price, so raw price comparison within a tier is already a valid
 * package judgment — no additional dimension needs folding in here).
 *
 * Returns positive when `a` is preferred, negative when `b` is, 0 on an
 * exact tie (letting the caller's reduce() preserve the same
 * first-encountered tie-break the old filter+reduce implementation had).
 */
export function compareMerchantPackages(a: CandidateMove, b: CandidateMove): number {
  const tradeA = isTradeCandidate(a);
  const tradeB = isTradeCandidate(b);
  if (tradeA !== tradeB) {
    return tradeA ? 1 : -1; // an eligible trade is preferred over a non-trade, unconditionally
  }
  return a.unitPrice - b.unitPrice; // within the same tier, a higher price is preferred
}

/**
 * Selects the best candidate for the merchant via compareMerchantPackages.
 * Signature unchanged from Milestone 9/10 — every existing call site in
 * merchantAgent.ts is untouched by this milestone.
 */
export function selectBestMerchantCandidate(candidates: CandidateMove[]): CandidateMove {
  return candidates.reduce((best, candidate) =>
    compareMerchantPackages(candidate, best) > 0 ? candidate : best,
  );
}
