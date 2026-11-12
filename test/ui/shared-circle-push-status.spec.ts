import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import type { PushPayload, PushSender, PushSubscription } from "../../src/push/push.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

/** Screenshots of the push sheet. Override with SCS_SHOT_DIR=/some/folder. */
const SHOT_DIR = path.resolve(process.env.SCS_SHOT_DIR || "/workspace/hangry-shared-status-artifacts");

const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
const push: PushSender = {
  async send(subscription: PushSubscription, payload: PushPayload) {
    sent.push({ endpoint: subscription.endpoint, payload });
  },
};
const hangry = useHangry({ tz: "UTC", push });
const { call } = hangry;

type Person = { token: string; user: { id: string; name: string } };

for (const [width, height] of SIZES) {
  test(`Jonas from a shared circle shows in the host's push sheet at ${width}x${height}`, { timeout: 90_000 }, async () => {
    const tag = `w${width}`;
    const philipp: Person = await call("POST", "/api/auth/start", undefined, { name: "Philipp" });
    const family = (await call("POST", "/api/circles", philipp.token, { name: "Family" })).circle;
    const dinner = (await call("POST", "/api/circles", philipp.token, { name: "Jumping Dinner" })).circle;
    const anna: Person = await call("POST", "/api/auth/start", undefined, { name: "Anna", code: family.inviteCode });
    await call("POST", "/api/auth/start", undefined, { name: "Ben", code: family.inviteCode });
    const jonas: Person = await call("POST", "/api/auth/start", undefined, { name: "Jonas", code: dinner.inviteCode });
    for (const person of [anna, jonas]) {
      await call("POST", "/api/push/subscribe", person.token, { endpoint: `https://push.example/${tag}-${person.user.id}`, keys: { p256dh: "p", auth: "a" } });
    }
    const plan = (await call("POST", `/api/plans?circle=${family.id}`, philipp.token, { note: "Kerzenschein" })).plan;
    sent.length = 0;
    await call("PATCH", `/api/plans/${plan.id}?circle=${family.id}`, philipp.token, { circleIds: [family.id, dinner.id] });
    const jonasPush = sent.find((item) => item.endpoint === `https://push.example/${tag}-${jonas.user.id}`);
    assert.ok(jonasPush?.payload.id, "Jonas got the share push");
    assert.equal(sent.length, 1, "only Jonas hears about the share");
    await call("POST", "/api/push/ack", undefined, { id: jonasPush.payload.id });

    const page = await openAs(philipp.token, family.id, { width, height });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      await page.locator(".card-plan").filter({ hasText: "Kerzenschein" }).getByRole("button", { name: "Open details" }).click();
      await page.getByRole("dialog", { name: "Details" }).getByRole("button", { name: "Delivered to 1 of 3" }).click();
      const sheet = page.getByRole("dialog", { name: "Push delivery" });
      await sheet.getByText("Kerzenschein · Delivered to 1 of 3", { exact: true }).waitFor();
      await sheet.locator(".row", { hasText: "Jonas" }).getByText("Delivered", { exact: true }).waitFor();
      await sheet.locator(".row", { hasText: "Anna" }).getByText("Sent, not confirmed", { exact: true }).waitFor();
      await sheet.locator(".row", { hasText: "Ben" }).getByText("Notifications off", { exact: true }).waitFor();
      assert.equal(await sheet.locator(".row", { hasText: "Philipp" }).count(), 0, "the host is not listed");
      await page.waitForTimeout(300);
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOT_DIR, `shared-push-sheet-${width}x${height}.png`) });
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}

async function openAs(token: string, circleId: string, viewport: { width: number; height: number }): Promise<Page> {
  const context = await hangry.browser.newContext({ viewport, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, [token, circleId] as const);
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  return page;
}
