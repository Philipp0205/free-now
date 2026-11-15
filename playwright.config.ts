import { defineConfig } from "@playwright/test";

// Each spec file starts its own app (in-memory db) and Chrome through useHangry,
// so files run in parallel workers while tests inside a file stay serial.
export default defineConfig({
  testDir: "./test/ui",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 4,
  retries: 0,
  timeout: 180_000,
  // Contexts come from playwright-core, where @playwright/test would otherwise default these
  // to 0 (no limit). Keep the 30s defaults the specs were written against.
  use: { actionTimeout: 30_000, navigationTimeout: 30_000 },
  reporter: [["list"], ["html", { open: "never" }]],
});
