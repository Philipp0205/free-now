import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { gradientClass } from "../../public/js/card-grad.js";
import { contrast, over, parseCss, type Rgb } from "../contrast.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, dismissPaymentReminder, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/compact-colors");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const start = (name: string, code?: string) =>
  call("POST", "/api/auth/start", undefined, { email: testEmail(), name, ...(code ? { code } : {}) });

type Plan = { id: string; note: string };

/** Hana hosts a live social and plans until two of them have different gradients; five friends join the first plan (+N). */
async function seed() {
  const host = await start("Hana");
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Test crew" });
  const friends = [];
  for (const name of ["Alex", "Bea", "Cy", "Dee", "Eli"]) friends.push(await start(name, circle.inviteCode));
  hangry.confirmEmails();
  const plans: Plan[] = [];
  for (let n = 0; n < 8; n += 1) {
    const plan = (await call("POST", "/api/plans", host.token, { note: `Plan ${n}`, date: daysAhead(n + 1), time: "19:00" })).plan;
    plans.push(plan);
    if (new Set(plans.map((item) => gradientClass(item.id))).size >= 2 && plans.length >= 3) break;
  }
  for (const friend of friends) await call("POST", `/api/plans/${plans[0].id}/reply`, friend.token, { reply: "in" });
  const coffee = (await call("POST", "/api/socials", host.token, { note: "Coffee run" })).social;
  return { host, plans, coffee };
}

async function openAs(token: string, width: number, height: number, scheme: "dark" | "light" = "dark"): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await dismissPaymentReminder(page);
  return page;
}

const toggle = (page: Page) => page.getByRole("group", { name: "Event list" });
const gradOf = (node: Locator) => node.evaluate((el) => [...el.classList].find((name) => /^grad-\d+$/.test(name)) ?? "");
const planCard = (page: Page, id: string) => page.locator(`.card-plan[data-plan="${id}"]`);
const planRow = (page: Page, id: string) => page.locator(`.compact-row[data-plan="${id}"]`);

/** The stops a card shows (--g1, --g2) and the same two the compact row resolved from the same class. */
function stopsOf(node: Locator) {
  return node.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.getPropertyValue("--g1").trim(), style.getPropertyValue("--g2").trim()];
  });
}

/** Resolved colours of a row: its tint stops, its paper stops (light only), its now wash, and the text colours on it. */
async function paint(row: Locator) {
  return row.evaluate((el) => {
    const resolve = (value: string) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = value;
      el.appendChild(probe);
      const out = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return out;
    };
    const ink = (selector: string) => {
      const node = el.querySelector(selector);
      return node ? getComputedStyle(node).color : null;
    };
    return {
      t1: resolve("var(--row-t1)"),
      t2: resolve("var(--row-t2)"),
      p1: resolve("var(--paper-1)"),
      p2: resolve("var(--paper-2)"),
      wash: resolve("var(--row-wash)"),
      title: ink(".compact-title"),
      when: ink(".compact-when"),
      more: ink(".compact-more"),
    };
  });
}

/** Title, date and +N against the painted stops (tint in dark, paper in light), with the now wash over them when the row is happening now. */
async function assertReadable(row: Locator, tag: string, scheme: "dark" | "light" = "dark") {
  const seen = await paint(row);
  const wash = parseCss(seen.wash);
  const stops = scheme === "light" ? [seen.p1, seen.p2] : [seen.t1, seen.t2];
  for (const stop of stops) {
    const tint = parseCss(stop);
    assert.equal(tint.alpha, 1, `${tag}: the painted stop is opaque`);
    const behind: Rgb = wash.alpha > 0 ? over(wash.rgb, wash.alpha, tint.rgb) : tint.rgb;
    for (const [what, ink] of [["title", seen.title], ["date", seen.when], ["+N", seen.more]] as const) {
      if (!ink) continue;
      const value = contrast(parseCss(ink).rgb, behind);
      assert.ok(value >= 4.5, `${tag}: ${what} on the row is ${value.toFixed(2)}:1`);
    }
  }
}

test("a plan row has the same gradient class and stops as its card, and different plans differ", { timeout: 300_000 }, async () => {
  const { host, plans, coffee } = await seed();
  const errors: string[] = [];
  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const page = await openAs(host.token, width, height);
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.locator(".card-plan").first().waitFor();
      const cards = new Map<string, { cls: string; stops: string[] }>();
      for (const plan of plans) {
        const card = planCard(page, plan.id);
        cards.set(plan.id, { cls: await gradOf(card), stops: await stopsOf(card) });
        assert.equal(cards.get(plan.id)!.cls, gradientClass(plan.id), `${tag}: the card uses its id's gradient`);
      }
      await shot(page, `cards-${tag}`);
      await toggle(page).getByRole("button", { name: "Compact" }).click();
      await page.locator(".compact-row").first().waitFor();

      const backgrounds = new Set<string>();
      for (const plan of plans) {
        const row = planRow(page, plan.id);
        const card = cards.get(plan.id)!;
        assert.equal(await gradOf(row), card.cls, `${tag}: ${plan.note} keeps its card's grad-N`);
        assert.deepEqual(await stopsOf(row), card.stops, `${tag}: ${plan.note} resolves the same stops as its card`);
        const image = await row.evaluate((el) => getComputedStyle(el).backgroundImage);
        assert.match(image, /linear-gradient/, `${tag}: the row paints its tint`);
        backgrounds.add(image);
        assert.equal(await row.evaluate((el) => el.classList.contains("card-now") || el.classList.contains("card-grad")), false, `${tag}: a row is not a card`);
        assert.equal(await row.getAttribute("data-happening-now"), null, `${tag}: a plan is never now`);
        assert.equal(await row.evaluate((el) => getComputedStyle(el).color), await page.locator("body").evaluate((el) => getComputedStyle(el).color), `${tag}: type stays the page text colour`);
      }
      const classes = new Set([...cards.values()].map((card) => card.cls));
      assert.ok(classes.size >= 2, `${tag}: two plans show two colours`);
      assert.ok(backgrounds.size >= 2, `${tag}: and two different row backgrounds`);

      // The social is not a plan: its own tint, no plan gradient, and .card-now stays a card class.
      const social = page.locator(`.compact-row[data-social="${coffee.id}"]`);
      assert.equal(await social.evaluate((el) => el.classList.contains("compact-social")), true);
      assert.equal(await social.evaluate((el) => [...el.classList].some((name) => /^grad-\d+$/.test(name) || name === "card-now")), false, `${tag}: no plan gradient on a social`);
      assert.match(await social.evaluate((el) => getComputedStyle(el).backgroundImage), /linear-gradient/);
      assert.equal(backgrounds.has(await social.evaluate((el) => getComputedStyle(el).backgroundImage)), false, `${tag}: the social tint is its own`);
      await shot(page, `compact-${tag}`);
    } finally {
      await page.context().close();
    }
  }
  assert.deepEqual(errors, []);
});

test("the live social row keeps its pink ring and dot on top of its tint", { timeout: 180_000 }, async () => {
  const { host, coffee } = await seed();
  const page = await openAs(host.token, 360, 640);
  try {
    await page.locator(".card-plan").first().waitFor();
    await toggle(page).getByRole("button", { name: "Compact" }).click();
    const row = page.locator(`.compact-row[data-social="${coffee.id}"]`);
    await row.waitFor();
    assert.equal(await row.getAttribute("data-happening-now"), "1");
    assert.equal(await row.evaluate((el) => el.classList.contains("happening-now") && el.classList.contains("compact-social")), true);
    const seen = await row.evaluate((el) => ({
      shadow: getComputedStyle(el).boxShadow,
      dot: getComputedStyle(el, "::before").content,
      dotSize: getComputedStyle(el, "::before").width,
      image: getComputedStyle(el).backgroundImage,
    }));
    assert.match(seen.shadow, /255, 45, 120/, "the pink inset line");
    assert.notEqual(seen.dot, "none", "the dot");
    assert.equal(seen.dotSize, "8px");
    assert.match(seen.image, /linear-gradient/, "the tint is still there");
    const wash = parseCss((await paint(row)).wash);
    assert.ok(wash.alpha > 0.05, "and the pink now wash sits on it");
    assert.deepEqual(wash.rgb.map(Math.round), [255, 45, 120]);
    await shot(page, "compact-now-360x640");
  } finally {
    await page.context().close();
  }
});

test("title, date and +N stay readable on every tinted row in dark and in light", { timeout: 240_000 }, async () => {
  const { host, plans, coffee } = await seed();
  for (const scheme of ["dark", "light"] as const) {
    const page = await openAs(host.token, 360, 640, scheme);
    try {
      await page.locator(".card-plan").first().waitFor();
      await toggle(page).getByRole("button", { name: "Compact" }).click();
      await page.locator(".compact-row").first().waitFor();
      for (const plan of plans) await assertReadable(planRow(page, plan.id), `${scheme} ${plan.note}`, scheme);
      assert.ok((await paint(planRow(page, plans[0].id))).more, `${scheme}: the first plan shows +N`);
      await assertReadable(page.locator(`.compact-row[data-social="${coffee.id}"]`), `${scheme} live social`, scheme);
      if (scheme === "light") {
        const chip = await planRow(page, plans[0].id).evaluate((el) => ({ width: getComputedStyle(el, "::before").width, height: getComputedStyle(el, "::before").height }));
        assert.deepEqual(chip, { width: "22px", height: "22px" }, "light rows carry the 22px chip");
      }
      // Dark rows paint a solid colour, light rows paint a paper gradient over a transparent colour.
      const surface = await page.locator(".compact-row").first().evaluate((el) => ({ color: getComputedStyle(el).backgroundColor, image: getComputedStyle(el).backgroundImage }));
      if (scheme === "light") assert.match(surface.image, /linear-gradient/, `${scheme}: the row has a paper surface`);
      else assert.equal(parseCss(surface.color).alpha, 1, `${scheme}: the row has a surface`);
      await shot(page, `compact-${scheme}-360x640`);
    } finally {
      await page.context().close();
    }
  }
});
