import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
/** Screenshots of the open ⋯ menu. Override with POLISH_SHOT_DIR=/some/folder. */
const SHOT_DIR = path.resolve(process.env.POLISH_SHOT_DIR || "/workspace/hangry-polish-logs/shots");

const hangry = useHangry({ tz: TZ });
const { call } = hangry;

async function phone(width: number, height: number, token: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, timezoneId: TZ });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
  }, token);
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return { page, errors };
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

const tab = (page: Page, label: string) => page.locator(".tabbar .tab", { hasText: label });
const animationOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((node) => getComputedStyle(node).animationName);

/** Opens ⋯ and checks, before any animation could finish, that the first item already takes the tap. */
async function openMenu(page: Page) {
  await page.locator("[data-social] .card-more").first().click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  const hit = await page.evaluate(() => {
    const item = document.querySelector('.card-menu [role="menuitem"]') as HTMLElement | null;
    if (!item) return { ok: false, why: "no item" };
    const box = item.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const events = getComputedStyle(item).pointerEvents;
    return { ok: Boolean(top && item.contains(top)) && events !== "none", why: `${top?.className} ${events}` };
  });
  assert.ok(hit.ok, `first item takes the tap right away: ${hit.why}`);
  return menu;
}

for (const [width, height] of SIZES) {
  test(`at ${width}: ⋯ pops open, Escape returns focus, tabs land where tapped, reduced motion is still`, { timeout: 90_000 }, async () => {
    const ana = await call("POST", "/api/auth/start", undefined, { name: "Ana" });
    const circle = (await call("POST", "/api/circles", ana.token, { name: "Friends" })).circle;
    const ben = await call("POST", "/api/auth/start", undefined, { name: "Ben", code: circle.inviteCode });
    await call("POST", "/api/socials", ben.token, { note: `Coffee ${width}` });
    const { page, errors } = await phone(width, height, ana.token);
    try {
      await page.locator("[data-social]").first().waitFor();

      // Menu: animates in from the ⋯ corner, first item tappable at once.
      let menu = await openMenu(page);
      assert.equal(await animationOf(page, ".card-menu"), "menu-in");
      const corner = await page.locator(".card-menu").evaluate((node) => {
        const [x, y] = getComputedStyle(node).transformOrigin.split(" ").map(parseFloat);
        const box = node as HTMLElement;
        return { right: Math.abs(x - box.offsetWidth) < 1, edge: node.classList.contains("drop-up") ? Math.abs(y - box.offsetHeight) < 1 : y === 0 };
      });
      assert.deepEqual(corner, { right: true, edge: true }, "grows from the ⋯ corner");
      assert.equal(await page.locator(".card-more").first().getAttribute("aria-expanded"), "true");
      await page.waitForTimeout(250);
      await shot(page, "menu-open");

      // Escape closes it and puts focus back on ⋯.
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      const focused = await page.evaluate(() => {
        const node = document.activeElement as HTMLElement | null;
        return { more: Boolean(node?.classList.contains("card-more")), expanded: node?.getAttribute("aria-expanded") };
      });
      assert.deepEqual(focused, { more: true, expanded: "false" }, "focus is back on ⋯");

      // First item works straight after opening.
      menu = await openMenu(page);
      await menu.getByRole("menuitem").first().click({ timeout: 2000 });
      const arrival = page.getByRole("dialog", { name: "Pick arrival" });
      await arrival.waitFor();
      await page.keyboard.press("Escape");
      await arrival.waitFor({ state: "detached" });

      // Rapid taps: Now, Map, Chat, Now ends on Now with its page showing. Chat loads slowly, so Now lands first.
      await page.route("**/api/circles/chat", async (route) => {
        await new Promise((done) => setTimeout(done, 300));
        await route.continue();
      });
      await tab(page, "Now").click();
      await tab(page, "Map").click();
      assert.equal(await animationOf(page, ".page"), "page-in", "page entrance on a tab switch");
      assert.match((await tab(page, "Map").getAttribute("class")) ?? "", /tab-in/);
      await tab(page, "Chat").click();
      await tab(page, "Now").click();
      await page.waitForTimeout(600);
      assert.equal(await tab(page, "Now").getAttribute("aria-current"), "page");
      assert.equal(await page.locator(".tab[aria-current]").count(), 1);
      assert.equal(await page.locator(".chat-screen").count(), 0, "a late chat load does not take over");
      await page.locator('.page[data-page="home"]').waitFor();
      await page.locator("[data-social]").first().waitFor();

      // Reduced motion: same states, no animations.
      await page.emulateMedia({ reducedMotion: "reduce" });
      menu = await openMenu(page);
      assert.equal(await animationOf(page, ".card-menu"), "none");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      await tab(page, "You").click();
      await page.locator('.page[data-page="you"]').waitFor();
      assert.equal(await animationOf(page, ".page"), "none");
      assert.equal(await tab(page, "You").getAttribute("aria-current"), "page");
      await tab(page, "Now").click();
      await page.locator('.page[data-page="home"]').waitFor();
      assert.equal(await animationOf(page, ".page"), "none");

      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}
