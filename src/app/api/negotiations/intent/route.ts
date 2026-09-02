import { getPublicManifest } from "@/lib/manifest";
import { parseBuyerIntent } from "@/lib/negotiation/buyerIntentParser";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /api/negotiations/intent — Natural-Language Buyer Intent
// (Roadmap Step 1). Takes free-form buyer text and returns a
// BuyerIntentParseResult (see buyerIntentParser.ts): either a fully
// resolved, validated BuyerIntent, or a report of what's missing/
// unclear. This is a pure understanding step — it never starts a
// negotiation and never touches NegotiationSession/AuditLog. The
// client is expected to map a successful result onto
// NegotiationSessionCreateRequest (buyerIntentToSessionRequest) and
// POST it to the existing, unmodified POST /api/negotiations, exactly
// as if a person had filled in the structured form by hand.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const text =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).text : undefined;
  if (typeof text !== "string" || text.trim().length === 0) {
    return jsonResponse({ error: "Expected { text: string }." }, 400);
  }

  try {
    const manifest = await getPublicManifest();
    const result = await parseBuyerIntent(text, manifest.products);
    return jsonResponse(result, 200);
  } catch (error) {
    console.error("Buyer intent parsing failed:", error);
    return jsonResponse({ error: "Could not process that request." }, 500);
  }
}
