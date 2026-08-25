// Public shape of GET /api/manifest — the AI-readable commerce layer.
//
// Every field here is safe to hand to an external buyer agent. Nothing
// derived from CatalogItem.minPrice or any internal rule/constraint may
// ever appear on these types. See src/lib/manifest.ts for the DTO
// construction that enforces this at runtime.

export interface PublicManifestMerchant {
  name: string;
  description: string;
  negotiationSupported: boolean;
}

export interface PublicManifestPolicies {
  delivery: string;
  returns: string;
}

export interface PublicManifestProduct {
  sku: string;
  name: string;
  description: string;
  listedPrice: number;
  availableQuantity: number;
  standardDeliveryDays: number;
  maxDeliveryDays: number;
  negotiable: boolean;
}

export interface PublicManifest {
  merchant: PublicManifestMerchant;
  policies: PublicManifestPolicies;
  products: PublicManifestProduct[];
  generatedAt: string;
}
