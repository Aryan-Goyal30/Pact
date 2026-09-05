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
    <div className="flex w-full flex-1 flex-col gap-8 py-6">
      <NegotiationDemo products={manifest.products} />

      {/* Catalog is deliberately secondary — a collapsed reference panel,
          not the dominant visual element of the page. */}
      <details className="group mx-auto w-full max-w-5xl rounded-xl border border-border px-4 sm:px-6">
        <summary className="flex cursor-pointer list-none items-center justify-between py-4 text-sm font-medium text-foreground">
          <span>
            Available products <span className="text-muted">({manifest.products.length})</span>
          </span>
          <span className="text-muted transition-transform group-open:rotate-180">⌄</span>
        </summary>
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs tracking-wide text-muted uppercase">
              <tr>
                <th className="px-5 py-3 font-medium">Product</th>
                <th className="px-5 py-3 font-medium">Listed price</th>
                <th className="px-5 py-3 font-medium">Stock</th>
                <th className="px-5 py-3 font-medium">Delivery</th>
                <th className="px-5 py-3 font-medium">Negotiable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {manifest.products.map((product) => (
                <tr key={product.sku}>
                  <td className="px-5 py-3">
                    <div className="font-medium text-foreground">{product.name}</div>
                    <div className="text-xs text-muted">{product.description}</div>
                  </td>
                  <td className="px-5 py-3 text-foreground">{formatInr(product.listedPrice)}</td>
                  <td className="px-5 py-3 text-foreground">{product.availableQuantity}</td>
                  <td className="px-5 py-3 text-foreground">{product.standardDeliveryDays}d</td>
                  <td className="px-5 py-3 text-muted">{product.negotiable ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
