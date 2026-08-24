import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./dev.db",
});

const prisma = new PrismaClient({ adapter });

async function main() {
  await prisma.merchant.deleteMany();
  await prisma.catalogItem.deleteMany();

  await prisma.merchant.create({
    data: {
      name: "PACT Demo Electronics",
      deliveryPolicy: "Standard delivery within listed lead time; bulk orders may be split into batches.",
      returnPolicy: "7-day return window for unopened units.",
      negotiationEnabled: true,
    },
  });

  await prisma.catalogItem.createMany({
    data: [
      {
        sku: "LAPTOP-14-I5",
        name: "14-inch Business Laptop (i5, 16GB RAM)",
        description: "Mid-range business laptop suitable for office use.",
        listedPrice: 48000,
        minPrice: 44000,
        availableQty: 100,
        standardDeliveryDays: 5,
        maxDeliveryDays: 12,
        negotiationEnabled: true,
      },
      {
        sku: "MONITOR-24-FHD",
        name: "24-inch Full HD Monitor",
        description: "Standard office monitor, 1920x1080.",
        listedPrice: 9500,
        minPrice: 8200,
        availableQty: 250,
        standardDeliveryDays: 4,
        maxDeliveryDays: 10,
        negotiationEnabled: true,
      },
      {
        sku: "KEYBOARD-WIRELESS",
        name: "Wireless Keyboard and Mouse Combo",
        description: "Standard wireless keyboard and mouse set.",
        listedPrice: 1400,
        minPrice: 1150,
        availableQty: 500,
        standardDeliveryDays: 3,
        maxDeliveryDays: 7,
        negotiationEnabled: false,
      },
    ],
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
