import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    include: [
      "src/__tests__/db/**/*.test.ts",
      "src/__tests__/billing.test.ts",
      "src/__tests__/group-access.test.ts",
      "src/__tests__/group-admin.test.ts",
      "src/__tests__/wallet.test.ts",
      "src/app/actions/__tests__/**/*.test.ts",
      "src/app/actions/**/__tests__/**/*.test.ts",
      "src/app/api/**/__tests__/**/*.test.ts",
      "src/lib/queries/**/__tests__/**/*.test.ts",
      "src/lib/__tests__/ai.test.ts",
      "src/lib/__tests__/permissions.test.ts",
      "src/lib/__tests__/referral-splits.test.ts",
    ],
    exclude: ["node_modules", "tests/**"],
    globalSetup: "./src/test/setup.ts",
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    // These suites share ONE database, so detached writes cross transaction
    // boundaries between files when they run in parallel — global reported ~145
    // spurious failures that all passed when run individually. Serialize until
    // each worker gets its own database.
    fileParallelism: false,
  },
});
