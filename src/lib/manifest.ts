import { prisma } from "@/lib/prisma";
import type {
  PublicManifest,
  PublicManifestProduct,
} from "@/types/manifest";

/**
 * Builds the public AI-readable manifest.
 *
 * This function explicitly whitelists every field it returns instead of
 * serializing Prisma records directly, so a private column added to
 * CatalogItem or Merchant in the future (e.g. margin, internal notes)
 * cannot silently leak here — it has to be added to this mapping on
 * purpose.
 */
export async function getPublicManifest(): Promise<PublicManifest> {
  const [merchant, catalogItems] = await Promise.all([
    prisma.merchant.findFirst(),
    prisma.catalogItem.findMany({ orderBy: { name: "asc" } }),
  ]);

  if (!merchant) {
    throw new Error("No merchant profile is configured.");
  }

  const products: PublicManifestProduct[] = catalogItems.map((item) => ({
    sku: item.sku,
    name: item.name,
    description: item.description,
    listedPrice: item.listedPrice,
    availableQuantity: item.availableQty,
    standardDeliveryDays: item.standardDeliveryDays,
    maxDeliveryDays: item.maxDeliveryDays,
    negotiable: item.negotiationEnabled,
  }));

  return {
    merchant: {
      name: merchant.name,
      description: merchant.description,
      negotiationSupported: merchant.negotiationEnabled,
    },
    policies: {
      delivery: merchant.deliveryPolicy,
      returns: merchant.returnPolicy,
    },
    products,
    generatedAt: new Date().toISOString(),
  };
}
