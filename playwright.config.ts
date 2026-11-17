import { defineConfig } from "@playwright/test";

// Each spec file starts its own app (in-memory db) and a browser through useHangry (test/ui/harness.ts),
// so files run in parallel workers while tests inside a file stay serial.
// useHangry picks the browser from the project name: "desktop-firefox" and "desktop-webkit" launch those
// engines, every other project launches Chrome. Contexts come from playwright-core, so the projects
// only choose which specs run.
const DESKTOP_SMOKE = "desktop-light.spec.ts";

export default defineConfig({
  testDir: "./test/ui",
  fullyParallel: false,
  workers: 4,
  retries: 0,
  timeout: 180_000,
  // Contexts come from playwright-core, where @playwright/test would otherwise default these
  // to 0 (no limit). Keep the 30s defaults the specs were written against.
  use: { actionTimeout: 30_000, navigationTimeout: 30_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  projects: [
    // The full suite, on phone-sized contexts.
    { name: "phone", testMatch: "*.spec.ts", testIgnore: DESKTOP_SMOKE },
    // The desktop smoke spec only, on a 1440x900 mouse-and-keyboard browser with a light OS setting.
    { name: "desktop-chrome", testMatch: DESKTOP_SMOKE },
    { name: "desktop-firefox", testMatch: DESKTOP_SMOKE },
    { name: "desktop-webkit", testMatch: DESKTOP_SMOKE },
  ],
});
