import type { Page } from "playwright-core";

/** Red orb, then Plan for another day: the one way to start a plan from Now. */
export async function openPlanSheet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Let friends know you're free now" }).click();
  await page.locator("form.sheet").getByRole("button", { name: "Plan for another day" }).click();
  await page.locator("#plan-date").waitFor();
}
