import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
const TZ = "Europe/Berlin";
/** Screenshots of the open ⋯ menu and the tab bar. Override with POLISH_SHOT_DIR=/some/folder. */
const SHOT_DIR = path.resolve(process.env.POLISH_SHOT_DIR || "test/ui/screenshots/menu-tab-polish");

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

/** Ana's circle with one free post from Ben, so Now has a card with a ⋯ menu. */
async function seed(note: string) {
  const ana = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Ana" });
  const circle = (await call("POST", "/api/circles", ana.token, { name: "Friends" })).circle;
  const ben = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Ben", code: circle.inviteCode });
  await call("POST", "/api/socials", ben.token, { note });
  return ana;
}

/**
 * Page and title tops while the entrance is still running, then again once it has finished.
 * The kit removes its class when the animation ends, so the animation name and the tab class are read first.
 */
function topsAcrossEntrance(page: Page, tabLabel: string) {
  return page.locator(".page").evaluate(async (node, label) => {
    const title = node.querySelector(".screen-title") ?? node;
    const running = node.getAnimations().some((animation) => animation.playState === "running");
    const animation = getComputedStyle(node).animationName;
    const pageClass = node.className;
    const tab = [...document.querySelectorAll(".tabbar .tab")].find((item) => item.textContent?.includes(label));
    const tabClass = tab?.className ?? "";
    const iconAnimation = tab ? getComputedStyle(tab.querySelector(".icon")!).animationName : "";
    const during = { page: node.getBoundingClientRect().top, title: title.getBoundingClientRect().top };
    await Promise.all(node.getAnimations().map((item) => item.finished));
    const after = { page: node.getBoundingClientRect().top, title: title.getBoundingClientRect().top };
    return { running, animation, pageClass, tabClass, iconAnimation, during, after };
  }, tabLabel);
}

for (const [width, height] of SIZES) {
  test(`at ${width}: ⋯ pops open, Escape returns focus, the page fades in without moving, reduced motion is still`, { timeout: 90_000 }, async () => {
    const ana = await seed(`Coffee ${width}`);
    const { page, errors } = await phone(width, height, ana.token);
    try {
      await page.locator("[data-social]").first().waitFor();

      // Menu: pops in from the ⋯ corner with the kit's pop, first item tappable at once.
      let menu = await openMenu(page);
      assert.equal(await animationOf(page, ".card-menu"), "ak-pop-in");
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
      await page.locator(".card-menu").waitFor({ state: "detached" });
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

      // Tab switch: fade only, so the page sits at the same place during and after the entrance.
      await tab(page, "Circle").click();
      await page.locator('.page[data-page="circle"]').waitFor();
      const tops = await topsAcrossEntrance(page, "Circle");
      assert.ok(tops.running, "measured while the entrance runs");
      assert.deepEqual(tops.during, tops.after, `page top is stable ${JSON.stringify(tops)}`);
      assert.equal(tops.animation, "ak-page-in", "page entrance on a tab switch");
      assert.match(tops.pageClass, /ak-page-in/);
      assert.match(tops.tabClass, /ak-tab-in/);
      assert.equal(tops.iconAnimation, "ak-tab-icon-in", "the icon springs in");
      await page.locator(".page.ak-page-in").waitFor({ state: "detached" });
      await page.locator(".tab.ak-tab-in").waitFor({ state: "detached" });
      assert.equal(await page.locator(".page").evaluate((node) => getComputedStyle(node).transform), "none", "no transform on the page");
      await tab(page, "Now").click();
      await page.locator('.page[data-page="home"]').waitFor();
      await page.locator("[data-social]").first().waitFor();

      // Closing a sheet or a poll render is not a tab switch.
      await page.getByRole("button", { name: "Let friends know you're free now" }).click();
      await page.locator("#sheet-note").waitFor();
      await page.keyboard.press("Escape");
      await page.locator("form.sheet").waitFor({ state: "detached" });
      assert.equal(await animationOf(page, ".page"), "none", "no entrance after a sheet closes");
      await page.waitForTimeout(3500);
      assert.equal(await animationOf(page, ".page"), "none", "no entrance on a poll render");

      // Reduced motion: same states, a fade for the menu, nothing for the page.
      await page.emulateMedia({ reducedMotion: "reduce" });
      menu = await openMenu(page);
      assert.equal(await animationOf(page, ".card-menu"), "ak-fade-in");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      await tab(page, "You").click();
      await page.locator('.page[data-page="you"]').waitFor();
      assert.equal(await animationOf(page, ".page"), "none");
      assert.equal(await page.locator(".ak-page-in, .ak-tab-in").count(), 0, "the kit plays nothing under reduced motion");
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

test("the tab bar is the kit's: icon dips while held, the button stays put, the landing plays once per switch", { timeout: 90_000 }, async () => {
  const [width, height] = SIZES[1];
  const ana = await seed("Coffee kit tabs");
  const { page, errors } = await phone(width, height, ana.token);
  try {
    await page.locator("[data-social]").first().waitFor();
    const shape = await page.evaluate(() => {
      const nav = document.querySelector("nav.tabbar") as HTMLElement;
      const box = nav.getBoundingClientRect();
      return {
        nav: nav.classList.contains("ak-tabbar"),
        tabs: [...nav.querySelectorAll(".tab")].every((node) => node.classList.contains("ak-tab")),
        icons: [...nav.querySelectorAll(".tab")].every((node) => node.querySelector(".icon")?.classList.contains("ak-tab-icon")),
        left: Math.round(box.left),
        right: Math.round(window.innerWidth - box.right),
        width: Math.round(box.width),
      };
    });
    assert.deepEqual({ nav: shape.nav, tabs: shape.tabs, icons: shape.icons }, { nav: true, tabs: true, icons: true });
    assert.equal(shape.left, shape.right, `the bar is centred ${JSON.stringify(shape)}`);
    assert.equal(shape.width, width, "the bar spans the phone");

    // Count every landing the kit plays.
    await page.evaluate(() => {
      const counts = { page: 0, tab: 0 };
      (window as any).__landings = counts;
      document.addEventListener("animationstart", (event) => {
        if (event.animationName === "ak-page-in") counts.page += 1;
        if (event.animationName === "ak-tab-in") counts.tab += 1;
      }, true);
    });
    const landings = () => page.evaluate(() => ({ ...(window as any).__landings }));

    // Hold a tab: the icon dips, the button is not dimmed or scaled.
    const box = (await tab(page, "Events").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(250);
    const held = await tab(page, "Events").evaluate((node) => {
      const style = getComputedStyle(node);
      return { opacity: style.opacity, transform: style.transform, icon: getComputedStyle(node.querySelector(".icon")!).transform };
    });
    await shot(page, "tab-held");
    await page.mouse.move(box.x + box.width / 2, 100);
    await page.mouse.up();
    assert.equal(held.opacity, "1", "the held tab is not dimmed");
    assert.equal(held.transform, "none", "the held tab does not scale");
    const dip = held.icon.match(/matrix\(([^,]+),/)?.[1];
    assert.ok(dip && Math.abs(Number(dip) - 0.9) < 0.02, `the icon dips to 0.9 (${held.icon})`);
    assert.deepEqual(await landings(), { page: 0, tab: 0 }, "a held tab that was not released is not a switch");

    // A switch plays once. Tapping the tab already showing, a sheet and a poll do not.
    await tab(page, "Circle").click();
    await page.locator('.page[data-page="circle"]').waitFor();
    await page.locator(".page.ak-page-in").waitFor({ state: "detached" });
    assert.deepEqual(await landings(), { page: 1, tab: 1 }, "one switch, one landing");
    await shot(page, "tab-landed");
    await tab(page, "Circle").click();
    await page.waitForTimeout(300);
    assert.deepEqual(await landings(), { page: 1, tab: 1 }, "the tab already showing does not replay");
    await page.waitForTimeout(3500);
    assert.deepEqual(await landings(), { page: 1, tab: 1 }, "a poll render does not replay");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("a ⋯ menu pops out when it closes, inert while it goes, and the card keeps room for it", { timeout: 90_000 }, async () => {
  const [width, height] = SIZES[1];
  const ana = await seed("Coffee pop out");
  const { page, errors } = await phone(width, height, ana.token);
  try {
    await page.locator("[data-social]").first().waitFor();
    await openMenu(page);
    await page.waitForTimeout(250);
    // Close it and look in the same turn, before the 140ms pop-out can finish.
    const out = await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const menu = document.querySelector(".card-menu");
      const card = menu?.closest(".card");
      return {
        found: Boolean(menu),
        out: menu?.classList.contains("ak-pop-out") ?? false,
        hidden: menu?.getAttribute("aria-hidden"),
        inert: menu?.hasAttribute("inert") ?? false,
        room: card?.classList.contains("menu-open") ?? false,
        expanded: document.querySelector(".card-more")?.getAttribute("aria-expanded"),
        animation: menu ? getComputedStyle(menu).animationName : "",
      };
    });
    assert.deepEqual(out, { found: true, out: true, hidden: "true", inert: true, room: true, expanded: "false", animation: "ak-pop-out" });
    await page.locator(".card-menu").waitFor({ state: "detached" });
    assert.equal(await page.locator(".card.menu-open").count(), 0, "the card is a card again once the menu is gone");

    // Opening it again straight away still gives one menu.
    await page.locator("[data-social] .card-more").first().click();
    await page.getByRole("menu").waitFor();
    assert.equal(await page.locator(".card-menu").count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("a sheet dragged closed slides on from where it was let go, and a button close slides from rest", { timeout: 90_000 }, async () => {
  const [width, height] = SIZES[1];
  const ana = await seed("Coffee sheet out");
  const { page, errors } = await phone(width, height, ana.token);
  try {
    await page.locator("[data-social]").first().waitFor();
    const open = async () => {
      await page.getByRole("button", { name: "Let friends know you're free now" }).click();
      await page.locator("form.sheet").waitFor();
    };
    const top = (selector: string) => page.locator(selector).first().evaluate((node) => node.getBoundingClientRect().top);

    // Drag the grabber well past the close distance, slowly (under the flick speed), and let go.
    await open();
    const rest = await top("form.sheet");
    const grab = (await page.locator(".sheet .grabber").boundingBox())!;
    const x = grab.x + grab.width / 2;
    const y = grab.y + grab.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(x, y + (140 * step) / 6);
      await page.waitForTimeout(130);
    }
    const held = await top("form.sheet");
    assert.ok(held > rest + 100, `the sheet follows the finger (${rest} to ${held})`);
    await page.mouse.up();
    // Read straight after the release, before the 220ms slide can finish.
    const ghost = await page.evaluate(() => {
      const node = document.querySelector("body > div:not(#app) .sheet") as HTMLElement | null;
      const wrapper = node?.parentElement;
      return {
        found: Boolean(node),
        top: node?.getBoundingClientRect().top ?? 0,
        inert: wrapper?.hasAttribute("inert") ?? false,
        hidden: wrapper?.getAttribute("aria-hidden"),
        live: document.querySelectorAll("#app .sheet").length,
      };
    });
    assert.equal(ghost.found, true, "the sheet that is leaving is still on screen");
    assert.ok(ghost.top >= held - 12, `it carries on from the drag, not from rest (${ghost.top} vs ${held}, rest ${rest})`);
    assert.deepEqual({ inert: ghost.inert, hidden: ghost.hidden, live: ghost.live }, { inert: true, hidden: "true", live: 0 });
    await page.locator("form.sheet").waitFor({ state: "detached" });
    await page.locator(".scrim").waitFor({ state: "detached" });

    // The close button: from rest, down. The sheet is gone from the page at once and from the screen a moment later.
    await open();
    await shot(page, "sheet-open");
    await page.keyboard.press("Escape");
    const away = await page.evaluate(() => {
      const node = document.querySelector("body > div:not(#app) .sheet") as HTMLElement | null;
      return { found: Boolean(node), live: document.querySelectorAll("#app .sheet").length, locked: document.documentElement.classList.contains("sheet-open") };
    });
    assert.deepEqual(away, { found: true, live: 0, locked: false }, "state closes at once, the copy only plays out");
    await page.locator("form.sheet").waitFor({ state: "detached" });

    // Reduced motion: nothing is kept, the sheet goes at once.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open();
    await page.keyboard.press("Escape");
    const still = await page.evaluate(() => document.querySelectorAll("form.sheet").length);
    assert.equal(still, 0, "no slide under reduced motion");
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("rapid tab taps with a slow chat end on the last tab tapped", { timeout: 90_000 }, async () => {
  const [width, height] = SIZES[0];
  const ana = await seed("Coffee rapid");
  const { page, errors } = await phone(width, height, ana.token);
  try {
    await page.locator("[data-social]").first().waitFor();
    // Chat loads slowly, so the last Now tap lands before the chat answer does.
    await page.route("**/api/circles/chat", async (route) => {
      await new Promise((done) => setTimeout(done, 300));
      await route.continue();
    });
    await tab(page, "Now").click();
    await tab(page, "Events").click();
    await tab(page, "Chat").click();
    await tab(page, "Now").click();
    await page.waitForTimeout(600);
    assert.equal(await tab(page, "Now").getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".tab[aria-current]").count(), 1);
    assert.equal(await page.locator(".chat-screen").count(), 0, "a late chat load does not take over");
    await page.locator('.page[data-page="home"]').waitFor();
    await page.locator("[data-social]").first().waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});
