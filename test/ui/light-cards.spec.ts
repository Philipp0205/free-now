import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { contrast, luminance, over, parseCss, type Rgb } from "../contrast.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, dismissPaymentReminder, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Option A: in Light, home cards and compact rows are soft paper with near-black type and a small colour chip.
// In Dark they are exactly the dark art they always were. Fake people only. Shots are gitignored.
const SHOT_DIR = path.resolve("test/ui/screenshots/light-cards");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

type Scheme = "light" | "dark";
/** Every way a scheme gets chosen: the OS alone (System), or Settings forcing one over the OS. */
const SCENARIOS: Array<{ name: string; os: Scheme; forced: Scheme | null; scheme: Scheme }> = [
  { name: "light OS, System", os: "light", forced: null, scheme: "light" },
  { name: "forced Light on a dark OS", os: "dark", forced: "light", scheme: "light" },
  { name: "dark OS, System", os: "dark", forced: null, scheme: "dark" },
  { name: "forced Dark on a light OS", os: "light", forced: "dark", scheme: "dark" },
];

const INK = "rgb(22, 18, 15)";
const WHITE = "rgb(255, 255, 255)";
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return settle(page).then(() => page.screenshot({ path: path.join(SHOT_DIR, `${slug(name)}.png`) }));
}

/** Waits for the finite animations (the In pop, the menu pop, the ring) so colours are read at rest. */
function settle(page: Page) {
  return page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => null))).then(() => undefined));
}

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

/** Hana hosts a plan tomorrow and a live social. Finn is the viewer, so In is his to tap. */
async function seed() {
  const start = (name: string, code?: string) => call("POST", "/api/auth/start", undefined, { email: testEmail(), name, ...(code ? { code } : {}) });
  const host = await start("Hana");
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Test crew" });
  const finn = await start("Finn", circle.inviteCode);
  hangry.confirmEmails();
  const plan = (await call("POST", "/api/plans", host.token, { note: "Rooftop dinner", date: tomorrow(), time: "19:00" })).plan;
  const social = (await call("POST", "/api/socials", host.token, { note: "Coffee run" })).social;
  return { finn, plan, social };
}

async function openAs(token: string, os: Scheme, forced: Scheme | null, size: readonly [number, number] = [360, 640]): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width: size[0], height: size[1] },
    colorScheme: os,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript(({ value, theme }) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    if (theme) localStorage.setItem("fn_theme", theme);
  }, { value: token, theme: forced });
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await dismissPaymentReminder(page);
  await page.locator(".card-plan").first().waitFor();
  return page;
}

/** Computed paint of one card: type, surface, chip, controls and ring. Colours resolved by Chrome. */
function readCard(card: Locator) {
  return card.evaluate((el) => {
    const css = (selector: string | null, pseudo?: string) => getComputedStyle(selector ? el.querySelector(selector)! : el, pseudo);
    const resolve = (value: string) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = value;
      el.appendChild(probe);
      const out = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return out;
    };
    const old = document.createElement("div");
    old.className = [...el.classList].filter((name) => /^grad-\d+$/.test(name)).join(" ");
    old.style.background = "linear-gradient(155deg, var(--g1), var(--g2))";
    el.appendChild(old);
    const mainGradient = getComputedStyle(old).backgroundImage;
    old.remove();
    const chip = css(".card-bg", "::before");
    return {
      colorScheme: css(null).colorScheme,
      title: css("h3").color,
      titleShadow: css("h3").textShadow,
      meta: css("p").color,
      bgImage: css(".card-bg").backgroundImage,
      mainGradient,
      paper: [resolve("var(--paper-1)"), resolve("var(--paper-2)")],
      chip: { content: chip.content, width: chip.width, height: chip.height },
      more: css(".card-more").backgroundColor,
      moreInk: css(".card-more").color,
      chat: css(".chat-row").backgroundColor,
      chatInk: css(".chat-row").color,
      menuSurface: resolve("var(--sheet)"),
      ring: css(null).boxShadow,
    };
  });
}

/** Computed paint of one compact row. */
function readRow(row: Locator) {
  return row.evaluate((el) => {
    const resolve = (value: string) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = value;
      el.appendChild(probe);
      const out = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return out;
    };
    const ink = (selector: string) => getComputedStyle(el.querySelector(selector)!).color;
    const chip = getComputedStyle(el, "::before");
    return {
      color: getComputedStyle(el).color,
      bgImage: getComputedStyle(el).backgroundImage,
      shadow: getComputedStyle(el).boxShadow,
      paper: [resolve("var(--paper-1)"), resolve("var(--paper-2)")],
      wash: resolve("var(--row-wash)"),
      chip: { content: chip.content, width: chip.width, height: chip.height, background: chip.backgroundColor },
      title: ink(".compact-title"),
      when: ink(".compact-when"),
    };
  });
}

const flat = (css: string, behind: Rgb) => {
  const parsed = parseCss(css);
  return over(parsed.rgb, parsed.alpha, behind);
};
const paperStops = (paper: string[]) => paper.map((value) => parseCss(value).rgb);

function assertAA(ink: string, behind: Rgb[], what: string) {
  for (const stop of behind) {
    const value = contrast(flat(ink, stop), stop);
    assert.ok(value >= 4.5, `${what}: ${value.toFixed(2)}:1`);
  }
}

async function checkLightCard(card: Locator, tag: string) {
  const seen = await readCard(card);
  assert.notEqual(seen.colorScheme, "dark", `${tag}: not the dark colour scheme`);
  assert.equal(seen.colorScheme, "light", `${tag}: light colour scheme`);
  assert.equal(seen.title, INK, `${tag}: near-black title`);
  assert.equal(seen.titleShadow, "none", `${tag}: no text shadow on paper`);
  const stops = paperStops(seen.paper);
  for (const stop of stops) assert.ok(luminance(stop) > 0.6, `${tag}: paper is light, got ${stop}`);
  assert.match(seen.bgImage, /linear-gradient\(160deg/, `${tag}: the card paints paper`);
  assert.notEqual(seen.bgImage, seen.mainGradient, `${tag}: not the dark gradient`);
  assert.deepEqual(seen.chip, { content: '""', width: "36px", height: "28px" }, `${tag}: the 36x28 chip`);
  assertAA(seen.title, stops, `${tag} title`);
  assertAA(seen.meta, stops, `${tag} meta line`);
  assertAA(seen.moreInk, stops, `${tag} ⋯ icon`);
  assertAA(seen.chatInk, stops, `${tag} chat row`);
  for (const [what, surface] of [["⋯", seen.more], ["chat row", seen.chat]] as const) {
    for (const stop of stops) assert.ok(luminance(flat(surface, stop)) > 0.85, `${tag}: ${what} is a light surface`);
  }
  assert.equal(seen.menuSurface, WHITE, `${tag}: the card menu surface is white`);
  return seen;
}

async function checkDarkCard(card: Locator, tag: string) {
  const seen = await readCard(card);
  assert.equal(seen.colorScheme, "dark", `${tag}: dark colour scheme`);
  assert.equal(seen.title, WHITE, `${tag}: white title`);
  assert.equal(seen.titleShadow, "rgba(0, 0, 0, 0.45) 0px 1px 8px", `${tag}: the old title shadow`);
  assert.equal(seen.chip.width === "36px" && seen.chip.height === "28px", false, `${tag}: no option A chip`);
  assert.ok(seen.chip.content === "none" || seen.chip.content === "normal", `${tag}: ::before is empty, got ${seen.chip.content}`);
  assert.equal(seen.menuSurface, "rgb(28, 28, 30)", `${tag}: the card menu surface is the old dark one`);
  for (const [what, surface] of [["⋯", seen.more], ["chat row", seen.chat]] as const) {
    assert.ok(luminance(flat(surface, [28, 28, 30])) < 0.05, `${tag}: ${what} is dark glass`);
  }
  assert.equal(seen.chatInk, WHITE, `${tag}: white chat type`);
  return seen;
}

async function checkRing(card: Locator, scheme: Scheme, tag: string) {
  const { ring } = await readCard(card);
  if (scheme === "dark") {
    assert.match(ring, /rgb\(255, 45, 120\) 0px 0px 0px 2px/, `${tag}: the old 2px ring`);
    assert.match(ring, /rgba\(255, 45, 120, 0\.45\) 0px 0px 22px 0px/, `${tag}: the old neon bloom`);
    return;
  }
  assert.match(ring, /rgb\(224, 17, 95\) 0px 0px 0px 2px/, `${tag}: the softer ring`);
  assert.match(ring, /rgba\(224, 17, 95, 0\.3\) 0px 8px 22px -8px/, `${tag}: a small bloom`);
  assert.doesNotMatch(ring, /255, 45, 120|0px 0px 22px/, `${tag}: not the neon bloom`);
}

async function checkRows(page: Page, ids: Awaited<ReturnType<typeof seed>>, scheme: Scheme, tag: string) {
  const plan = await readRow(page.locator(`.compact-row[data-plan="${ids.plan.id}"]`));
  const now = await readRow(page.locator(`.compact-row[data-social="${ids.social.id}"]`));
  if (scheme === "dark") {
    assert.deepEqual(plan.chip.width === "22px", false, `${tag}: no light chip on a plan row`);
    assert.ok(plan.chip.content === "none" || plan.chip.content === "normal", `${tag}: no ::before on a quiet row`);
    assert.equal(now.chip.width, "8px", `${tag}: the 8px dot`);
    assert.equal(now.chip.background, "rgb(255, 45, 120)", `${tag}: the pink dot`);
    assert.match(now.shadow, /rgb\(255, 45, 120\) 0px 0px 0px 2px inset/, `${tag}: the old inset ring`);
    assert.equal(now.color, WHITE, `${tag}: row type is the page text`);
    return;
  }
  for (const [name, row] of [["plan row", plan], ["live row", now]] as const) {
    assert.equal(row.color, INK, `${tag} ${name}: near-black type`);
    assert.deepEqual([row.chip.width, row.chip.height], ["22px", "22px"], `${tag} ${name}: the 22px chip`);
    const stops = paperStops(row.paper);
    for (const stop of stops) assert.ok(luminance(stop) > 0.6, `${tag} ${name}: paper is light`);
    const behind = stops.map((stop) => { const wash = parseCss(row.wash); return wash.alpha > 0 ? over(wash.rgb, wash.alpha, stop) : stop; });
    assertAA(row.title, behind, `${tag} ${name} title`);
    assertAA(row.when, behind, `${tag} ${name} date`);
    assert.match(row.bgImage, /linear-gradient\(160deg/, `${tag} ${name}: paper, not the grey tint`);
  }
  assert.match(now.shadow, /rgb\(224, 17, 95\) 0px 0px 0px 2px inset/, `${tag}: the softer inset ring`);
  assert.doesNotMatch(now.shadow, /255, 45, 120/, `${tag}: no neon pink`);
}

for (const { name, os, forced, scheme } of SCENARIOS) {
  test(`${name}: home cards and compact rows paint ${scheme} (option A)`, { timeout: 180_000 }, async () => {
    const ids = await seed();
    const page = await openAs(ids.finn.token, os, forced);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      assert.equal(await page.locator("html").getAttribute("data-ak-scheme"), forced, `${name}: the forced scheme`);
      const plan = page.locator(`.card-plan[data-plan="${ids.plan.id}"]`);
      const social = page.locator(`article.card-now[data-social="${ids.social.id}"]`);
      await social.waitFor();
      const check = scheme === "light" ? checkLightCard : checkDarkCard;
      const planSeen = await check(plan, `${name} plan card`);
      await check(social, `${name} social card`);
      await checkRing(social, scheme, `${name} live card`);
      if (scheme === "dark") assert.equal(planSeen.bgImage, planSeen.mainGradient, `${name}: the plan gradient is main's, unchanged`);
      await shot(page, `cards-${name}`);

      await page.getByRole("group", { name: "Event list" }).getByRole("button", { name: "Compact" }).click();
      await page.locator(".compact-row").first().waitFor();
      await checkRows(page, ids, scheme, `${name} compact`);
      await shot(page, `compact-${name}`);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}

for (const { name, os, forced } of SCENARIOS.filter((one) => one.scheme === "light")) {
  test(`${name}: a tap opens the card, I'm in is a solid black pill, and the card menu is light`, { timeout: 180_000 }, async () => {
    const ids = await seed();
    const page = await openAs(ids.finn.token, os, forced);
    try {
      const card = page.locator(`.card-plan[data-plan="${ids.plan.id}"]`);
      await card.locator(".card-body").click();
      const details = page.getByRole("dialog", { name: "Details" });
      await details.waitFor();
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "detached" });

      const toggle = card.locator(".in-toggle");
      const off = await toggle.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el).color }));
      assert.equal(off.ink, INK, "I'm in is outlined, with near-black type, until tapped");
      await toggle.click();
      await card.locator(".in-toggle.on").waitFor();
      await settle(page);
      const on = await card.locator(".in-toggle.on").evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el).color, shadow: getComputedStyle(el).boxShadow }));
      assert.equal(on.bg, INK, "In is a solid near-black pill");
      assert.equal(on.ink, WHITE, "with white type");
      assert.equal(on.shadow, "none");
      assert.ok(contrast(parseCss(on.ink).rgb, parseCss(on.bg).rgb) >= 4.5, "AA on the pill");
      await shot(page, `in-on-${name}`);

      await card.locator(".card-more").click();
      const menu = page.locator(".card-menu");
      await menu.waitFor();
      await settle(page);
      assert.equal(await menu.evaluate((el) => getComputedStyle(el).backgroundColor), WHITE, "the menu is a light surface");
      const ink = await menu.locator("button").first().evaluate((el) => getComputedStyle(el).color);
      assert.ok(contrast(parseCss(ink).rgb, [255, 255, 255]) >= 4.5, `menu type is readable, got ${ink}`);
      await shot(page, `menu-${name}`);
    } finally {
      await page.context().close();
    }
  });
}

test("a compact row still opens its event in light, and map cards and plan sheet heads stay dark art", { timeout: 180_000 }, async () => {
  const ids = await seed();
  const page = await openAs(ids.finn.token, "light", null);
  try {
    await page.getByRole("group", { name: "Event list" }).getByRole("button", { name: "Compact" }).click();
    await page.locator(`.compact-row[data-plan="${ids.plan.id}"]`).click();
    const head = page.locator(".sheet .sheet-head.card-grad");
    await head.waitFor();
    const seen = await head.evaluate((el) => ({ colorScheme: getComputedStyle(el).colorScheme, color: getComputedStyle(el).color, image: getComputedStyle(el).backgroundImage }));
    assert.equal(seen.colorScheme, "dark", "the sheet head stays dark art in light");
    assert.equal(seen.color, WHITE);
    assert.match(seen.image, /linear-gradient\(155deg/);
    await shot(page, "sheet-head-light");
  } finally {
    await page.context().close();
  }
});

test("light cards keep their layout at every phone size: nothing sideways, chip beside the avatars", { timeout: 240_000 }, async () => {
  const ids = await seed();
  for (const size of SIZES) {
    const tag = `${size[0]}x${size[1]}`;
    const page = await openAs(ids.finn.token, "light", null, size);
    try {
      for (const card of await page.locator(".card").all()) {
        const fits = await card.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const inside = [...el.querySelectorAll(".card-body, .chat-row, .in-toggle, .card-more")].every((node) => {
            const at = node.getBoundingClientRect();
            return at.left >= box.left - 1 && at.right <= box.right + 1;
          });
          return inside && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
        });
        assert.equal(fits, true, `${tag}: a card stays inside the screen`);
      }
      await shot(page, `layout-${tag}`);
    } finally {
      await page.context().close();
    }
  }
});
