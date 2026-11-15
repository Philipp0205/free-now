import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, openYouSection, useHangry } from "./harness.js";

const hangry = useHangry();
const SHOTS = new URL("./screenshots/flic-circles/", import.meta.url);

async function phone(token: string) {
  const context = await hangry.browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
  });
  await skipWhatsNew(context);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await page.goto(hangry.baseUrl);
  await page.locator("nav.tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return { context, page };
}

async function openFlic(page: Page) {
  await openYouSection(page, "Account");
  await page.getByRole("button", { name: "Set up a Flic button" }).click();
}

const row = (page: Page, press: string) => page.locator(`.flic-press[data-press="${press}"]`);

async function choose(page: Page, press: string, label: string) {
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/me/buzz-circles") && response.request().method() === "PUT");
  await row(page, press).locator("select").selectOption({ label });
  assert.equal((await saved).status(), 200);
  await page.getByText("Button circle saved").waitFor();
}

test("a user with two circles picks the circle for each Flic press", { timeout: 90_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const marius = await hangry.call("POST", "/api/auth/start", undefined, { name: "Marius" });
  const home = (await hangry.call("POST", "/api/circles", marius.token, { name: "Home" })).circle;
  const uni = (await hangry.call("POST", "/api/circles", marius.token, { name: "Uni" })).circle;
  const { context, page } = await phone(marius.token);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || String(error)));
  try {
    await openFlic(page);
    assert.equal(await page.locator(".flic-press").count(), 3);
    assert.equal(await page.locator(".flic-press select").count(), 3);
    assert.equal(await page.locator(".flic-press").getByRole("button", { name: "Copy link" }).count(), 3);
    assert.equal(await page.locator(".guide-reenable li").count(), 0);
    const flows: Record<string, string> = {
      single: "Flic app: Push > Click > Internet Request, method POST.",
      double: "Flic app: Push > Double click > Internet Request, method POST.",
      hold: "Flic app: Push > Hold > Internet Request, method DELETE. Holding ends your social in that circle.",
    };
    for (const press of ["single", "double", "hold"]) {
      assert.equal((await row(page, press).locator(".help").innerText()).trim(), flows[press]);
      const link = (await row(page, press).locator("pre.curl").innerText()).trim();
      assert.match(link, new RegExp(`^${hangry.baseUrl}/api/buzz/[A-Z0-9-]+\\?press=${press}$`));
      // Uni was joined last, so it is the default.
      assert.equal(await row(page, press).locator("select").inputValue(), "");
      assert.deepEqual(
        await row(page, press).locator("select option").allInnerTexts(),
        ["Default (Uni)", "Home", "Uni"],
      );
    }
    assert.equal(await page.getByRole("button", { name: "Test buzzer" }).count(), 1);
    assert.match(await page.locator(".panel", { hasText: "Keep this link private" }).last().innerText(), /Keep this link private/);

    await choose(page, "single", "Home");
    await choose(page, "double", "Uni");
    await choose(page, "hold", "Home");
    assert.equal(await row(page, "single").locator("select").inputValue(), home.id);
    await page.screenshot({ path: new URL("two-circles.png", SHOTS).pathname, fullPage: true, mask: [page.locator("pre.curl")] });

    // The choices survive a reload.
    await page.reload();
    await page.locator("nav.tabbar").waitFor();
    await openFlic(page);
    assert.equal(await row(page, "single").locator("select").inputValue(), home.id);
    assert.equal(await row(page, "double").locator("select").inputValue(), uni.id);
    assert.equal(await row(page, "hold").locator("select").inputValue(), home.id);

    // Each link posts in its own circle, and hold ends the social there.
    const single = (await row(page, "single").locator("pre.curl").innerText()).trim();
    const double = (await row(page, "double").locator("pre.curl").innerText()).trim();
    const hold = (await row(page, "hold").locator("pre.curl").innerText()).trim();
    const socialsIn = async (circleId: string) => (await hangry.call("GET", `/api/socials?circle=${circleId}`, marius.token)).socials.length;
    assert.equal((await fetch(single, { method: "POST" })).status, 201);
    assert.equal(await socialsIn(home.id), 1);
    assert.equal(await socialsIn(uni.id), 0);
    assert.equal((await fetch(double, { method: "POST" })).status, 201);
    assert.equal(await socialsIn(uni.id), 1);
    assert.equal((await fetch(hold, { method: "DELETE" })).status, 204);
    assert.equal(await socialsIn(home.id), 0);
    assert.equal(await socialsIn(uni.id), 1);

    // Back to the default clears the mapping.
    await choose(page, "single", "Default (Uni)");
    assert.equal((await hangry.call("GET", "/api/me", marius.token)).user.buzzCircles.single, null);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a user with one circle still sees the single link and the steps, without pickers", { timeout: 90_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const solo = await hangry.call("POST", "/api/auth/start", undefined, { name: "Solo" });
  await hangry.call("POST", "/api/circles", solo.token, { name: "friends" });
  const { context, page } = await phone(solo.token);
  try {
    await openFlic(page);
    assert.equal(await page.locator("select").count(), 0);
    assert.equal(await page.locator(".flic-press").count(), 0);
    assert.equal(await page.locator("pre.curl").count(), 1);
    assert.equal(await page.locator(".guide-reenable li").count(), 4);
    assert.match((await page.locator("pre.curl").innerText()).trim(), new RegExp(`^${hangry.baseUrl}/api/buzz/[A-Z0-9-]+$`));
    await page.screenshot({ path: new URL("one-circle.png", SHOTS).pathname, fullPage: true, mask: [page.locator("pre.curl")] });
  } finally {
    await context.close();
  }
});
