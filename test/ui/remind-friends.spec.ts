import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import type { PushPayload, PushSender, PushSubscription } from "../../src/push.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
/** Set to a folder to keep screenshots, for example RF_SHOT_DIR=/tmp/shots. */
const SHOT_DIR = process.env.RF_SHOT_DIR ? path.resolve(process.env.RF_SHOT_DIR) : "";

const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
const fakePush: PushSender = {
  async send(subscription: PushSubscription, payload: PushPayload) { sent.push({ endpoint: subscription.endpoint, payload }); },
};

const hangry = useHangry({ tz: TZ, push: fakePush });
const { call } = hangry;

async function phone(width: number, height: number, token: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
  }, token);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

/** The toast, and that it fits on screen without spilling sideways. */
async function toast(page: Page, text: string) {
  const node = page.locator(".toast", { hasText: text });
  await node.waitFor();
  const box = await node.boundingBox();
  const width = page.viewportSize()!.width;
  assert.ok(box && box.x >= 0 && box.x + box.width <= width + 0.5, `toast fits at ${width}: ${JSON.stringify(box)}`);
  return node;
}

for (const [width, height] of SIZES) {
  test(`at ${width}: the host reminds a friend from the plan menu, a second tap shows the cooldown, the friend sees it in Alerts`, { timeout: 120_000 }, async () => {
    const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
    const { circle } = await call("POST", "/api/circles", host.token, { name: `Remind ${width}` });
    const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
    await call("POST", "/api/push/subscribe", friend.token, { endpoint: `https://push.example/remind-${width}`, keys: { p256dh: "p", auth: "a" } });
    const note = `Board games ${width}`;
    await call("POST", "/api/plans", host.token, { note, time: "19:30" });
    const before = sent.length;

    const page = await phone(width, height, host.token);
    try {
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      const card = page.locator(".card-plan", { hasText: note });
      await card.locator(".card-more").click();
      const item = page.getByRole("menuitem", { name: "Remind friends" });
      await item.waitFor();
      assert.equal(await item.getAttribute("aria-disabled"), null, "not greyed before the first reminder");
      const menuBox = await page.locator(".card-menu").boundingBox();
      assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 0.5, `menu fits at ${width}`);
      await shot(page, "remind-menu");
      await item.click();
      await toast(page, "Reminded 1 friend");
      await shot(page, "remind-toast");

      const mine = sent.slice(before);
      assert.deepEqual(mine.map((row) => row.endpoint), [`https://push.example/remind-${width}`]);
      assert.equal(mine[0].payload.title, `Hana reminds you: ${note}, Tomorrow · 19:30`);

      // Second tap: greyed out, and it says when it works again.
      await card.locator(".card-more").click();
      const again = page.getByRole("menuitem", { name: "Remind friends" });
      await again.waitFor();
      assert.equal(await again.getAttribute("aria-disabled"), "true");
      assert.ok((await again.getAttribute("class"))?.includes("muted"));
      await shot(page, "remind-menu-cooldown");
      // Greyed but still tappable, so the tap can say when. Playwright skips aria-disabled without force.
      await again.click({ force: true });
      const wait = await toast(page, "Already reminded. You can remind again at");
      assert.match(await wait.innerText(), /at \d{2}:\d{2}$/);
      await shot(page, "remind-cooldown-toast");
      assert.equal(sent.length, before + 1, "no second push");
    } finally {
      await page.context().close();
    }

    const friendPage = await phone(width, height, friend.token);
    try {
      await friendPage.goto(hangry.baseUrl);
      await dismiss(friendPage);
      await friendPage.getByRole("button", { name: /Alerts/ }).first().click();
      const alert = friendPage.locator(".alert-card", { hasText: "reminds you" }).first();
      await alert.waitFor();
      const text = await alert.innerText();
      assert.ok(text.includes(`Hana reminds you: ${note}, Tomorrow · 19:30`), text);
      await shot(friendPage, "remind-friend-alert");
      await alert.click();
      await friendPage.locator(".card-plan.focused", { hasText: note }).waitFor();
    } finally {
      await friendPage.context().close();
    }
  });
}

test("everyone answered: the toast says so and the item stays available", { timeout: 60_000 }, async () => {
  const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: "All answered" });
  const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
  const made = (await call("POST", "/api/plans", host.token, { note: "Picnic" })).plan;
  await call("POST", `/api/plans/${made.id}/reply`, friend.token, { reply: "cant" });
  const page = await phone(360, 640, host.token);
  try {
    await page.goto(hangry.baseUrl);
    await dismiss(page);
    const card = page.locator(".card-plan", { hasText: "Picnic" });
    await card.locator(".card-more").click();
    await page.getByRole("menuitem", { name: "Remind friends" }).click();
    await toast(page, "Everyone has already answered");
    await card.locator(".card-more").click();
    assert.equal(await page.getByRole("menuitem", { name: "Remind friends" }).getAttribute("aria-disabled"), null);
  } finally {
    await page.context().close();
  }
});

for (const [width, height] of SIZES) {
  test(`at ${width}: a friend who said Maybe still gets reminded, next to the Maybe item in the menu`, { timeout: 60_000 }, async () => {
    const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
    const { circle } = await call("POST", "/api/circles", host.token, { name: `Maybe ${width}` });
    const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
    const sure = await call("POST", "/api/auth/start", undefined, { name: "Sami", code: circle.inviteCode });
    await call("POST", "/api/push/subscribe", friend.token, { endpoint: `https://push.example/remind-maybe-${width}`, keys: { p256dh: "p", auth: "a" } });
    const made = (await call("POST", "/api/plans", host.token, { note: `Karaoke ${width}` })).plan;
    await call("POST", `/api/plans/${made.id}/reply`, friend.token, { reply: "maybe" });
    await call("POST", `/api/plans/${made.id}/reply`, sure.token, { reply: "in" });
    const before = sent.length;

    // The friend's own menu shows Remind friends and Maybe (on) side by side.
    const friendPage = await phone(width, height, friend.token);
    try {
      await friendPage.goto(hangry.baseUrl);
      await dismiss(friendPage);
      const card = friendPage.locator(".card-plan", { hasText: `Karaoke ${width}` });
      await card.locator(".who-row", { hasText: "You're maybe" }).waitFor();
      await card.locator(".card-more").click();
      const rows = await friendPage.locator(".card-menu [role=menuitem]").evaluateAll((nodes) =>
        nodes.map((node) => ({ text: (node.textContent || "").trim(), on: node.classList.contains("on") })));
      const texts = rows.map((row) => row.text);
      assert.ok(texts.includes("Remind friends"), texts.join(", "));
      assert.ok(texts.indexOf("Remind friends") < texts.indexOf("Maybe"), texts.join(", "));
      assert.equal(rows.find((row) => row.text === "Maybe")?.on, true);
      const menuBox = await friendPage.locator(".card-menu").boundingBox();
      assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 0.5, `menu fits at ${width}`);
      await shot(friendPage, "remind-maybe-menu");
    } finally {
      await friendPage.context().close();
    }

    const page = await phone(width, height, host.token);
    try {
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      const card = page.locator(".card-plan", { hasText: `Karaoke ${width}` });
      await card.locator(".who-row", { hasText: "Finn is maybe" }).waitFor();
      await card.locator(".card-more").click();
      await page.getByRole("menuitem", { name: "Remind friends" }).click();
      await toast(page, "Reminded 1 friend");
      await shot(page, "remind-maybe-toast");
      const mine = sent.slice(before);
      assert.deepEqual(mine.map((row) => row.endpoint), [`https://push.example/remind-maybe-${width}`]);
      assert.equal(mine[0].payload.title, `Hana reminds you: Karaoke ${width}, Tomorrow`);
    } finally {
      await page.context().close();
    }
  });
}
