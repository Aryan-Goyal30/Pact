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

## Current status: AI-to-AI negotiation demo UI

The full stack now works end to end: a Buyer Agent and a Merchant Agent
negotiate through a bounded, deterministic orchestrator, and that
negotiation is demonstrable through a web UI at `/negotiate`. Razorpay,
payments, recovery, authentication, and deployment are not implemented
yet.

### `/negotiate` — the negotiation demo

Shows the merchant/catalog (from the public manifest), a buyer request
form (product, quantity, max unit price, delivery deadline — defaults to
the seeded 200-laptop scenario), and the resulting turn-by-turn
transcript and final outcome (agreement details + a disabled "Proceed to
Payment" placeholder, or a rejection/expiry explanation). The page is a
thin Server Component (`src/app/negotiate/page.tsx`) fetching the public
manifest, plus a Client Component
([`NegotiationDemo.tsx`](src/app/negotiate/NegotiationDemo.tsx)) that
POSTs to `/api/negotiations` and renders whatever it returns — it never
computes a price, quantity, delivery day, or outcome itself.

### `POST /api/negotiations`

Runs a full bounded negotiation
([`runNegotiationToCompletion`](src/lib/negotiation/orchestrator.ts)) for
one buyer request and returns the transcript, final status
(`AGREED`/`REJECTED`/`EXPIRED`), and — when agreed — a computed agreement
summary. The response is built by
[`buildNegotiationRunResponse`](src/lib/negotiation/negotiationRunResponse.ts),
which whitelists fields the same way the public manifest does, so
`CatalogItem.minPrice` (used server-side by the rule engine) can never
reach the browser. This is the multi-round counterpart to the existing
single-shot `POST /api/negotiate`, which is unchanged.

### Buyer Agent, Merchant Agent, and the negotiation engine

- [`src/lib/rules/negotiationEngine.ts`](src/lib/rules/negotiationEngine.ts) —
  deterministic evaluation, price-floor enforcement, and the merchant's
  round-aware concession strategy (`computeMerchantConcessionPrice`):
  minPrice is a floor, not a target, so the merchant concedes gradually
  across rounds instead of caving as soon as an offer clears the floor.
- [`src/lib/rules/buyerRules.ts`](src/lib/rules/buyerRules.ts) — the
  buyer's own hard constraints (never exceed its max price/deadline).
- [`src/lib/agents/buyerAgent.ts`](src/lib/agents/buyerAgent.ts) /
  [`merchantAgent.ts`](src/lib/agents/merchantAgent.ts) — each agent
  decides its action deterministically first; an LLM (behind the
  provider-agnostic [`LlmProvider`](src/lib/llm/provider.ts) interface)
  only phrases that decision. If no `ANTHROPIC_API_KEY` is configured,
  both agents fall back to a plain-English caption built from the same
  real structured data instead of failing the negotiation.
- [`src/lib/negotiation/orchestrator.ts`](src/lib/negotiation/orchestrator.ts) —
  sequences one buyer→merchant turn at a time, bounded by
  [`negotiationState.ts`](src/lib/rules/negotiationState.ts)'s round
  limit; a negotiation only closes when the buyer explicitly accepts a
  specific offer.

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
    negotiate/         The negotiation demo UI (page.tsx + NegotiationDemo.tsx client component)
    api/
      manifest/         GET /api/manifest — AI-readable public manifest
      negotiate/         POST /api/negotiate — single-shot Merchant Agent call
      negotiations/      POST /api/negotiations — full bounded negotiation run
  lib/
    prisma.ts           Prisma client singleton (SQLite driver adapter)
    manifest.ts         Builds the public manifest DTO
    llm/
      provider.ts        Provider-agnostic LlmProvider interface
      claude.ts           Anthropic-backed implementation (only file importing the SDK)
      errors.ts           LlmUnavailableError (shared, avoids a provider/claude import cycle)
    agents/
      buyerAgent.ts        Deterministic action + LLM-phrased buyer message
      merchantAgent.ts     Deterministic decision + LLM-phrased merchant message
    negotiation/
      orchestrator.ts      Bounded buyer<->merchant turn sequencing
      protocol.ts           Shared StructuredNegotiationMessage type
      negotiationRunResponse.ts  Browser-safe DTO builder for /api/negotiations
    rules/
      catalogRules.ts       Deterministic fulfillment rules (pure, unit-tested)
      catalogRepository.ts  DB lookup (findCatalogItemBySku)
      negotiationEngine.ts  Negotiation evaluation + merchant concession strategy
      negotiationState.ts   Bounded round/status state machine
      buyerRules.ts          Buyer's own hard constraints
  types/
    manifest.ts          Public manifest response types
    negotiation.ts        Public /api/negotiations response types
  generated/prisma/    Generated Prisma client (gitignored, not committed)
```

## Data model

Defined in [`prisma/schema.prisma`](prisma/schema.prisma):

- **Merchant** — single-row profile: name, description, delivery/return
  policy text, whether negotiation is enabled
- **CatalogItem** — product with a public `listedPrice` and a private
  `minPrice` (the merchant's price floor — never to be exposed to a buyer
  agent, only used internally by the future rule engine)
- **NegotiationSession** — one buyer-initiated negotiation thread
- **NegotiationMessage** — one turn in a session (request / offer /
  counter-offer / accept / reject), with an `isValid` flag recording whether
  the rule engine accepted it
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
   negotiation demo — without `ANTHROPIC_API_KEY`, agent messages fall
   back to a deterministic plain-English caption instead of LLM prose;
   the negotiation itself (prices, quantities, delivery, outcome) is
   identical either way. Set `ANTHROPIC_API_KEY` to see real
   LLM-phrased messages. `RAZORPAY_KEY_*` is for a later phase.

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
