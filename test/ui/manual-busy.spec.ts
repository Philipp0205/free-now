import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { SIZES, UA, useHangry } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const hangry = useHangry();
const SHOTS = path.join(process.cwd(), "test/ui/screenshots/manual-busy");
const ZONE = "Europe/Berlin";
const UNTIL = /until (tomorrow )?\d{2}:\d{2}/;

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) });
}

async function phone(token: string, width = 412, height = 915) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, timezoneId: ZONE });
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

/** Berlin weekday (1 = Mon) and a HH:MM range that holds the current minute, whatever the hour. */
function aroundNow() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(read("weekday")) + 1;
  const minutes = Number(read("hour")) * 60 + Number(read("minute"));
  const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  return { weekday, start: clock(Math.max(0, minutes - 30)), end: clock(Math.min(23 * 60 + 59, minutes + 90)) };
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("a quick Busy until shows to friends and clears", async () => {
  const { phil, bea } = await seed();
  const { context, page } = await phone(phil.token);
  try {
    await tab(page, "You");
    for (const label of ["1 hour", "2 hours", "Until 6pm", "Until tomorrow"]) await page.getByRole("button", { name: label, exact: true }).waitFor();
    await shot(page, "you-presets.png");
    await page.getByRole("button", { name: "1 hour", exact: true }).click();
    await page.locator(".toast", { hasText: "Status saved" }).waitFor();
    assert.match(await page.locator(".status-summary").innerText(), new RegExp(`Busy · ${UNTIL.source}`));
    assert.ok(await page.getByRole("button", { name: "Clear status" }).isVisible());
    await shot(page, "you-busy-summary.png");

    const friend = await phone(bea.token);
    try {
      await tab(friend.page, "Circle");
      const row = friend.page.locator(".member-row", { hasText: "Philipp" });
      await row.locator(".status-badge[aria-label='Busy']").waitFor();
      assert.match(await row.locator(".status-line").innerText(), new RegExp(`^Busy · ${UNTIL.source}`));
      assert.match(await friend.page.locator(".away-line").innerText(), new RegExp(`^Busy: Philipp, ${UNTIL.source}`));
      await shot(friend.page, "friend-circle-busy.png");
    } finally {
      await friend.context.close();
    }

    await page.getByRole("button", { name: "Clear status" }).click();
    await page.locator(".toast", { hasText: "Status cleared" }).waitFor();
    await page.getByRole("button", { name: "1 hour", exact: true }).waitFor();
    assert.equal((await hangry.call("GET", "/api/me", phil.token)).user.status, null);

    // The editor: Busy hides the date, picks a preset or a clock time, and keeps Away's date field.
    await page.getByRole("button", { name: /Set Busy/ }).click();
    await page.locator("#status-until-time").waitFor();
    assert.equal(await page.locator("#status-until").count(), 0);
    await page.getByRole("button", { name: "Until 6pm", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Until 6pm", exact: true }).getAttribute("aria-pressed"), "true");
    await page.locator("#status-until-time").fill("23:30");
    assert.equal(await page.getByRole("button", { name: "Until 6pm", exact: true }).getAttribute("aria-pressed"), "false");
    await shot(page, "you-busy-editor.png");
    await page.getByRole("button", { name: "Save status" }).click();
    await page.locator(".toast", { hasText: "Status saved" }).waitFor();
    assert.match(await page.locator(".status-summary").innerText(), /Busy · until (tomorrow )?23:30/);
    await page.getByRole("button", { name: "Edit status" }).click();
    await page.getByRole("button", { name: "Away", exact: true }).click();
    await page.locator("#status-until").waitFor();
    assert.equal(await page.locator("#status-until-time").count(), 0);
  } finally {
    await context.close();
  }
});

test("weekly hours make a person Busy to friends, with no Clear status", async () => {
  const { phil, bea } = await seed();
  const { weekday, start, end } = aroundNow();
  const { context, page } = await phone(phil.token);
  try {
    await tab(page, "You");
    await page.getByRole("button", { name: "Set weekly hours" }).click();
    const today = page.locator(".hours-block").first().getByRole("button", { name: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][weekday - 1], exact: true });
    if ((await today.getAttribute("aria-pressed")) !== "true") await today.click();
    assert.equal(await today.getAttribute("aria-pressed"), "true");
    await page.locator(".hours-start").fill(start);
    await page.locator(".hours-end").fill(end);
    assert.match(await page.locator(".hours-editor .help").innerText(), /Times are in your time zone \(Europe\/Berlin\)/);
    await shot(page, "you-hours-editor.png");
    await page.getByRole("button", { name: "Save weekly hours" }).click();
    await page.locator(".toast", { hasText: "Weekly hours saved" }).waitFor();

    assert.match(await page.locator(".hours-summary").innerText(), new RegExp(`${start} to ${end}`));
    assert.match(await page.locator(".status-summary").innerText(), new RegExp(`Busy · ${UNTIL.source}`));
    assert.match(await page.locator(".status-panel .help").innerText(), /From your weekly hours/);
    assert.equal(await page.getByRole("button", { name: "Clear status" }).count(), 0);
    await page.getByRole("button", { name: "Set a status" }).waitFor();
    await shot(page, "you-hours-saved.png");

    const friend = await phone(bea.token);
    try {
      await tab(friend.page, "Circle");
      const row = friend.page.locator(".member-row", { hasText: "Philipp" });
      await row.locator(".status-badge[aria-label='Busy']").waitFor();
      assert.match(await row.locator(".status-line").innerText(), new RegExp(`^Busy · ${UNTIL.source}`));
      assert.match(await friend.page.locator(".away-line").innerText(), new RegExp(`^Busy: Philipp, ${UNTIL.source}`));
    } finally {
      await friend.context.close();
    }

    // An empty-days block never reaches the server.
    await page.getByRole("button", { name: "Edit weekly hours" }).last().click();
    const pressed = page.locator(".hours-block").first().locator(".chip[aria-pressed='true']");
    while (await pressed.count()) await pressed.first().click();
    await page.getByRole("button", { name: "Save weekly hours" }).click();
    await page.locator(".toast", { hasText: "Pick at least one day" }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Remove weekly hours" }).click();
    await page.locator(".toast", { hasText: "Weekly hours removed" }).waitFor();
    await page.getByRole("button", { name: "Set weekly hours" }).waitFor();
    assert.equal((await hangry.call("GET", "/api/me", phil.token)).user.status, null);
  } finally {
    await context.close();
  }
});

test("I'm free overrides Busy, and a past end is not shown", async () => {
  const { phil, bea } = await seed();
  await hangry.call("PUT", "/api/me/status", phil.token, { type: "busy", until: Date.now() + 3_600_000, timezone: ZONE });
  const friend = await phone(bea.token);
  const { context, page } = await phone(phil.token);
  try {
    await tab(friend.page, "Circle");
    await friend.page.locator(".member-row", { hasText: "Philipp" }).locator(".status-badge[aria-label='Busy']").waitFor();

    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("#sheet-note").fill("Coffee");
    await page.getByRole("button", { name: "I'm free" }).click();
    await page.getByRole("heading", { name: "Coffee" }).waitFor();
    await shot(page, "free-after-busy.png");

    await friend.page.reload();
    await friend.page.locator("nav.tabbar").waitFor();
    await tab(friend.page, "Circle");
    const row = friend.page.locator(".member-row", { hasText: "Philipp" });
    await row.waitFor();
    assert.equal(await row.locator(".status-badge").count(), 0);
    assert.equal(await friend.page.locator(".away-line").count(), 0);
    assert.equal((await hangry.call("GET", "/api/me", phil.token)).user.status, null);

    // A Busy whose time has passed is gone for everyone.
    await hangry.call("PUT", "/api/me/status", phil.token, { type: "busy", until: Date.now() + 3_600_000, timezone: ZONE });
    hangry.db.prepare("UPDATE users SET status_until = ? WHERE id = ?").run(Date.now() - 60_000, phil.user.id);
    await friend.page.reload();
    await friend.page.locator("nav.tabbar").waitFor();
    await tab(friend.page, "Circle");
    await friend.page.locator(".member-row", { hasText: "Philipp" }).waitFor();
    assert.equal(await friend.page.locator(".status-badge").count(), 0);
    assert.equal(await friend.page.locator(".away-line").count(), 0);
  } finally {
    await friend.context.close();
    await context.close();
  }
});

test("the You tab and a friend's Circle row fit at phone sizes", async () => {
  const { phil, bea } = await seed();
  const { weekday, start, end } = aroundNow();
  await hangry.call("PUT", "/api/me/busy-hours", phil.token, {
    timezone: ZONE,
    blocks: [
      { days: [weekday], start, end },
      { days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "00:30" },
      { days: [1, 3, 5], start: "18:00", end: "20:00" },
    ],
  });
  for (const [width, height] of SIZES) {
    const { context, page } = await phone(phil.token, width, height);
    try {
      await tab(page, "You");
      await page.locator(".hours-panel").waitFor();
      assert.ok((await overflow(page)) <= 0, `saved panel has no sideways scroll at ${width}px`);
      await page.getByRole("button", { name: "Edit weekly hours" }).last().click();
      await page.locator(".hours-editor").waitFor();
      assert.equal(await page.locator(".hours-block").count(), 3);
      assert.equal(await page.getByRole("button", { name: "Add another block" }).count(), 0, "three blocks is the cap");
      assert.ok((await overflow(page)) <= 0, `weekly editor has no sideways scroll at ${width}px`);
      for (const box of await page.locator(".hours-days .chip").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()))) {
        assert.ok(box.height >= 44 && box.width >= 44 - 0.5, `day chip is ${box.width}x${box.height} at ${width}px`);
      }
      await page.locator(".hours-editor").scrollIntoViewIfNeeded();
      await shot(page, `you-hours-editor-${width}.png`);
    } finally {
      await context.close();
    }
    const friend = await phone(bea.token, width, height);
    try {
      await tab(friend.page, "Circle");
      await friend.page.locator(".member-row", { hasText: "Philipp" }).locator(".status-line").waitFor();
      assert.ok((await overflow(friend.page)) <= 0, `Circle has no sideways scroll at ${width}px`);
      await shot(friend.page, `friend-circle-${width}.png`);
    } finally {
      await friend.context.close();
    }
  }
});
