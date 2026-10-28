import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // each test boots a fresh in-memory PostgreSQL (PGlite), which takes a few seconds
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
