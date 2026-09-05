// Integration tests for POST /api/negotiations, focused on Pass 4's
// additive `budgetFlexible` field at this API boundary — same "real
// Prisma/SQLite" convention [id]/turn/route.test.ts already uses for
// this route family (parseCreateRequest is a private module function,
// not exported, so the only way to exercise its validation is through
// the real route handler). Exercises the real handler end to end;
// created sessions are cleaned up afterward.

import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";
import type { NegotiationSessionResponse } from "@/types/negotiation";

const LAPTOP_SKU = "LAPTOP-14-I5";
let sessionIdsToClean: string[] = [];

afterEach(async () => {
  for (const id of sessionIdsToClean) {
    await prisma.negotiationSession.deleteMany({ where: { id } });
  }
  sessionIdsToClean = [];
});

async function createSession(
  body: Record<string, unknown>,
): Promise<{ status: number; body: NegotiationSessionResponse & { error?: string } }> {
  const response = await POST(
    new Request("http://localhost/api/negotiations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const parsed = (await response.json()) as NegotiationSessionResponse & { error?: string };
  if (response.status === 201) {
    sessionIdsToClean.push(parsed.sessionId);
  }
  return { status: response.status, body: parsed };
}

const BASE_REQUEST = {
  sku: LAPTOP_SKU,
  quantity: 5,
  maxUnitPrice: 46000,
  deliveryDeadlineDays: 10,
};

describe("POST /api/negotiations — budgetFlexible", () => {
  it("accepts a request that omits budgetFlexible", async () => {
    const { status } = await createSession(BASE_REQUEST);
    expect(status).toBe(201);
  });

  it("accepts budgetFlexible: false", async () => {
    const { status } = await createSession({ ...BASE_REQUEST, budgetFlexible: false });
    expect(status).toBe(201);
  });

  it("accepts budgetFlexible: true", async () => {
    const { status } = await createSession({ ...BASE_REQUEST, budgetFlexible: true });
    expect(status).toBe(201);
  });

  it("rejects a non-boolean budgetFlexible", async () => {
    const { status, body } = await createSession({ ...BASE_REQUEST, budgetFlexible: "yes" });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  // CRITICAL: budgetFlexible must never relax maxUnitPrice's own
  // required/positive/finite validation — a flexible buyer still must
  // state a real number, it's just not treated as a hard ceiling later.
  it("still rejects a missing maxUnitPrice even when budgetFlexible is true", async () => {
    const { sku, quantity, deliveryDeadlineDays } = BASE_REQUEST;
    const { status } = await createSession({ sku, quantity, deliveryDeadlineDays, budgetFlexible: true });
    expect(status).toBe(400);
  });

  it("still rejects an invalid maxUnitPrice (<= 0) even when budgetFlexible is true", async () => {
    const { status } = await createSession({ ...BASE_REQUEST, maxUnitPrice: 0, budgetFlexible: true });
    expect(status).toBe(400);
  });
});
