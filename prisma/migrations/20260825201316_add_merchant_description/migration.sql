/*
  Warnings:

  - Added the required column `description` to the `Merchant` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Merchant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "deliveryPolicy" TEXT NOT NULL,
    "returnPolicy" TEXT NOT NULL,
    "negotiationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Merchant" ("createdAt", "deliveryPolicy", "id", "name", "negotiationEnabled", "returnPolicy", "updatedAt") SELECT "createdAt", "deliveryPolicy", "id", "name", "negotiationEnabled", "returnPolicy", "updatedAt" FROM "Merchant";
DROP TABLE "Merchant";
ALTER TABLE "new_Merchant" RENAME TO "Merchant";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
