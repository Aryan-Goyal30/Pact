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

## Current status: Phase 1 — foundation

This phase only sets up the application skeleton: framework, styling,
database schema, and a read-only merchant dashboard. No agents, no LLM
calls, no Razorpay integration, and no negotiation logic exist yet — those
are later phases.

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
    page.tsx          Landing page
    dashboard/        Read-only merchant dashboard (merchant info + catalog)
  lib/
    prisma.ts          Prisma client singleton (SQLite driver adapter)
  generated/prisma/    Generated Prisma client (gitignored, not committed)
```

## Data model

Defined in [`prisma/schema.prisma`](prisma/schema.prisma):

- **Merchant** — single-row profile: name, delivery/return policy text,
  whether negotiation is enabled
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
npx prisma studio     # browse the local SQLite database
npx prisma db seed    # re-seed demo data
```
