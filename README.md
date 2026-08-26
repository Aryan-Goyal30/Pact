# PACT

PACT is a merchant-side agentic commerce system built for the Razorpay
Buildathon (Track 1: AI Growth & Agentic Commerce).

An AI buyer agent arrives with a structured requirement (product, quantity,
budget, delivery deadline). A merchant agent evaluates it against real
inventory and merchant-defined rules, and — instead of a flat accept/reject —
can make a bounded counter-offer (e.g. fewer units, a different price,
adjusted delivery). The two agents negotiate within explicit constraints,
reach a bounded agreement, and settle it through a Razorpay test-mode
payment, with a small controlled recovery flow if payment fails.

The hero feature is the negotiation itself. The AI-readable merchant layer
(catalog, policies, availability) exists to support that negotiation, and
payment/recovery is downstream of a valid agreement — not a separate demo.

## Architectural rule: LLM proposes, deterministic code disposes

An LLM may parse free-text intent, draft proposals, and write the
natural-language negotiation transcript. It never decides the numbers.
Plain code enforces prices, quantities, inventory, budgets, price floors,
delivery constraints, negotiation round limits, agreement validity, payment
state, and recovery state. An LLM-proposed action that violates a rule is
rejected before it becomes a real negotiation event.

## Current status: live, turn-based AI-to-AI negotiation

The full stack works end to end: a Buyer Agent and a Merchant Agent with
genuinely different, progressively-conceding pricing strategies negotiate
through a bounded orchestrator, one real HTTP turn at a time, demonstrable
through a web UI at `/negotiate`. Razorpay, payments, recovery,
authentication, and deployment are not implemented yet.

### `/negotiate` — the live negotiation demo

Shows the merchant/catalog (from the public manifest), a buyer request
form (product, quantity, max unit price, delivery deadline — defaults to
the seeded 200-laptop scenario), and the negotiation transcript appearing
turn by turn as it actually happens (not calculated up front and dumped
on screen) — round counter, current offers, and a final agreement card
(with a disabled "Proceed to Payment" placeholder) or failure reason. The
page is a thin Server Component (`src/app/negotiate/page.tsx`) fetching
the public manifest, plus a Client Component
([`NegotiationDemo.tsx`](src/app/negotiate/NegotiationDemo.tsx)) that
drives the turn-based API below and renders whatever it returns — it
never computes a price, quantity, delivery day, or outcome itself.

### Turn-based negotiation API

- **`POST /api/negotiations`** — creates a negotiation session (reusing
  the `NegotiationSession`/`NegotiationMessage` tables Phase 1 already
  defined for this) and returns its initial `OPEN` state. Executes no
  turn.
- **`POST /api/negotiations/:id/turn`** — advances one persisted session
  by exactly one buyer→merchant exchange via
  [`runNegotiationTurn`](src/lib/negotiation/orchestrator.ts), persists
  it, and returns that turn's structured messages + updated status. Call
  repeatedly until `status` is `AGREED`/`REJECTED`/`EXPIRED`.

Both routes build their responses through
[`negotiationRunResponse.ts`](src/lib/negotiation/negotiationRunResponse.ts)'s
whitelisting DTO helpers (the same pattern `manifest.ts` uses), so
`CatalogItem.minPrice` — used server-side by the rule engine via
[`negotiationSessionRepository.ts`](src/lib/negotiation/negotiationSessionRepository.ts) —
can never reach the browser. The older single-shot
`POST /api/negotiate` (one Merchant Agent call, no session) is unchanged
and still works.

### Buyer Agent, Merchant Agent, and the negotiation engine

Both sides have genuinely different objectives and move progressively —
neither reveals or holds at its hard limit from turn one:

- [`src/lib/rules/negotiationEngine.ts`](src/lib/rules/negotiationEngine.ts) —
  deterministic evaluation and the merchant's round-aware concession
  strategy (`computeMerchantConcessionPrice`): `minPrice` is a floor, not
  a target, so the merchant concedes gradually from its listed price
  instead of caving as soon as an offer clears the floor — and accepts
  outright (never above listed price) the moment a buyer's offer already
  fully satisfies it.
- [`src/lib/rules/buyerRules.ts`](src/lib/rules/buyerRules.ts) — the
  buyer's hard ceiling (`computeBuyerConcessionPrice`) plus an
  aspirational target it opens near instead of immediately revealing its
  maximum, moving toward the merchant's live offer each round.
- [`src/lib/agents/buyerAgent.ts`](src/lib/agents/buyerAgent.ts) /
  [`merchantAgent.ts`](src/lib/agents/merchantAgent.ts) — each agent
  decides its action deterministically first; an LLM (behind the
  provider-agnostic [`LlmProvider`](src/lib/llm/provider.ts) interface)
  only phrases that decision. If no API key is configured for the
  selected provider, both agents fall back to a plain-English caption
  built from the same real structured data instead of failing the
  negotiation.
- [`src/lib/negotiation/orchestrator.ts`](src/lib/negotiation/orchestrator.ts) —
  sequences one buyer→merchant turn at a time, bounded by
  [`negotiationState.ts`](src/lib/rules/negotiationState.ts)'s round
  limit; a negotiation only closes when a side explicitly accepts.

### LLM provider

`src/lib/llm/provider.ts` selects a provider via `LLM_PROVIDER` (`claude`
— default, or `gemini`); `claude.ts` and `gemini.ts` (`gemini-2.5-flash`,
via `@google/genai`) each implement the same `LlmProvider` interface and
are the only files importing their respective SDKs. Neither provider (nor
the buyer's LLM context in general) ever receives `minPrice`.

### `GET /api/manifest`

The AI-readable manifest a buyer agent reads before sending a structured
requirement. Returns merchant name/description, whether negotiation is
supported, public policies, and the catalog (SKU, name, description,
listed price, available quantity, standard/max delivery days, whether the
item is negotiable).

The response is built by [`getPublicManifest()`](src/lib/manifest.ts),
which explicitly whitelists each field onto the
[`PublicManifest`](src/types/manifest.ts) type rather than serializing
Prisma records — so `CatalogItem.minPrice` and any other private column
can't accidentally leak into it. In development the endpoint pretty-prints
its JSON so it's readable directly in a browser or via `curl`, with no
separate inspector UI.

### Deterministic catalog rules

[`src/lib/rules/catalogRules.ts`](src/lib/rules/catalogRules.ts) contains
pure, DB-free functions — `checkQuantityAvailable`,
`checkDeliveryAchievable`, `checkPriceAtOrAboveFloor`, and
`evaluateFulfillment` — that classify a buyer request against a catalog
item as `exact_fulfillment`, `partial_fulfillment`,
`price_adjustment_required`, or `impossible`. These are the functions a
future LLM-driven agent proposes to, and never the other way around: no
LLM decides a price, quantity, or delivery day here. See
[`catalogRules.test.ts`](src/lib/rules/catalogRules.test.ts) for coverage.
[`catalogRepository.ts`](src/lib/rules/catalogRepository.ts) holds the one
DB-touching function (`findCatalogItemBySku`), kept separate so the rule
logic itself stays pure and testable.

## Tech stack

- [Next.js](https://nextjs.org) (App Router, TypeScript) — single app, no
  microservices
- [Tailwind CSS](https://tailwindcss.com) for styling
- [Prisma](https://www.prisma.io) + SQLite for local development data

## Project structure

```
prisma/
  schema.prisma      Data model (see below)
  seed.ts             Seeds one demo merchant + a small catalog
src/
  app/
    page.tsx           Landing page
    dashboard/         Read-only merchant dashboard (merchant info + catalog, incl. minPrice)
    negotiate/         The live negotiation demo UI
      page.tsx            Server Component: catalog section
      NegotiationDemo.tsx  Client Component: form + turn-by-turn transcript
      negotiationUi.ts     Pure form-validation / status-label / badge helpers (unit-tested)
    api/
      manifest/                  GET /api/manifest — AI-readable public manifest
      negotiate/                  POST /api/negotiate — single-shot Merchant Agent call
      negotiations/                POST /api/negotiations — create a negotiation session
      negotiations/[id]/turn/      POST /api/negotiations/:id/turn — advance one turn
  lib/
    prisma.ts           Prisma client singleton (SQLite driver adapter)
    manifest.ts         Builds the public manifest DTO
    llm/
      provider.ts        Provider-agnostic LlmProvider interface + LLM_PROVIDER selection
      claude.ts           Anthropic implementation (only file importing that SDK)
      gemini.ts           Gemini implementation (only file importing that SDK)
      errors.ts           LlmUnavailableError (shared, avoids provider/claude/gemini import cycles)
    agents/
      buyerAgent.ts        Deterministic action + LLM-phrased buyer message
      merchantAgent.ts     Deterministic decision + LLM-phrased merchant message
    negotiation/
      orchestrator.ts               Bounded buyer<->merchant turn sequencing
      protocol.ts                    Shared StructuredNegotiationMessage type
      negotiationRunResponse.ts      Browser-safe DTO helpers (shared by both API routes)
      negotiationSessionRepository.ts  DB persistence for turn-based sessions
    rules/
      catalogRules.ts       Deterministic fulfillment rules (pure, unit-tested)
      catalogRepository.ts  DB lookup (findCatalogItemBySku)
      negotiationEngine.ts  Negotiation evaluation + merchant concession strategy
      negotiationState.ts   Bounded round/status state machine
      buyerRules.ts          Buyer's own hard constraints + concession strategy
  types/
    manifest.ts          Public manifest response types
    negotiation.ts        Public negotiation API request/response types
  generated/prisma/    Generated Prisma client (gitignored, not committed)
```

## Data model

Defined in [`prisma/schema.prisma`](prisma/schema.prisma):

- **Merchant** — single-row profile: name, description, delivery/return
  policy text, whether negotiation is enabled
- **CatalogItem** — product with a public `listedPrice` and a private
  `minPrice` (the merchant's price floor — never to be exposed to a buyer
  agent, only used internally by the future rule engine)
- **NegotiationSession** — one buyer-initiated negotiation thread,
  advanced one turn per `POST /api/negotiations/:id/turn` call; `sku` +
  `buyerRequestRaw` (JSON) reconstruct the negotiation context,
  `pendingMerchantResultRaw` (JSON) carries the merchant's outstanding
  offer between requests, and `status`/`roundCount`/`maxRounds` mirror
  `negotiationState.ts`'s state machine exactly
- **NegotiationMessage** — one side's message within a turn (request /
  offer / counter-offer / accept / reject), with an `isValid` flag
  recording whether the rule engine accepted it
- **Agreement** — the bounded terms both agents settled on; payment can only
  ever be created from a valid Agreement
- **PaymentAttempt** — one Razorpay payment try per agreement, with an
  `isRecovery` flag for the bounded retry/fallback attempt
- **AuditLog** — append-only event log (buyer request, evaluation, offers,
  validation results, agreement, payment attempts/results, recovery
  actions) — what makes PACT's money-related decisions explainable

These tables exist now so later phases have somewhere to write without a
schema rewrite. No negotiation, payment, or recovery logic is implemented
yet.

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

   `DATABASE_URL` is all that's required to run anything, including the
   negotiation demo — without an API key for the selected provider,
   agent messages fall back to a deterministic plain-English caption
   instead of LLM prose; the negotiation itself (prices, quantities,
   delivery, outcome) is identical either way. Set `LLM_PROVIDER=claude`
   (default) with `ANTHROPIC_API_KEY`, or `LLM_PROVIDER=gemini` with
   `GEMINI_API_KEY`, to see real LLM-phrased messages. `RAZORPAY_KEY_*`
   is for a later phase.

3. Apply the database schema and seed demo data:

   ```bash
   npx prisma migrate dev
   npx prisma db seed
   ```

4. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) — `/negotiate` runs
   the AI-to-AI negotiation demo (defaults to the seeded 200-laptop
   scenario), `/dashboard` shows the merchant's own view including the
   private `minPrice`.

## Useful commands

```bash
npm run dev      # start the dev server
npm run build    # production build
npm run lint     # ESLint
npm run test     # run the unit test suite (Vitest)
npx prisma studio     # browse the local SQLite database
npx prisma db seed    # re-seed demo data
```
