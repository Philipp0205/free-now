import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA, openEventsMap, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

const TZ = "Europe/Berlin";
const SHOTS = path.resolve("test/ui/screenshots/map-card-menu");
const PHONES = [[360, 640], [390, 844]] as const;

const hangry = useHangry({ tz: TZ });
const { call } = hangry;

/** Opens the map pin card of a host with two circles, so the menu has its longest list. */
async function openCard(page: Page) {
  await openEventsMap(page);
  const pin = page.locator(".leaflet-marker-icon.pin").first();
  await pin.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await pin.click();
  const card = page.locator(".map-card");
  await card.waitFor();
  return card;
}

async function openMenu(page: Page) {
  await page.locator(".map-card .card-more").click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  await page.waitForTimeout(300);
  return menu;
}

test("the map card's menu stays between the top bar and the tab bar, and every item is tappable", { timeout: 120_000 }, async () => {
  const ana = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Ana" });
  const friends = (await call("POST", "/api/circles", ana.token, { name: "Friends" })).circle;
  await call("POST", "/api/circles", ana.token, { name: "Climbing" });
  await call("POST", `/api/plans?circle=${friends.id}`, ana.token, {
    note: "Map crag", time: "18:00", place: "Hall", lat: 52.5, lng: 13.4, precise: true,
  });
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [width, height] of PHONES) {
    for (const scheme of ["dark", "light"] as const) {
      const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, timezoneId: TZ, colorScheme: scheme });
      await skipWhatsNew(context);
      await context.addInitScript(([token, circle]) => {
        localStorage.setItem("fn_install_later", String(Date.now()));
        localStorage.setItem("fn_token", token);
        localStorage.setItem("fn_circle", circle);
      }, [ana.token, friends.id] as const);
      await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 204, body: "" }));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      try {
        await page.goto(hangry.baseUrl);
        const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
        if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
        const card = await openCard(page);
        const menu = await openMenu(page);
        const tag = `${width}x${height} ${scheme}`;
        const bounds = await page.evaluate(() => ({
          top: document.querySelector(".ak-navbar")?.getBoundingClientRect().bottom ?? 0,
          bottom: document.querySelector(".tabbar")?.getBoundingClientRect().top ?? window.innerHeight,
        }));
        const box = (await menu.boundingBox())!;
        assert.ok(box.y >= bounds.top - 0.5, `${tag}: menu below the top bar ${JSON.stringify({ box, bounds })}`);
        assert.ok(box.y + box.height <= bounds.bottom + 0.5, `${tag}: menu above the tab bar ${JSON.stringify({ box, bounds })}`);
        await page.screenshot({ path: path.join(SHOTS, `menu-open-${scheme}-${width}x${height}.png`) });
        const items = menu.getByRole("menuitem");
        assert.equal(await items.first().innerText(), "Share with other circles", tag);
        // Every item is hit by a real tap point: nothing (the navbar, the tab bar) sits on top of it.
        const covered = await page.evaluate(() => [...document.querySelectorAll("[role=menu] [role=menuitem]")].filter((el) => {
          el.scrollIntoView({ block: "nearest" });
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !(top && el.contains(top));
        }).map((el) => el.textContent));
        assert.deepEqual(covered, [], `${tag}: items covered by something`);
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached" });
        // Tap outside closes it too (on the map above the card).
        await openMenu(page);
        await page.mouse.click(width / 2, 120);
        await page.getByRole("menu").waitFor({ state: "detached" });
        // The first item is clickable and opens the sheet.
        await openMenu(page);
        await page.getByRole("menuitem", { name: "Share with other circles", exact: true }).click();
        await page.getByRole("dialog", { name: "Share with other circles" }).waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("dialog", { name: "Share with other circles" }).waitFor({ state: "detached" });
        if (await card.isVisible()) {
          await card.getByRole("button", { name: "Close", exact: true }).click();
        }
        await card.waitFor({ state: "detached" });
        assert.deepEqual(errors, [], tag);
      } finally {
        await context.close();
      }
    }
  }
});
