import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

const hangry = useHangry();

test("the You tab shows a Flic link that starts and ends a social", { timeout: 90_000 }, async () => {
  const context = await hangry.browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
  });
  await skipWhatsNew(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || String(error)));
  try {
    await signIn(page, "Marius");
    await page.locator(".tabbar").getByRole("button", { name: "You", exact: true }).click();
    await page.getByRole("button", { name: "Set up a Flic button" }).click();
    const link = (await page.locator("pre.curl").innerText()).trim();
    // One circle: the link needs no circle argument.
    assert.match(link, new RegExp(`^${hangry.baseUrl}/api/buzz/[A-Z0-9-]+$`));
    assert.equal(await page.locator(".guide-reenable li").count(), 4);

    const token = await page.evaluate(() => localStorage.getItem("fn_token") || "");
    assert.equal((await fetch(link, { method: "POST" })).status, 201);
    assert.equal((await hangry.call("GET", "/api/socials", token)).socials.length, 1);
    assert.equal((await fetch(link, { method: "DELETE" })).status, 204);
    assert.equal((await hangry.call("GET", "/api/socials", token)).socials.length, 0);

    await page.getByRole("button", { name: "Hide button setup" }).click();
    assert.equal(await page.locator("pre.curl").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

async function signIn(page: Page, name: string) {
  await page.goto(hangry.baseUrl);
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.locator("#circle-name").fill("friends");
  await page.getByRole("button", { name: "Create circle" }).click();
  const again = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await again.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await again.click();
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}
