import Link from "next/link";
import { getPublicManifest } from "@/lib/manifest";
import { NegotiationDemo } from "./NegotiationDemo";
import { formatInr } from "./negotiationUi";

// Server Component: fetches the same PUBLIC manifest a real external
// buyer agent would read from GET /api/manifest (never the private
// CatalogItemSnapshot — no minPrice reaches this page or its HTML).
// The interactive negotiation form/transcript is a Client Component
// (NegotiationDemo) that POSTs to /api/negotiations.
export default async function NegotiatePage() {
  const manifest = await getPublicManifest();

  return (
    <div className="flex flex-1 flex-col gap-8 bg-zinc-50 px-6 py-10 dark:bg-black sm:px-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
              AI-to-AI negotiation demo
            </h1>
            <Link
              href="/dashboard"
              className="text-sm font-medium text-zinc-600 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              Merchant dashboard
            </Link>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            A Buyer Agent and this merchant&rsquo;s Merchant Agent negotiate
            through PACT&rsquo;s deterministic rule engine and orchestrator —
            every price, quantity, and delivery term below comes directly
            from that engine, not from the UI.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-medium text-black dark:text-zinc-50">
              {manifest.merchant.name}
            </h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {manifest.merchant.description}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              Negotiation:{" "}
              {manifest.merchant.negotiationSupported ? "supported" : "not supported"}
            </p>
          </div>

          <div className="overflow-x-auto rounded-lg border border-black/[.08] dark:border-white/[.145]">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-black/[.03] text-zinc-600 dark:bg-white/[.04] dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Listed price</th>
                  <th className="px-4 py-3 font-medium">Available qty</th>
                  <th className="px-4 py-3 font-medium">Standard delivery</th>
                  <th className="px-4 py-3 font-medium">Negotiable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[.06] dark:divide-white/[.08]">
                {manifest.products.map((product) => (
                  <tr key={product.sku}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">
                        {product.name}
                      </div>
                      <div className="text-zinc-500 dark:text-zinc-500">
                        {product.description}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-600 dark:text-zinc-400">
                      {product.sku}
                    </td>
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                      {formatInr(product.listedPrice)}
                    </td>
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                      {product.availableQuantity}
                    </td>
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                      {product.standardDeliveryDays} day(s)
                    </td>
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                      {product.negotiable ? "Yes" : "No"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <NegotiationDemo products={manifest.products} />
      </div>
    </div>
  );
}
