import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, call, useHangry } from "./harness.js";

/** Screenshots go here. Override with FD_SHOT_DIR=/some/folder. */
const SHOT_DIR = path.resolve(process.env.FD_SHOT_DIR || ".oc/shots/feedback-done");
const ADMIN = "a".repeat(32);
const hangry = useHangry({ tz: "UTC", env: { ADMIN_TOKEN: ADMIN } });

async function phone(width: number, height: number, token: string, circleId: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    if (sessionStorage.getItem("fd_seeded")) return;
    sessionStorage.setItem("fd_seeded", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    // A stale circle the person has left: the app must still load their personal alerts.
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  return context.newPage();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`), fullPage: true });
}

function markDone(id: string) {
  return call(hangry.baseUrl, "POST", `/api/admin/feedback/${id}`, ADMIN, { status: "done" });
}

for (const [width, height] of SIZES) {
  test(`left-circle submitter sees and taps "Your suggestion is live" at ${width}px`, { timeout: 60_000 }, async () => {
    const alex = await hangry.call("POST", "/api/auth/start", undefined, { name: "Alex" });
    const created = await hangry.call("POST", "/api/circles", alex.token, { name: "Friends" });
    const bea = await hangry.call("POST", "/api/auth/start", undefined, { name: "Bea", code: created.circle.inviteCode });
    const evil = `<b>bold</b> ${"long words ".repeat(20)}🍕`;
    const sent = await hangry.call("POST", "/api/feedback", bea.token, { text: evil, circleId: created.circle.id });
    await hangry.call("POST", `/api/circles/leave?circle=${created.circle.id}`, bea.token, {});

    const page = await phone(width, height, bea.token, created.circle.id);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(hangry.baseUrl);
      await page.getByRole("button", { name: "Create circle" }).waitFor();
      await markDone(sent.id);

      // The 3 s poll picks it up: banner first, then the list under the setup forms.
      const card = page.locator(".personal-alerts .alert-card", { hasText: "Your suggestion is live" });
      await card.waitFor({ timeout: 10_000 });
      assert.equal(await page.locator(".personal-alerts b").count(), 0, "feedback text is never HTML");
      assert.match(await card.innerText(), /<b>bold<\/b>/);
      await shot(page, "zero-circle-alert");

      const banner = page.locator(".banner", { hasText: "Your suggestion is live" });
      if (await banner.count()) {
        await banner.click();
      } else {
        await card.click();
      }
      const dialog = page.getByRole("dialog", { name: "What's new" });
      await dialog.waitFor();
      await shot(page, "zero-circle-whats-new");
      await dialog.getByRole("button", { name: "Done" }).click();
      await dialog.waitFor({ state: "detached" });

      // Alex stayed in the circle and never sees Bea's alert.
      const alexNotes = await hangry.call("GET", `/api/notifications?circle=${created.circle.id}`, alex.token);
      assert.equal(alexNotes.notifications.some((note: { kind: string }) => note.kind === "feedback-done"), false);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}
