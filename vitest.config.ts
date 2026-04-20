import path from "path";
import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for rivr-person.
 *
 * Purpose:
 * - Resolve the `@/` path alias that matches `tsconfig.json`'s
 *   `paths` mapping so unit tests can import source modules via
 *   `@/lib/...`, `@/db/...`, `@/components/...`, etc.
 * - Declare the standard test-file include patterns.
 *
 * Keep the surface small and mirror `rivr-monorepo/vitest.shared.ts` so
 * ported tests run unchanged here and diverge minimally between repos.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/__tests__/**/*.test.ts",
      "src/**/__tests__/**/*.test.tsx",
    ],
    exclude: ["node_modules", "tests/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
  },
});
