import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { addDays } from "../../src/time.js";
import { statusToday } from "../../public/status.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const hangry = useHangry();

async function phone(token: string, width = 412, height = 915) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.route("https://server.arcgisonline.com/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  await page.goto(hangry.baseUrl);
  await page.locator("nav.tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return { context, page };
}

const tab = (page: Page, name: string) => page.locator("nav.tabbar").getByRole("button", { name, exact: true }).click();

async function seed() {
  const phil = await hangry.call("POST", "/api/auth/start", undefined, { name: "Philipp" });
  const circle = (await hangry.call("POST", "/api/circles", phil.token, { name: "Tennis" })).circle;
  const bea = await hangry.call("POST", "/api/auth/start", undefined, { name: "Bea", code: circle.inviteCode });
  return { phil, bea, circle };
}

test("set Away on the You tab, friends see the badge and line, then clear it", async () => {
  const { phil, bea } = await seed();
  const untilDay = addDays(statusToday(), 4);
  const { context, page } = await phone(phil.token);
  try {
    await tab(page, "You");
    await page.getByRole("button", { name: /Set Away/ }).click();
    await page.locator("#status-text").fill("Tennis vacation in Portugal");
    await page.locator("#status-place").fill("Portugal");
    await page.locator("#status-until").fill(untilDay);
    assert.equal(await page.locator(".status-editor .segment button.on").innerText(), "Away");
    await page.getByRole("button", { name: "Save status" }).click();
    await page.locator(".toast", { hasText: "Status saved" }).waitFor();
    const summary = await page.locator(".status-summary").innerText();
    assert.match(summary, /Away · Tennis vacation in Portugal · until \d+ \w{3}$/);
    assert.ok(!summary.includes("Portugal · Portugal"), "the place is not said twice");
    await page.locator(".profile-hero .status-badge[aria-label='Away']").waitFor();

    const friend = await phone(bea.token);
    try {
      await tab(friend.page, "Circle");
      const row = friend.page.locator(".member-row", { hasText: "Philipp" });
      await row.locator(".status-badge[aria-label='Away']").waitFor();
      assert.match(await row.locator(".status-line").innerText(), /Away · Tennis vacation in Portugal · until/);
      assert.match(await friend.page.locator(".away-line").innerText(), /^Away: Philipp, until \d+ \w{3}/);
      // Everyone can open the details; Bea is not an admin, so there is nothing to manage.
      await row.getByRole("button", { name: "Details for Philipp" }).click();
      const sheet = friend.page.locator(".sheet[aria-label='Philipp']");
      await sheet.locator(".status-card").waitFor();
      assert.match(await sheet.locator(".status-card").innerText(), /Away[\s\S]*Tennis vacation in Portugal[\s\S]*Portugal[\s\S]*Until/);
      assert.equal(await sheet.getByRole("button", { name: "Make admin" }).count(), 0);
      await sheet.getByRole("button", { name: "Close" }).click();
      await tab(friend.page, "Now");
      await friend.page.locator(".away-line", { hasText: "Away: Philipp" }).waitFor();
    } finally {
      await friend.context.close();
    }

    // The admin still gets Manage, and the sheet keeps its actions.
    await tab(page, "Circle");
    await page.getByRole("button", { name: "Manage Bea" }).click();
    await page.locator(".sheet").getByRole("button", { name: "Make admin" }).waitFor();
    await page.locator(".scrim").click();
    // Own row: details, no admin actions.
    await page.getByRole("button", { name: "Details for Philipp" }).click();
    await page.locator(".sheet[aria-label='Philipp'] .status-card").waitFor();
    assert.equal(await page.locator(".sheet").getByRole("button", { name: "Make admin" }).count(), 0);
    await page.locator(".sheet").getByRole("button", { name: "Close" }).click();

    await tab(page, "You");
    await page.getByRole("button", { name: "Clear status" }).click();
    await page.locator(".toast", { hasText: "Status cleared" }).waitFor();
    assert.equal(await page.locator(".status-badge").count(), 0);
    await page.getByRole("button", { name: /Set Busy/ }).waitFor();
    const me = await hangry.call("GET", "/api/me", phil.token);
    assert.equal(me.user.status, null);
  } finally {
    await context.close();
  }
});

test("an ended status is not shown, and a past end day is refused with a message", async () => {
  const { phil, bea } = await seed();
  await hangry.call("PUT", "/api/me/status", phil.token, { type: "busy", text: "Exams" });
  // Pretend the end day was yesterday.
  hangry.db.prepare("UPDATE users SET status_until = ? WHERE id = ?").run(Date.now() - 60_000, phil.user.id);
  const friend = await phone(bea.token);
  try {
    await tab(friend.page, "Circle");
    const row = friend.page.locator(".member-row", { hasText: "Philipp" });
    await row.waitFor();
    assert.equal(await row.locator(".status-badge").count(), 0);
    assert.equal(await row.locator(".status-line").count(), 0);
    assert.equal(await friend.page.locator(".away-line").count(), 0);
  } finally {
    await friend.context.close();
  }

  const { context, page } = await phone(phil.token);
  try {
    await tab(page, "You");
    await page.getByRole("button", { name: /Set Busy/ }).click();
    assert.equal(await page.locator("#status-text").getAttribute("maxlength"), "60");
    assert.equal(await page.locator("#status-place").getAttribute("maxlength"), "40");
    assert.equal(await page.locator("#status-until").getAttribute("min"), statusToday());
    // The browser stops at the cap; the server refuses a past day.
    await page.locator("#status-until").evaluate((node: HTMLInputElement) => {
      node.removeAttribute("min");
    });
    await page.locator("#status-until").fill("2020-01-01");
    await page.getByRole("button", { name: "Save status" }).click();
    await page.locator(".toast", { hasText: "The end day has passed" }).waitFor();
    await page.locator(".status-editor").waitFor();
  } finally {
    await context.close();
  }
});

test("status panel and member row fit at phone sizes", async () => {
  const { phil, bea } = await seed();
  await hangry.call("PUT", "/api/me/status", phil.token, {
    type: "away",
    text: "Tennis vacation in Portugal with the whole club",
    place: "Portugal",
    untilDay: addDays(statusToday(), 4),
  });
  for (const [width, height] of SIZES) {
    const { context, page } = await phone(bea.token, width, height);
    try {
      await tab(page, "Circle");
      const row = page.locator(".member-row", { hasText: "Philipp" });
      await row.locator(".status-line").waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `no sideways scroll at ${width}px`);
      const badge = await row.locator(".status-badge").boundingBox();
      const face = await row.locator(".avatar").first().boundingBox();
      assert.ok(badge && face, "badge and face");
      assert.ok(badge.x + badge.width <= face.x + face.width + 4 && badge.y + badge.height <= face.y + face.height + 4, `badge sits on the face at ${width}px`);
    } finally {
      await context.close();
    }
  }
  const { context, page } = await phone(phil.token, 320, 568);
  try {
    await tab(page, "You");
    await page.locator(".status-panel").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, "You tab has no sideways scroll at 320px");
  } finally {
    await context.close();
  }
});

test("map pins carry the Away mark on the host and on crowd faces", async () => {
  const { phil, bea } = await seed();
  await hangry.call("PUT", "/api/me/status", phil.token, { type: "away", text: "Portugal" });
  await hangry.call("PUT", "/api/me/status", bea.token, { type: "busy" });
  const { plan } = await hangry.call("POST", "/api/plans", phil.token, {
    note: "Doubles", date: addDays(statusToday(), 1), time: "18:00", place: "Schlossplatz", lat: 48.7784, lng: 9.18, precise: true,
  });
  await hangry.call("POST", `/api/plans/${plan.id}/reply`, bea.token, { reply: "in" });
  const { context, page } = await phone(bea.token);
  try {
    await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
    const pin = page.locator(".leaflet-marker-icon.pin-plan", { hasText: "P" }).filter({ has: page.locator(`.pin-letter[data-person="${phil.user.id}"]`) });
    await pin.waitFor({ timeout: 10_000 });
    await pin.locator(".pin-body > .pin-letter.has-status .pin-status[data-status='away']").waitFor();
    await pin.locator(`.pin-face[data-person="${bea.user.id}"] .pin-status[data-status='busy']`).waitFor();
    // The mark leaves the round face alone.
    const letter = await pin.locator(".pin-body > .pin-letter").boundingBox();
    assert.ok(letter && Math.abs(letter.width - letter.height) < 1, "face stays round");
  } finally {
    await context.close();
  }
});
