import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Locator, Page } from "playwright-core";
import type { PushPayload, PushSender, PushSubscription } from "../../src/push/push.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, openEventsMap, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
/** Screenshots of the menu and the sheet. Override with SCM_SHOT_DIR=/some/folder. */
const SHOT_DIR = path.resolve(process.env.SCM_SHOT_DIR || "/workspace/hangry-share-circles-artifacts");

const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
const fakePush: PushSender = {
  async send(subscription: PushSubscription, payload: PushPayload) { sent.push({ endpoint: subscription.endpoint, payload }); },
};

const hangry = useHangry({ tz: TZ, push: fakePush });
const { call } = hangry;

type Person = { token: string; user: { id: string; name: string } };

/** Ana is in Friends and Climbing. Ben is only in Friends, Cleo only in Climbing. */
async function seed(tag: string) {
  const ana: Person = await call("POST", "/api/auth/start", undefined, { name: "Ana" });
  const friends = (await call("POST", "/api/circles", ana.token, { name: "Friends" })).circle;
  const climbing = (await call("POST", "/api/circles", ana.token, { name: "Climbing" })).circle;
  const ben: Person = await call("POST", "/api/auth/start", undefined, { name: "Ben", code: friends.inviteCode });
  const cleo: Person = await call("POST", "/api/auth/start", undefined, { name: "Cleo", code: climbing.inviteCode });
  const ends = { ben: `https://push.example/ben-${tag}`, cleo: `https://push.example/cleo-${tag}` };
  await call("POST", "/api/push/subscribe", ben.token, { endpoint: ends.ben, keys: { p256dh: "p", auth: "a" } });
  await call("POST", "/api/push/subscribe", cleo.token, { endpoint: ends.cleo, keys: { p256dh: "p", auth: "a" } });
  return { ana, ben, cleo, friends, climbing, ends };
}

async function phone(width: number, height: number, token: string, circleId?: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, timezoneId: TZ });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    if (circle) localStorage.setItem("fn_circle", circle);
  }, [token, circleId ?? ""] as const);
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

/** Fully inside the viewport, and nothing scrolls sideways. */
async function fits(page: Page, locator: Locator, where: string) {
  const box = await locator.boundingBox();
  const size = page.viewportSize()!;
  assert.ok(box, `${where}: has a box`);
  assert.ok(box.x >= 0 && box.x + box.width <= size.width + 0.5, `${where}: inside the width ${JSON.stringify(box)}`);
  assert.ok(box.y >= 0 && box.y + box.height <= size.height + 0.5, `${where}: inside the height ${JSON.stringify(box)}`);
  const doc = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(doc <= 0, `${where}: no horizontal overflow (${doc})`);
}

const planCard = (page: Page, note: string) => page.locator(".card-plan", { has: page.getByRole("heading", { name: note }) });
const menuTexts = (page: Page) => page.getByRole("menu").getByRole("menuitem").allInnerTexts();

async function openMenu(page: Page, card: Locator) {
  await card.locator(".card-more").click();
  await page.getByRole("menu").waitFor();
}

async function openShare(page: Page, note: string) {
  await openMenu(page, planCard(page, note));
  await page.getByRole("menuitem", { name: "Share with other circles", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share with other circles" });
  await sheet.waitFor();
  return sheet;
}

const climbingChip = (sheet: Locator) => sheet.getByRole("group", { name: "Your other circles" }).getByRole("button", { name: "Climbing" });
const circlesOf = async (token: string, planId: string, circleId: string) =>
  ((await call("GET", `/api/plans?circle=${circleId}`, token)).plans as Array<any>)
    .find((plan) => plan.id === planId)?.circles.map((circle: { name: string }) => circle.name);

for (const [width, height] of SIZES) {
  test(`at ${width}: the host shares from ⋯, unshares, cancels, and retries a failed save`, { timeout: 120_000 }, async () => {
    const { ana, friends, climbing, ends } = await seed(`${width}`);
    const note = `Crag ${width}`;
    const plan = (await call("POST", `/api/plans?circle=${friends.id}`, ana.token, { note, time: "18:30" })).plan;
    await call("PATCH", `/api/plans/${plan.id}?circle=${friends.id}`, ana.token, { description: "Bring chalk" });
    const { page, errors } = await phone(width, height, ana.token, friends.id);
    try {
      const card = planCard(page, note);
      await card.waitFor();

      // Menu: first item. The external Share link is a button on the card now, not in ⋯.
      await openMenu(page, card);
      const texts = await menuTexts(page);
      assert.equal(texts[0], "Share with other circles", JSON.stringify(texts));
      assert.equal(texts.includes("Share link"), false, JSON.stringify(texts));
      assert.equal(await card.locator(".card-share").count(), 1, "card Share button stays separate");
      await fits(page, page.getByRole("menu"), "menu");
      await shot(page, "1-menu");
      await page.getByRole("menuitem", { name: "Share with other circles" }).click();

      // Sheet: Friends fixed, Climbing off, fits the phone.
      let sheet = page.getByRole("dialog", { name: "Share with other circles" });
      await sheet.waitFor();
      await sheet.getByText("Same plan, same chat and guest list. New circles get one notification.").waitFor();
      const fixed = sheet.locator(".chip-fixed");
      assert.equal((await fixed.innerText()).trim(), "Friends");
      assert.notEqual(await fixed.evaluate((node) => node.tagName), "BUTTON", "home circle is not toggleable");
      const group = sheet.getByRole("group", { name: "Your other circles" });
      assert.deepEqual(await group.getByRole("button").allInnerTexts(), ["Climbing"]);
      assert.equal(await climbingChip(sheet).getAttribute("aria-pressed"), "false");
      await fits(page, sheet, "sheet");
      await fits(page, sheet.getByRole("button", { name: "Save" }), "Save");
      await fits(page, sheet.getByRole("button", { name: "Cancel" }), "Cancel");
      await shot(page, "2-sheet");

      // Toggle + Save: circles only, toast, card line, Cleo gets one new-plan push, Ben none.
      await climbingChip(sheet).click();
      assert.equal(await climbingChip(sheet).getAttribute("aria-pressed"), "true");
      await shot(page, "3-sheet-picked");
      const before = sent.length;
      const patched = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes(`/api/plans/${plan.id}`));
      await sheet.getByRole("button", { name: "Save" }).click();
      assert.deepEqual((await patched).request().postDataJSON(), { circleIds: [friends.id, climbing.id] });
      await sheet.waitFor({ state: "detached" });
      await page.locator(".toast", { hasText: "Shared with 2 circles" }).waitFor();
      await card.locator(".plan-circles", { hasText: "Friends + Climbing" }).waitFor();
      await shot(page, "4-shared-toast");
      const pushes = sent.slice(before);
      assert.equal(pushes.filter((item) => item.endpoint === ends.cleo && item.payload.tag === `plan:${plan.id}`).length, 1);
      assert.equal(pushes.filter((item) => item.endpoint === ends.ben).length, 0);
      const fresh = (await call("GET", `/api/plans?circle=${friends.id}`, ana.token)).plans.find((row: any) => row.id === plan.id);
      assert.equal(fresh.description, "Bring chalk");
      assert.equal(fresh.time, "18:30");

      // Cancel discards a toggle.
      sheet = await openShare(page, note);
      assert.equal(await climbingChip(sheet).getAttribute("aria-pressed"), "true", "reflects the current set");
      await climbingChip(sheet).click();
      const quiet = sent.length;
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await sheet.waitFor({ state: "detached" });
      assert.deepEqual(await circlesOf(ana.token, plan.id, friends.id), ["Friends", "Climbing"]);
      assert.equal(sent.length, quiet);
      sheet = await openShare(page, note);
      assert.equal(await climbingChip(sheet).getAttribute("aria-pressed"), "true", "Cancel left nothing behind");

      // A failed save keeps the sheet and the pick; the retry goes through.
      await climbingChip(sheet).click();
      let fail = true;
      await page.route(`**/api/plans/${plan.id}`, (route) => {
        if (fail && route.request().method() === "PATCH") {
          fail = false;
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
        }
        return route.fallback();
      });
      await sheet.getByRole("button", { name: "Save" }).click();
      await sheet.getByRole("alert").filter({ hasText: "Something went wrong. Try again." }).waitFor();
      assert.equal(await climbingChip(sheet).getAttribute("aria-pressed"), "false", "selection intact");
      assert.equal(await sheet.getByRole("button", { name: "Save" }).isDisabled(), false);
      await shot(page, "5-sheet-error");
      assert.deepEqual(await circlesOf(ana.token, plan.id, friends.id), ["Friends", "Climbing"]);
      const unshare = sent.length;
      await sheet.getByRole("button", { name: "Save" }).click();
      await sheet.waitFor({ state: "detached" });
      await page.locator(".toast", { hasText: "Now only in Friends" }).waitFor();
      await card.waitFor();
      assert.equal(await card.locator(".plan-circles").count(), 0);
      assert.deepEqual(await circlesOf(ana.token, plan.id, friends.id), ["Friends"]);
      assert.equal(sent.length, unshare, "unsharing pings nobody");

      // The Edit sheet has no circle chips any more.
      await openMenu(page, card);
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "Edit" });
      await edit.getByRole("button", { name: "Save" }).waitFor();
      assert.equal(await edit.getByText("Also share with").count(), 0);
      assert.equal(await edit.locator(".also-circles").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}

test("the item is hidden for a member, a one-circle host, and a free post", { timeout: 120_000 }, async () => {
  const { ana, ben, friends } = await seed("hidden");
  await call("POST", `/api/plans?circle=${friends.id}`, ana.token, { note: "Ana's plan", time: "19:00" });
  // Ben is only in Friends, so his own plan has nowhere else to go.
  await call("POST", `/api/plans?circle=${friends.id}`, ben.token, { note: "Ben's plan", time: "19:00" });
  await call("POST", `/api/socials?circle=${friends.id}`, ana.token, { note: "Ana free" });
  for (const [width, height] of SIZES) {
    const benPhone = await phone(width, height, ben.token, friends.id);
    try {
      const { page } = benPhone;
      for (const note of ["Ana's plan", "Ben's plan"]) {
        const card = planCard(page, note);
        await card.waitFor();
        await openMenu(page, card);
        const texts = await menuTexts(page);
        assert.equal(texts.includes("Share link"), false, JSON.stringify(texts));
        assert.equal(texts.includes("Share with other circles"), false, `${note}: ${JSON.stringify(texts)}`);
        await card.getByRole("button", { name: `Share ${note}`, exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "detached" });
      }
      assert.deepEqual(benPhone.errors, []);
    } finally {
      await benPhone.page.context().close();
    }
    const anaPhone = await phone(width, height, ana.token, friends.id);
    try {
      const { page } = anaPhone;
      const social = page.locator(".card-now", { hasText: "Ana free" });
      await social.waitFor();
      await openMenu(page, social);
      const texts = await menuTexts(page);
      assert.equal(texts.includes("Share with other circles"), false, `free post: ${JSON.stringify(texts)}`);
      assert.deepEqual(anaPhone.errors, []);
    } finally {
      await anaPhone.page.context().close();
    }
  }
});

test("the map card's ⋯ offers it to the host too", { timeout: 60_000 }, async () => {
  const { ana, friends } = await seed("map");
  await call("POST", `/api/plans?circle=${friends.id}`, ana.token, {
    note: "Map crag", time: "18:00", place: "Hall", lat: 52.5, lng: 13.4, precise: true,
  });
  const { page, errors } = await phone(360, 640, ana.token, friends.id);
  try {
    await openEventsMap(page);
    const pin = page.locator(".leaflet-marker-icon.pin").first();
    await pin.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await pin.click();
    const card = page.locator(".map-card");
    await card.waitFor();
    await openMenu(page, card);
    const texts = await menuTexts(page);
    assert.equal(texts[0], "Share with other circles", JSON.stringify(texts));
    assert.equal(texts.includes("Share link"), false, JSON.stringify(texts));
    await card.getByRole("button", { name: "Share Map crag", exact: true }).waitFor();
    await page.getByRole("menuitem", { name: "Share with other circles" }).click();
    await page.getByRole("dialog", { name: "Share with other circles" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await page.context().close();
  }
});
