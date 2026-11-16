import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
const SHOT_DIR = process.env.HANG_SHOT_DIR || path.resolve(".oc/shots/maybe");

const hangry = useHangry({ tz: "UTC" });

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

async function people() {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Amanda" });
  const { circle } = await hangry.call("POST", "/api/circles", host.token, { name: "Amanda & Philipp" });
  const friend = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Philipp", code: circle.inviteCode });
  return { host, friend };
}

async function phone(width: number, height: number, token: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

/** Menu items in order, with whether each is marked on. */
async function menuRows(page: Page) {
  return page.locator(".card-menu [role=menuitem]").evaluateAll((nodes) =>
    nodes.map((node) => ({ text: (node.textContent || "").trim(), on: node.classList.contains("on") })));
}

async function menuOnScreen(page: Page) {
  return page.evaluate(() => {
    const menu = document.querySelector(".card-menu");
    if (!menu) return "missing";
    const r = menu.getBoundingClientRect();
    return r.left >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1 ? "ok" : `clipped ${r.left},${r.right},${r.bottom}`;
  });
}

test("friend says maybe from ⋯, stays not In, then taps I'm in", { timeout: 180_000 }, async () => {
  const { host, friend } = await people();
  const { plan } = await hangry.call("POST", "/api/plans", host.token, { note: "Sushi night", time: "19:00" });

  const page = await phone(360, 640, friend.token);
  try {
    const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
    await card.locator(".in-toggle:not(.on)").waitFor();
    await card.locator(".card-more").click();
    const rows = await menuRows(page);
    const texts = rows.map((row) => row.text);
    assert.equal(texts.indexOf("Maybe") + 1, texts.indexOf("Can't make it"), `Maybe sits right above Can't: ${texts}`);
    assert.equal(rows.find((row) => row.text === "Maybe")?.on, false);
    await page.getByRole("menuitem", { name: "Maybe" }).click();

    await card.locator(".who-row", { hasText: "You're maybe" }).waitFor();
    assert.equal(await card.locator(".in-toggle").getAttribute("aria-pressed"), "false");
    assert.match(await card.locator(".in-toggle").innerText(), /I'm in/);
    await card.locator(".card-more").click();
    assert.equal((await menuRows(page)).find((row) => row.text === "Maybe")?.on, true);
    assert.equal((await menuRows(page)).find((row) => row.text === "Can't make it")?.on, false);
    await card.locator(".card-more").click();
    await page.locator(".card-menu").waitFor({ state: "detached" });

    await card.getByRole("button", { name: "Open details" }).click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.getByText("You're maybe").waitFor();
    await page.keyboard.press("Escape");
    await details.waitFor({ state: "detached" });

    await card.locator(".in-toggle").click();
    await card.locator(".in-toggle.on").waitFor();
    await card.locator(".who-row", { hasText: "You're in" }).waitFor();
    const saved = await hangry.call("GET", "/api/plans", friend.token);
    assert.equal(saved.plans[0].joined[0].reply, "coming");
  } finally {
    await page.context().close();
  }

  await hangry.call("POST", `/api/plans/${plan.id}/reply`, friend.token, { reply: "maybe" });
  const hostPage = await phone(360, 640, host.token);
  try {
    const card = hostPage.locator(`.card-plan[data-plan="${plan.id}"]`);
    await card.locator(".who-row", { hasText: "Philipp is maybe" }).waitFor();
    assert.equal(await card.locator(".in-toggle.on").isDisabled(), true);
    await card.locator(".card-more").click();
    assert.equal(await hostPage.getByRole("menuitem", { name: "Maybe" }).count(), 0);
  } finally {
    await hostPage.context().close();
  }
});

test("free-now socials get Maybe too, and the menu fits every phone", { timeout: 180_000 }, async () => {
  const { host, friend } = await people();
  const { plan } = await hangry.call("POST", "/api/plans", host.token, { note: "Board games", time: "18:00" });
  const { social } = await hangry.call("POST", "/api/socials", host.token, { note: "Coffee now?" });

  {
    const page = await phone(360, 640, friend.token);
    try {
      const card = page.locator(`.card-now[data-social="${social.id}"]`);
      await card.locator(".card-more").click();
      await page.getByRole("menuitem", { name: "Maybe" }).click();
      await card.locator(".who-row", { hasText: "You're maybe" }).waitFor();
      assert.equal(await card.locator(".in-toggle").getAttribute("aria-pressed"), "false");
    } finally {
      await page.context().close();
    }
  }

  await hangry.call("POST", `/api/plans/${plan.id}/reply`, friend.token, { reply: "maybe" });
  for (const [width, height] of SIZES) {
    const page = await phone(width, height, friend.token);
    try {
      const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
      await card.locator(".who-row", { hasText: "You're maybe" }).waitFor();
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: shot(`who-row-maybe-w${width}.png`) });
      await card.locator(".card-more").click();
      await page.getByRole("menuitem", { name: "Maybe" }).waitFor();
      assert.equal(await menuOnScreen(page), "ok");
      await page.screenshot({ path: shot(`menu-maybe-w${width}.png`) });
    } finally {
      await page.context().close();
    }
  }
});
