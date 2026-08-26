/*
  Warnings:

  - Added the required column `sku` to the `NegotiationSession` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NegotiationSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "sku" TEXT NOT NULL,
    "buyerRequestRaw" TEXT NOT NULL,
    "roundCount" INTEGER NOT NULL DEFAULT 0,
    "maxRounds" INTEGER NOT NULL DEFAULT 4,
    "pendingMerchantResultRaw" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_NegotiationSession" ("buyerRequestRaw", "createdAt", "id", "roundCount", "status", "updatedAt") SELECT "buyerRequestRaw", "createdAt", "id", "roundCount", "status", "updatedAt" FROM "NegotiationSession";
DROP TABLE "NegotiationSession";
ALTER TABLE "new_NegotiationSession" RENAME TO "NegotiationSession";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
