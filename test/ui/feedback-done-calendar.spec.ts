import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, call, useHangry } from "./harness.js";

/** Screenshots go here. Override with FDCAL_SHOT_DIR=/some/folder. The feed link is always masked. */
const SHOT_DIR = path.resolve(process.env.FDCAL_SHOT_DIR || ".oc/shots/feedback-done-calendar");
const ADMIN = "a".repeat(32);
const hangry = useHangry({ tz: "UTC", env: { ADMIN_TOKEN: ADMIN } });
const ENTRIES = JSON.parse(
  fs.readFileSync(new URL("../../public/whats-new.json", import.meta.url), "utf8"),
) as Array<{ id: string; title: string }>;

async function phone(width: number, height: number, token: string, circleId: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    if (sessionStorage.getItem("fdcal_seeded")) return;
    sessionStorage.setItem("fdcal_seeded", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({
    path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`),
    mask: [page.locator(".feed-url")],
    maskColor: "#3a3a3c",
  });
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

for (const [width, height] of SIZES) {
  test(`at ${width}: a feedback-done banner on the You tab opens What's new and the calendar feed keeps working`, { timeout: 90_000 }, async () => {
    const alex = await hangry.call("POST", "/api/auth/start", undefined, { name: "Alex" });
    const circle = (await hangry.call("POST", "/api/circles", alex.token, { name: `Cal fb ${width}` })).circle;
    const bea = await hangry.call("POST", "/api/auth/start", undefined, { name: "Bea", code: circle.inviteCode });
    const sent = await hangry.call("POST", "/api/feedback", bea.token, { text: `Plans in my calendar ${width}`, circleId: circle.id });

    const page = await phone(width, height, bea.token, circle.id);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(hangry.baseUrl);
      await dismiss(page);
      await page.getByRole("button", { name: "You", exact: true }).click();
      const panel = page.getByRole("region", { name: "Calendar feed" });
      await panel.getByRole("button", { name: "Turn on calendar feed" }).click();
      await panel.locator(".feed-url").waitFor();

      // Marked done while Bea is on You with the one-time feed link showing.
      await call(hangry.baseUrl, "POST", `/api/admin/feedback/${sent.id}`, ADMIN, { status: "done" });
      const banner = page.locator(".banner", { hasText: "Your suggestion is live" });
      await banner.waitFor({ timeout: 10_000 });
      // The poll re-render keeps the feed link: still on the You tab.
      assert.equal(await panel.locator(".feed-url").count(), 1);
      await shot(page, "1-you-tab-banner");

      await banner.click();
      const dialog = page.getByRole("dialog", { name: "What's new" });
      await dialog.waitFor();
      const titles = await dialog.locator(".whats-new-entry h3").allInnerTexts();
      assert.deepEqual(titles.slice(0, 2), [ENTRIES[0].title, ENTRIES[1].title]);
      for (const title of ["Share a plan with more circles", "Hear when your idea ships", "Plans in your calendar"]) assert.ok(titles.includes(title), `missing ${title}`);
      await shot(page, "2-whats-new-both-entries");
      await dialog.getByRole("button", { name: "Done" }).click();
      await dialog.waitFor({ state: "detached" });

      // Back on You: the feed panel is intact and can be turned off.
      await panel.getByRole("button", { name: "Turn off" }).waitFor();
      const feed = await hangry.call("GET", "/api/me/calendar-feed", bea.token);
      assert.equal(feed.active, true);

      // Alerts lists the personal alert. Leaving You hides the one-time link, as before.
      await page.locator(".screen-head .icon-btn[aria-label^='Alerts']").click();
      await page.locator(".alert-card", { hasText: "Your suggestion is live" }).waitFor();
      await page.getByRole("button", { name: "You", exact: true }).click();
      await panel.getByRole("button", { name: "Reset link" }).waitFor();
      assert.equal(await panel.locator(".feed-url").count(), 0);
      await shot(page, "3-you-tab-after-alerts");

      // Alex shares the circle and sees neither the alert nor Bea's text.
      const alexNotes = await hangry.call("GET", `/api/notifications?circle=${circle.id}`, alex.token);
      assert.equal(alexNotes.notifications.some((note: { kind: string }) => note.kind === "feedback-done"), false);
      assert.equal(JSON.stringify(alexNotes).includes("Plans in my calendar"), false);
      assert.deepEqual(errors, []);
    } finally {
      await page.context().close();
    }
  });
}
