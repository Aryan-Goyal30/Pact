import { prisma } from "@/lib/prisma";
import type { CatalogItemSnapshot } from "@/lib/rules/catalogRules";

/**
 * Looks up a catalog item by SKU and returns just the fields the rule
 * engine needs. Kept separate from catalogRules.ts so the actual
 * decision logic stays pure and DB-free (and unit-testable without a
 * database).
 */
export async function findCatalogItemBySku(
  sku: string,
): Promise<CatalogItemSnapshot | null> {
  const item = await prisma.catalogItem.findUnique({ where: { sku } });

  if (!item) {
    return null;
  }

  return {
    sku: item.sku,
    listedPrice: item.listedPrice,
    minPrice: item.minPrice,
    availableQty: item.availableQty,
    standardDeliveryDays: item.standardDeliveryDays,
    maxDeliveryDays: item.maxDeliveryDays,
    negotiationEnabled: item.negotiationEnabled,
  };
}
