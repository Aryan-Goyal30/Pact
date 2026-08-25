import { getPublicManifest } from "@/lib/manifest";

// GET /api/manifest — the AI-readable commerce layer a buyer agent reads
// before sending a structured requirement. Only ever returns the public
// DTO built by getPublicManifest(); never a raw database record.
export async function GET() {
  try {
    const manifest = await getPublicManifest();

    // Developer-only convenience: pretty-print in local dev so the
    // response is easy to read directly in a browser or curl, with no
    // separate inspection UI needed.
    const body =
      process.env.NODE_ENV === "development"
        ? JSON.stringify(manifest, null, 2)
        : JSON.stringify(manifest);

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Failed to build manifest:", error);
    return new Response(
      JSON.stringify({ error: "Manifest unavailable" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
