import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Hangry follows the phone's light or dark setting. Dark keeps the surfaces it always had, light uses the
// app-kit light tokens, and plan cards stay dark art in both. Fake people only.
const shotsDir = path.resolve("test/ui/screenshots/color-scheme");
const hangry = useHangry({ tz: "UTC" });

type Rgba = [number, number, number, number];
type Scheme = "light" | "dark";

const SURFACE: Record<Scheme, { page: string; sheet: string; hex: string }> = {
  dark: { page: "rgb(0, 0, 0)", sheet: "rgb(28, 28, 30)", hex: "#000000" },
  light: { page: "rgb(255, 255, 255)", sheet: "rgb(255, 255, 255)", hex: "#ffffff" },
};

/** rgb(), rgba() and color(srgb ...), which is how Chrome prints a colour-mix(). */
function parse(css: string): Rgba {
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(css);
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/.exec(css);
  const m = rgb ?? srgb;
  assert.ok(m, `unreadable colour ${css}`);
  const scale = rgb ? 1 : 255;
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [Number(m[1]) * scale, Number(m[2]) * scale, Number(m[3]) * scale, a];
}

function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3] + under[3] * (1 - top[3]);
  if (a === 0) return [0, 0, 0, 0];
  const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
  return [mix(0), mix(1), mix(2), a];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

async function settle(page: Page) {
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished.catch(() => null)),
  ).then(() => undefined));
}

/** The text colour of the first match, flattened over every background above it and the page colour. */
async function contrastOf(page: Page, scheme: Scheme, selector: string, what: string) {
  await settle(page);
  const found = await page.locator(selector).first().evaluate((node) => {
    const layers: string[] = [];
    let opacity = 1;
    for (let at: Element | null = node; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      opacity *= Number(style.opacity);
      layers.push(style.backgroundColor);
    }
    return { fg: getComputedStyle(node).color, layers, opacity };
  });
  assert.equal(found.opacity, 1, `${what}: fully opaque once settled`);
  let bg: Rgba = parse(SURFACE[scheme].page);
  for (const layer of [...found.layers].reverse()) bg = over(parse(layer), bg);
  const fg = over(parse(found.fg), bg);
  const value = ratio(fg, bg);
  assert.ok(value >= 4.5, `${scheme} ${what}: contrast ${value.toFixed(2)} (text ${fg.map(Math.round)}, behind ${bg.map(Math.round)})`);
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(shotsDir, { recursive: true });
  await settle(page);
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
}

for (const scheme of ["dark", "light"] as const) {
  test(`${scheme} phone: page, tab bar, panel, sheet and menu follow the scheme, cards stay dark art`, { timeout: 150_000 }, async () => {
    const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
    const { circle } = await post("/api/circles", { name: "Friends" }, alex.token);
    const bea = await post("/api/auth/start", { email: testEmail(), name: "Bea", code: circle.inviteCode });
    // A second circle, so the switcher and its menu exist. Ramen goes to Friends, and the page opens on Friends.
    await post("/api/circles", { name: "Hiking" }, alex.token);
    hangry.confirmEmails();
    const social = await post(`/api/socials?circle=${circle.id}`, { note: "Ramen" }, alex.token);
    await post(`/api/socials/${social.social.id}/reply?circle=${circle.id}`, { reply: "in" }, bea.token);

    const context = await hangry.browser.newContext({
      viewport: { width: 360, height: 640 },
      isMobile: true,
      hasTouch: true,
      userAgent: UA,
      colorScheme: scheme,
    });
    await skipWhatsNew(context);
    await context.addInitScript(({ token, circleId }) => {
      localStorage.setItem("fn_token", token);
      localStorage.setItem("fn_circle", circleId);
      localStorage.setItem("fn_install_later", String(Date.now()));
    }, { token: alex.token, circleId: circle.id });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(hangry.baseUrl);
      await page.locator(".tabbar").waitFor();
      const expected = SURFACE[scheme];

      // The page follows the phone. Nothing forces a scheme, and the browser bar matches the page.
      assert.equal(await page.locator("html").getAttribute("data-ak-scheme"), null, "no forced scheme");
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), expected.page, `${scheme} page`);
      const themeColors = await page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.getAttribute("content")));
      assert.ok(themeColors.length > 0 && themeColors.every((value) => value === expected.hex), `${scheme} theme colour, got ${themeColors}`);

      // Now: the plan card is art and keeps white type on its dark gradient in both schemes.
      const title = page.locator("article.card h3", { hasText: "Ramen" });
      await title.waitFor();
      assert.equal(await title.evaluate((node) => getComputedStyle(node).color), "rgb(255, 255, 255)", `${scheme} card title stays white`);
      const bar = parse(await page.locator(".tabbar").evaluate((node) => getComputedStyle(node).backgroundColor));
      const barOnPage = luminance(over(bar, parse(expected.page)));
      if (scheme === "dark") assert.ok(barOnPage < 0.05, `dark tab bar, got ${bar}`);
      else assert.ok(barOnPage > 0.8, `light tab bar, got ${bar}`);
      await contrastOf(page, scheme, ".tabbar .tab[aria-current='page']", "current tab");
      await shot(page, `now-${scheme}`);

      // The card menu is on the art, so it stays dark in both schemes.
      await page.getByRole("button", { name: "More for Ramen" }).click();
      const cardMenu = page.locator(".card-menu");
      await cardMenu.waitFor();
      await settle(page);
      assert.equal(await cardMenu.evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(28, 28, 30)", `${scheme} card menu stays dark`);
      await contrastOf(page, scheme, ".card-menu button", "card menu item");
      await shot(page, `card-menu-${scheme}`);
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 300);
      await cardMenu.waitFor({ state: "detached" });

      // Circle: a panel heading, the invite code and a sheet.
      await page.locator(".tabbar").getByRole("button", { name: "Circle", exact: true }).click();
      await page.locator(".member-row").first().waitFor();
      await contrastOf(page, scheme, ".panel h3", "panel heading");
      await contrastOf(page, scheme, ".code-block", "invite code");
      await shot(page, `circle-${scheme}`);

      // The circle menu floats over the page: the page surface in dark, white with an edge in light.
      await page.getByRole("button", { name: "Switch circle" }).click();
      const menu = page.locator(".circle-menu");
      await menu.waitFor();
      await settle(page);
      assert.equal(await menu.evaluate((node) => getComputedStyle(node).backgroundColor), expected.sheet, `${scheme} circle menu`);
      await contrastOf(page, scheme, ".circle-menu button", "circle menu item");
      await shot(page, `circle-menu-${scheme}`);
      await page.getByRole("button", { name: "Switch circle" }).click();
      await menu.waitFor({ state: "detached" });

      await page.getByRole("button", { name: "Details for Bea" }).click();
      const sheet = page.getByRole("dialog", { name: "Bea" });
      await sheet.waitFor();
      await settle(page);
      assert.equal(await sheet.evaluate((node) => getComputedStyle(node).backgroundColor), expected.sheet, `${scheme} sheet`);
      await contrastOf(page, scheme, ".sheet h2", "sheet title");
      await shot(page, `sheet-${scheme}`);

      assert.deepEqual(errors, [], "no page errors");
    } finally {
      await context.close();
    }
  });
}
