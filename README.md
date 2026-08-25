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

## Current status: Phase 2 — AI-readable manifest + rule-engine foundation

Phase 1 set up the application skeleton. Phase 2 adds the public,
AI-readable commerce layer and the deterministic rules the future
negotiation agents will run on. No agents, no LLM calls, no Razorpay
integration, and no negotiation loop exist yet — those are later phases.

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
    dashboard/         Read-only merchant dashboard (merchant info + catalog)
    api/manifest/       GET /api/manifest — AI-readable public manifest
  lib/
    prisma.ts           Prisma client singleton (SQLite driver adapter)
    manifest.ts         Builds the public manifest DTO
    rules/
      catalogRules.ts    Deterministic fulfillment rules (pure, unit-tested)
      catalogRepository.ts  DB lookup (findCatalogItemBySku)
  types/
    manifest.ts          Public manifest response types
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

   `DATABASE_URL` is all that's needed for Phase 1. The `ANTHROPIC_API_KEY`
   and `RAZORPAY_KEY_*` placeholders are for later phases.

3. Apply the database schema and seed demo data:

   ```bash
   npx prisma migrate dev
   npx prisma db seed
   ```

4. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) and click through to
   `/dashboard` to see the seeded merchant and catalog.

## Useful commands

```bash
npm run dev      # start the dev server
npm run build    # production build
npm run lint     # ESLint
npm run test     # run the unit test suite (Vitest)
npx prisma studio     # browse the local SQLite database
npx prisma db seed    # re-seed demo data
```
