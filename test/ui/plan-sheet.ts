import type { Page } from "playwright-core";

/** Red orb, then Pick a date: the one way to start a plan from Now. */
export async function openPlanSheet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Let friends know you're free now" }).click();
  await page.locator("form.sheet .segment").getByRole("button", { name: "Pick a date" }).click();
  await page.locator("#plan-date").waitFor();
}
