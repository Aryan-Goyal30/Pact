import { prisma } from "@/lib/prisma";

function formatInr(amount: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export default async function DashboardPage() {
  const [merchant, catalogItems] = await Promise.all([
    prisma.merchant.findFirst(),
    prisma.catalogItem.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-8 bg-zinc-50 px-6 py-10 dark:bg-black sm:px-10">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Merchant dashboard
          </h1>
          {merchant ? (
            <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
              <p className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {merchant.name}
              </p>
              <p>{merchant.deliveryPolicy}</p>
              <p>{merchant.returnPolicy}</p>
              <p>
                Negotiation:{" "}
                {merchant.negotiationEnabled ? "enabled" : "disabled"}
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No merchant profile found. Run{" "}
              <code className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-[0.85em] dark:bg-white/[.08]">
                npx prisma db seed
              </code>{" "}
              to load demo data.
            </p>
          )}
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium text-black dark:text-zinc-50">
            Catalog
          </h2>
          <div className="overflow-x-auto rounded-lg border border-black/[.08] dark:border-white/[.145]">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-black/[.03] text-zinc-600 dark:bg-white/[.04] dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Listed price</th>
                  <th className="px-4 py-3 font-medium">Min price (private)</th>
                  <th className="px-4 py-3 font-medium">Available qty</th>
                  <th className="px-4 py-3 font-medium">Delivery (std / max)</th>
                  <th className="px-4 py-3 font-medium">Negotiable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[.06] dark:divide-white/[.08]">
                {catalogItems.map((item) => (
                  <tr key={item.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">
                        {item.name}
                      </div>
                      <div className="text-zinc-500 dark:text-zinc-500">
                        {item.description}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-600 dark:text-zinc-400">
                      {item.sku}
                    </td>
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                      {formatInr(item.listedPrice)}
                    </td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-500">
                      {formatInr(item.minPrice)}
                    </td>
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                      {item.availableQty}
                    </td>
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                      {item.standardDeliveryDays} / {item.maxDeliveryDays} days
                    </td>
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                      {item.negotiationEnabled ? "Yes" : "No"}
                    </td>
                  </tr>
                ))}
                {catalogItems.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-500"
                    >
                      No catalog items yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            &ldquo;Min price&rdquo; is the merchant&rsquo;s internal price
            floor. It is visible here for the merchant only and will never be
            exposed to a buyer agent.
          </p>
        </section>
      </div>
    </div>
  );
}
