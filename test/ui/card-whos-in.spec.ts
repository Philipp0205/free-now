import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
const SHOT_DIR = path.resolve("test/ui/screenshots/card-whos-in");
const ISSUES = "/workspace/hangry-issues";

const hangry = useHangry({ tz: "UTC" });

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

function publish(name: string, target: string) {
  if (fs.existsSync(ISSUES)) fs.copyFileSync(shot(name), path.join(ISSUES, target));
}

async function circle() {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const { circle } = await hangry.call("POST", "/api/circles", host.token, { name: "Test crew" });
  const join = (name: string) => hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name, code: circle.inviteCode });
  return { host, alex: await join("Alex"), bea: await join("Bea"), cy: await join("Cy") };
}

async function open(token: string, width: number, height: number, mobile = true): Promise<Page> {
  const context = await hangry.browser.newContext(mobile
    ? { viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA }
    : { viewport: { width, height }, deviceScaleFactor: 1 });
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

/** The card's own content (avatars, who-row); the chat row below it is the event chat, not the who-row. */
const body = (card: Locator) => card.locator(".card-body");

/** Initials in the card's avatar stack, in order. */
async function faces(card: Locator) {
  return card.locator(".avatars > .avatar").evaluateAll((nodes) => nodes.map((node) => (node.textContent || "").trim()));
}

/** The detail sheet, split into the Who's in, Maybe and Can't make it lists. */
async function sheetLists(page: Page) {
  const details = page.getByRole("dialog", { name: "Details" });
  await details.waitFor();
  const text = (selector: string) => details.locator(selector).evaluateAll((nodes) => nodes.map((node) => (node.textContent || "").trim()));
  return {
    titles: await text(".members-title"),
    inLines: await text(".sheet-scroll > .list:not(.cant-list):not(.maybe-list) .reply-line"),
    maybeLines: await text(".sheet-scroll > .maybe-list .reply-line"),
    cantLines: await text(".sheet-scroll > .cant-list .reply-line"),
  };
}

async function fitsWidth(page: Page, card: Locator) {
  const box = await card.boundingBox();
  assert.ok(box, "card has a box");
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `card fits: ${box.x}+${box.width} in ${width}`);
  const stack = await card.locator(".avatars").boundingBox();
  assert.ok(stack && stack.x + stack.width <= box.x + box.width, "the avatar stack stays inside the card");
}

test("a plan card counts who's in; maybe has its own line and list, and can't is only in the details", { timeout: 240_000 }, async () => {
  const { host, alex, bea, cy } = await circle();
  const { plan } = await hangry.call("POST", "/api/plans", host.token, { note: "Pizza night", time: "19:00" });
  await hangry.call("POST", `/api/plans/${plan.id}/reply`, alex.token, { reply: "in" });
  await hangry.call("POST", `/api/plans/${plan.id}/reply`, bea.token, { reply: "can't" });
  await hangry.call("POST", `/api/plans/${plan.id}/reply`, cy.token, { reply: "maybe" });

  const layouts: Array<[number, number, boolean]> = [...SIZES.map(([w, h]) => [w, h, true] as [number, number, boolean]), [1280, 800, false]];
  for (const [width, height, mobile] of layouts) {
    const page = await open(host.token, width, height, mobile);
    try {
      const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
      const who = card.locator(".who-row");
      await who.locator(".reply-line", { hasText: "Alex is in" }).waitFor();
      const lines = await who.locator(".reply-line").allInnerTexts();
      assert.deepEqual(lines, ["Alex is in", "Cy is maybe"], `who-row at w${width}`);
      assert.equal(await body(card).getByText(/Bea can't/).count(), 0, "no can't line on the card");
      assert.deepEqual(await faces(card), ["H", "A"], "host and in in the stack; maybe and Bea are not");
      await fitsWidth(page, card);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: shot(`plan-card-w${width}.png`) });
      if (width === 360) publish("plan-card-w360.png", "93-card-whos-in-360.png");
      if (width === 1280) publish("plan-card-w1280.png", "93-card-whos-in-1280.png");

      await who.click();
      const lists = await sheetLists(page);
      assert.deepEqual(lists.titles, ["Who's in", "Maybe", "Can't make it"]);
      assert.deepEqual(lists.inLines, ["Hana · host", "Alex is in"]);
      assert.deepEqual(lists.maybeLines, ["Cy is maybe"]);
      assert.deepEqual(lists.cantLines, ["Bea can't"]);
      const details = page.getByRole("dialog", { name: "Details" });
      await details.getByRole("button", { name: "Remove Alex" }).waitFor();
      assert.equal(await details.getByRole("button", { name: "Remove Bea" }).count(), 0);
      await page.screenshot({ path: shot(`plan-detail-w${width}.png`) });
      if (width === 360) publish("plan-detail-w360.png", "93-card-whos-in-detail-360.png");
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "detached" });
    } finally {
      await page.context().close();
    }
  }
});

test("a social card drops a decline from the row; the details list it under Can't make it", { timeout: 120_000 }, async () => {
  const { host, alex, bea } = await circle();
  const { social } = await hangry.call("POST", "/api/socials", host.token, { note: "Coffee run" });
  await hangry.call("POST", `/api/socials/${social.id}/reply`, alex.token, { reply: "in" });
  await hangry.call("POST", `/api/socials/${social.id}/reply`, bea.token, { reply: "declined" });

  const page = await open(alex.token, 360, 640);
  try {
    const card = page.locator(`.card-now[data-social="${social.id}"]`);
    const who = card.locator(".who-row");
    await who.locator(".reply-line", { hasText: "You're in" }).waitFor();
    assert.deepEqual(await who.locator(".reply-line").allInnerTexts(), ["You're in"]);
    assert.equal(await body(card).getByText(/can't/).count(), 0);
    assert.deepEqual(await faces(card), ["H", "A"]);
    await page.screenshot({ path: shot("social-card-w360.png") });
    await who.click();
    const lists = await sheetLists(page);
    assert.deepEqual(lists.titles, ["Who's in", "Can't make it"]);
    assert.deepEqual(lists.inLines, ["Hana · host", "You're in"]);
    assert.deepEqual(lists.cantLines, ["Bea can't"]);
    await page.screenshot({ path: shot("social-detail-w360.png") });
  } finally {
    await page.context().close();
  }
});

test("when the only reply is can't, the card still says Waiting for friends", { timeout: 180_000 }, async () => {
  const { host, bea } = await circle();
  const { plan } = await hangry.call("POST", "/api/plans", host.token, { note: "Lake walk", time: "10:00" });
  await hangry.call("POST", `/api/plans/${plan.id}/reply`, bea.token, { reply: "can't" });

  for (const [width, height] of [[320, 568], [360, 640]] as Array<[number, number]>) {
    const page = await open(host.token, width, height);
    try {
      const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
      const who = card.locator(".who-row", { hasText: "Waiting for friends" });
      await who.waitFor();
      assert.equal(await body(card).getByText(/can't/).count(), 0);
      assert.deepEqual(await faces(card), ["H"], "only the host");
      await fitsWidth(page, card);
      await page.screenshot({ path: shot(`only-cant-w${width}.png`) });
      await who.click();
      const lists = await sheetLists(page);
      assert.deepEqual(lists.inLines, ["Hana · host"]);
      assert.deepEqual(lists.cantLines, ["Bea can't"]);
      await page.screenshot({ path: shot(`only-cant-detail-w${width}.png`) });
    } finally {
      await page.context().close();
    }
  }
});

test("saying Can't make it from the menu takes you off the card and into the details", { timeout: 120_000 }, async () => {
  const { host, alex } = await circle();
  const { plan } = await hangry.call("POST", "/api/plans", host.token, { note: "Movie night", time: "20:00" });
  await hangry.call("POST", `/api/plans/${plan.id}/reply`, alex.token, { reply: "in" });

  const page = await open(alex.token, 360, 640);
  try {
    const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
    await card.locator(".who-row", { hasText: "You're in" }).waitFor();
    assert.deepEqual(await faces(card), ["H", "A"]);
    await card.locator(".card-more").click();
    await page.getByRole("menuitem", { name: "Can't make it" }).click();
    await card.locator(".who-row", { hasText: "Waiting for friends" }).waitFor();
    assert.equal(await body(card).getByText(/can't|You're in/).count(), 0);
    assert.deepEqual(await faces(card), ["H"]);
    assert.equal(await card.locator(".in-toggle").getAttribute("aria-pressed"), "false");
    const saved = await hangry.call("GET", "/api/plans", alex.token);
    assert.equal(saved.plans[0].joined[0].reply, "declined");
    await card.locator(".who-row").click();
    const lists = await sheetLists(page);
    assert.deepEqual(lists.inLines, ["Hana · host"]);
    assert.deepEqual(lists.cantLines, ["You can't make it"]);
  } finally {
    await page.context().close();
  }
});

test("a full plan keeps the stack readable at 320 with a +N", { timeout: 120_000 }, async () => {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const { circle } = await hangry.call("POST", "/api/circles", host.token, { name: "Big crew" });
  const { plan } = await hangry.call("POST", "/api/plans", host.token, { note: "Picnic", time: "13:00" });
  for (const name of ["Alex", "Bea", "Cy", "Dee", "Eli", "Fay", "Gus", "Ivy"]) {
    const friend = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name, code: circle.inviteCode });
    await hangry.call("POST", `/api/plans/${plan.id}/reply`, friend.token, { reply: name === "Ivy" ? "can't" : "in" });
  }
  const page = await open(host.token, 320, 568);
  try {
    const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
    await card.locator(".avatars .avatar-more", { hasText: "+2" }).waitFor();
    assert.deepEqual(await faces(card), ["H", "A", "B", "C", "D", "E", "+2"]);
    await fitsWidth(page, card);
    assert.equal(await body(card).getByText(/Ivy/).count(), 0);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot("many-w320.png") });
  } finally {
    await page.context().close();
  }
});
