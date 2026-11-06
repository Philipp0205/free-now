import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import type { PushPayload, PushSender, PushSubscription } from "../../src/push.js";
import { addDays, isoDate, shortDate } from "../../src/time.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
/** Set to a folder to keep screenshots, for example RS_SHOT_DIR=/tmp/shots. */
const SHOT_DIR = process.env.RS_SHOT_DIR ? path.resolve(process.env.RS_SHOT_DIR) : "";

const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
const fakePush: PushSender = {
  async send(subscription: PushSubscription, payload: PushPayload) { sent.push({ endpoint: subscription.endpoint, payload }); },
};

const hangry = useHangry({ tz: TZ, push: fakePush });
const { call } = hangry;

async function phone(width = 360, height = 640, token: string | null = null) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    if (value) localStorage.setItem("fn_token", value);
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

for (const [width, height] of SIZES) {
  test(`at ${width}: the host moves a plan, friends get one push with the new day and time, the host gets none, the alert opens the plan`, { timeout: 120_000 }, async () => {
    const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
    const { circle } = await call("POST", "/api/circles", host.token, { name: `Crew ${width}` });
    const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
    // A second circle, so pushes carry the circle name like every other multi-circle push.
    await call("POST", "/api/circles", friend.token, { name: "Other" });
    for (const [user, tag] of [[host, "host"], [friend, "friend"]] as const) {
      await call("POST", "/api/push/subscribe", user.token, { endpoint: `https://push.example/${tag}-${width}`, keys: { p256dh: "p", auth: "a" } });
    }
    const ola = await call("POST", "/api/auth/start", undefined, { name: "Ola", code: circle.inviteCode });
    await call("POST", "/api/push/subscribe", ola.token, { endpoint: `https://push.example/ola-${width}`, keys: { p256dh: "p", auth: "a" } });
    const note = `Board games ${width}`;
    const made = (await call("POST", "/api/plans", host.token, { note, time: "19:30" })).plan;
    await call("POST", `/api/plans/${made.id}/reply`, ola.token, { reply: "cant" });
    const today = isoDate(Date.now(), TZ);
    const target = addDays(today, 3);
    const before = sent.length;

    const page = await phone(width, height, host.token);
    try {
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      await page.locator(".card-plan", { hasText: note }).locator(".card-more").click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      const sheet = page.locator(".sheet");
      await sheet.getByRole("button", { name: "Pick a date" }).click();
      await page.locator("#admin-date").fill(target);
      await page.locator("#admin-time").fill("20:00");
      await shot(page, "edit-reschedule");
      await sheet.getByRole("button", { name: "Save" }).click();
      await sheet.waitFor({ state: "detached" });
      await shot(page, "host-after-save");
    } finally {
      await page.context().close();
    }

    const mine = sent.slice(before);
    const expected = `${note} moved to ${shortDate(target, today)} · 20:00`;
    assert.deepEqual(mine.map((item) => item.endpoint), [`https://push.example/friend-${width}`], "only the friend is pushed, once: not the host, not Ola who said can't");
    const payload = mine[0].payload as unknown as Record<string, unknown>;
    assert.match(String(payload.title), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(!/Today|Tomorrow/.test(String(payload.title)));
    assert.ok(String(payload.body).endsWith(` · Crew ${width}`), `tagged with the circle: ${payload.body}`);
    assert.match(String(payload.url), new RegExp(`^/\\?plan=[0-9a-f-]+&circle=`));


    const friendPage = await phone(width, height, friend.token);
    try {
      await friendPage.goto(hangry.baseUrl);
      await dismiss(friendPage);
      await friendPage.getByRole("button", { name: /Alerts/ }).first().click();
      const alert = friendPage.locator(".alert-card", { hasText: "moved to" }).first();
      await alert.waitFor();
      assert.ok((await alert.innerText()).includes(`${shortDate(target, today)} · 20:00`));
      await shot(friendPage, "friend-alert");
      // Tapping the push opens its url.
      await friendPage.goto(`${hangry.baseUrl}${payload.url}`);
      await friendPage.locator(".card-plan, .map-card", { hasText: note }).first().waitFor();
      await shot(friendPage, "friend-opens-plan");
    } finally {
      await friendPage.context().close();
    }
  });
}

test("a title-only edit sends no push", { timeout: 60_000 }, async () => {
  const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Quiet crew" });
  const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
  await call("POST", "/api/push/subscribe", friend.token, { endpoint: "https://push.example/quiet", keys: { p256dh: "p", auth: "a" } });
  await call("POST", "/api/plans", host.token, { note: "Walk", time: "19:30" });
  const before = sent.length;
  const page = await phone(360, 640, host.token);
  try {
    await page.goto(hangry.baseUrl);
    await dismiss(page);
    await page.locator(".card-plan", { hasText: "Walk" }).getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.locator("#admin-note").fill("Long walk");
    await page.locator(".sheet").getByRole("button", { name: "Save" }).click();
    await page.locator(".card-plan", { hasText: "Long walk" }).waitFor();
  } finally {
    await page.context().close();
  }
  assert.equal(sent.slice(before).filter((item) => item.endpoint === "https://push.example/quiet").length, 0);
});
