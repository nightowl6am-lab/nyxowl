import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.bench.ts"],
    exclude: ["tests/fixtures/**", "node_modules/**", "dist/**"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: {
        lines: 80,
        branches: 65,
        functions: 80,
        statements: 80,
      },
    },
  },
});
