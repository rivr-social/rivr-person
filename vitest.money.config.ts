import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    include: [
      "src/lib/__tests__/stripe-checkout-settlement.test.ts",
      "src/app/actions/__tests__/refund.test.ts",
      "src/app/actions/wallet/__tests__/seller.test.ts",
      "src/app/api/stripe/webhook/__tests__/route.test.ts",
    ],
    exclude: ["node_modules", "tests/**"],
    globalSetup: "./src/test/setup.ts",
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
  },
});
