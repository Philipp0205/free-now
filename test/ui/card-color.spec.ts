import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { GRADIENT_COUNT, gradientClass } from "../../public/js/card-grad.js";
import { contrast, parseCss } from "../contrast.js";
import { openPlanSheet } from "./plan-sheet.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA, dismissPaymentReminder, openEventsMap, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/card-color");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

const gradOf = (node: Locator) => node.evaluate((el) => [...el.classList].find((name) => /^grad-\d+$/.test(name)) ?? "");
const planCard = (page: Page, id: string) => page.locator(`.card-plan[data-plan="${id}"]`);
const planRow = (page: Page, id: string) => page.locator(`.compact-row[data-plan="${id}"]`);
const palette = (page: Page) => page.getByRole("radiogroup", { name: "Card color" });
const slotRadio = (page: Page, slot: number) => palette(page).getByRole("radio", { name: `Color ${slot + 1} of ${GRADIENT_COUNT}` });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

/** Hana hosts a circle with Finn in it. */
async function seed() {
  const start = (name: string, code?: string) =>
    call("POST", "/api/auth/start", undefined, { email: testEmail(), name, ...(code ? { code } : {}) });
  const host = await start("Hana");
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Test crew" });
  const friend = await start("Finn", circle.inviteCode);
  hangry.confirmEmails();
  return { host, friend };
}

async function openAs(token: string, width: number, height: number, scheme: "dark" | "light" = "dark"): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
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
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn/, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await dismissPaymentReminder(page);
  return page;
}

async function showCompact(page: Page) {
  await page.getByRole("group", { name: "Event list" }).getByRole("button", { name: "Compact" }).click();
  await page.locator(".compact-row").first().waitFor();
}

async function showCards(page: Page) {
  await page.getByRole("group", { name: "Event list" }).getByRole("button", { name: "Cards" }).click();
  await page.locator(".card-plan").first().waitFor();
}

/** The card, the compact row and the details head all show this slot. */
async function assertEverywhere(page: Page, id: string, cls: string, tag: string) {
  await showCards(page);
  assert.equal(await gradOf(planCard(page, id)), cls, `${tag}: card`);
  await planCard(page, id).locator(".card-body").click();
  const head = page.locator(".sheet .sheet-head");
  await head.waitFor();
  assert.equal(await gradOf(head), cls, `${tag}: details head`);
  await page.locator(".scrim").click({ position: { x: 10, y: 10 } });
  await head.waitFor({ state: "detached" });
  await showCompact(page);
  assert.equal(await gradOf(planRow(page, id)), cls, `${tag}: compact row`);
  await showCards(page);
}

/** White type on the card and the compact title and date stay at 4.5:1 on both tint stops. */
async function assertReadable(page: Page, id: string, tag: string) {
  const title = planCard(page, id).locator("h3");
  assert.equal(await title.evaluate((node) => getComputedStyle(node).color), "rgb(255, 255, 255)", `${tag}: card type is white`);
  await showCompact(page);
  const seen = await planRow(page, id).evaluate((el) => {
    const resolve = (value: string) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = value;
      el.appendChild(probe);
      const out = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return out;
    };
    const ink = (selector: string) => getComputedStyle(el.querySelector(selector)!).color;
    return { t1: resolve("var(--row-t1)"), t2: resolve("var(--row-t2)"), title: ink(".compact-title"), when: ink(".compact-when") };
  });
  for (const stop of [seen.t1, seen.t2]) {
    for (const [what, ink] of [["title", seen.title], ["date", seen.when]] as const) {
      const value = contrast(parseCss(ink).rgb, parseCss(stop).rgb);
      assert.ok(value >= 4.5, `${tag}: compact ${what} is ${value.toFixed(2)}:1`);
    }
  }
  await showCards(page);
}

test("the host picks a color on the Plan sheet; card, compact row and details follow, a reload and a friend see it", { timeout: 240_000 }, async () => {
  const { host, friend } = await seed();
  const errors: string[] = [];
  const page = await openAs(host.token, 360, 640);
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openPlanSheet(page);
    const group = palette(page);
    await group.waitFor();
    assert.equal(await group.getByRole("radio").count(), GRADIENT_COUNT + 1, "Auto plus every slot");
    await group.getByRole("radio", { name: "Automatic color" }).waitFor();
    assert.equal(await group.getByRole("radio", { name: "Automatic color" }).isChecked(), true, "Auto is the start");
    await shot(page, "create-sheet-dark-360");

    await page.locator("#sheet-note").fill("Pizza night");
    await slotRadio(page, 9).check();
    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/plans"));
    await page.locator(".sheet-dock").getByRole("button", { name: "Add plan" }).click();
    const response = await created;
    assert.equal(response.request().postDataJSON().cardColor, 9);
    const plan = (await response.json()).plan;
    assert.equal(plan.cardColor, 9);
    await planCard(page, plan.id).waitFor();
    await assertEverywhere(page, plan.id, "grad-9", "host");
    await shot(page, "card-grad-9-dark-360");

    await page.reload();
    await page.locator(".tabbar").waitFor();
    await dismissPaymentReminder(page);
    await planCard(page, plan.id).waitFor();
    await assertEverywhere(page, plan.id, "grad-9", "host after reload");
    await assertReadable(page, plan.id, "dark");

    const other = await openAs(friend.token, 360, 640);
    try {
      await planCard(other, plan.id).waitFor();
      await assertEverywhere(other, plan.id, "grad-9", "friend");
      await shot(other, "friend-card-dark-360");
    } finally {
      await other.context().close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});

test("a plan with no pick keeps the id hash, in dark and in light, and the palette reads in both", { timeout: 240_000 }, async () => {
  const { host } = await seed();
  const plan = (await call("POST", "/api/plans", host.token, { note: "Board games", date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) })).plan;
  assert.equal(plan.cardColor, null);
  for (const scheme of ["dark", "light"] as const) {
    const page = await openAs(host.token, 320, 568, scheme);
    try {
      await planCard(page, plan.id).waitFor();
      await assertEverywhere(page, plan.id, gradientClass(plan.id), `${scheme} default`);
      await assertReadable(page, plan.id, scheme);
      await slotRadioSheet(page, scheme);
    } finally {
      await page.context().close();
    }
  }
});

/** Opens the Plan sheet only to look at the palette in this scheme, then leaves. */
async function slotRadioSheet(page: Page, scheme: string) {
  await openPlanSheet(page);
  await palette(page).waitFor();
  // The sheet scrolls, so bring the whole palette into view before looking at it.
  await palette(page).scrollIntoViewIfNeeded();
  const box = await palette(page).boundingBox();
  const dock = await page.locator(".sheet-dock").boundingBox();
  assert.ok(box && dock && box.y + box.height <= dock.y + 1, `${scheme}: the palette sits clear of the dock`);
  const swatch = page.locator(".color-auto");
  assert.ok(contrast(parseCss(await swatch.evaluate((node) => getComputedStyle(node).color)).rgb,
    parseCss(await page.locator(".sheet").evaluate((node) => getComputedStyle(node).backgroundColor)).rgb) >= 3, `${scheme}: the Auto label reads`);
  await shot(page, `create-sheet-${scheme}-320`);
  // At 320x568 the tall sheet covers the whole scrim, so close it with the scrim's own click.
  await page.locator(".scrim").dispatchEvent("click");
  await page.locator("#sheet-note").waitFor({ state: "detached" });
}

test("Edit changes the color with the keyboard, Auto goes back to the hash, and the map card follows", { timeout: 240_000 }, async () => {
  const { host, friend } = await seed();
  const plan = (await call("POST", "/api/plans", host.token, {
    note: "Rooftop drinks",
    date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    place: "Tempelhofer Feld",
    lat: 52.47,
    lng: 13.4,
    precise: true,
    cardColor: 12,
  })).plan;
  assert.equal(plan.cardColor, 12);
  const page = await openAs(host.token, 360, 640);
  try {
    await planCard(page, plan.id).waitFor();
    assert.equal(await gradOf(planCard(page, plan.id)), "grad-12");

    const openEdit = async () => {
      await planCard(page, plan.id).getByRole("button", { name: /^More for / }).click();
      await page.getByRole("menuitem", { name: "Edit" }).click();
      await palette(page).waitFor();
    };
    const save = async () => {
      const patched = page.waitForResponse((res) => res.request().method() === "PATCH" && res.url().includes(`/api/plans/${plan.id}`));
      await page.locator(".sheet-dock").getByRole("button", { name: "Save" }).click();
      const res = await patched;
      assert.equal(res.status(), 200);
      await page.locator("form.sheet").waitFor({ state: "detached" });
      return res.request().postDataJSON();
    };

    await openEdit();
    assert.equal(await slotRadio(page, 12).isChecked(), true, "Edit starts on the current pick");
    await shot(page, "edit-sheet-dark-360");
    await slotRadio(page, 12).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await slotRadio(page, 13).isChecked(), true, "arrow keys move the pick");
    assert.equal((await save()).cardColor, 13);
    await planCard(page, plan.id).waitFor();
    assert.equal(await gradOf(planCard(page, plan.id)), "grad-13");

    const friendPage = await openAs(friend.token, 360, 640);
    try {
      await planCard(friendPage, plan.id).waitFor();
      assert.equal(await gradOf(planCard(friendPage, plan.id)), "grad-13", "a friend sees the edit");
      await openEventsMap(friendPage);
      const pin = friendPage.locator(".leaflet-marker-icon.pin").first();
      await pin.waitFor({ timeout: 10_000 });
      await friendPage.waitForTimeout(400);
      await pin.click();
      const card = friendPage.locator(".map-card");
      await card.waitFor();
      assert.equal(await gradOf(card), "grad-13", "the map card follows the pick");
      assert.equal(await card.evaluate((node) => getComputedStyle(node).backgroundImage).then((value) => /linear-gradient/.test(value)), true);
      await shot(friendPage, "map-card-grad-13-360");
    } finally {
      await friendPage.context().close();
    }

    await openEdit();
    await palette(page).getByRole("radio", { name: "Automatic color" }).check();
    assert.equal((await save()).cardColor, null, "Auto sends null");
    await planCard(page, plan.id).waitFor();
    assert.equal(await gradOf(planCard(page, plan.id)), gradientClass(plan.id), "back to the id hash");
    await showCompact(page);
    assert.equal(await gradOf(planRow(page, plan.id)), gradientClass(plan.id));
    await shot(page, "compact-auto-dark-360");
  } finally {
    await page.context().close();
  }
});
