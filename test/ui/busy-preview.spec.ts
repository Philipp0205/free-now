import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import type { CalendarNet, Transport } from "../../src/freebusy.js";
import { addDays, isoDate, zonedDateTime } from "../../src/time.js";
import { untilText } from "../../public/freebusy.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { openPlanSheet } from "./plan-sheet.js";
import { SIZES, UA, openYouSection, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
const MIN = 60_000;
const SHOT_DIR = path.resolve("test/ui/screenshots/busy-preview");
const HOST = "calendar.example.test";
/** Titles only Alex may ever see in his own calendar. */
const SECRET_TITLES = ["Tennis lesson", "Dentist", "Team lunch", "Secret Street"];

function aliceIcs(): string {
  const now = Math.floor(Date.now() / MIN) * MIN;
  const tomorrow = addDays(isoDate(now, TZ), 1);
  const events = [
    { title: "Dentist", start: now - 30 * MIN, end: now + 90 * MIN },
    { title: "Tennis lesson", start: zonedDateTime(tomorrow, "11:00", TZ), end: zonedDateTime(tomorrow, "12:00", TZ) },
    { title: "Team lunch", start: zonedDateTime(tomorrow, "15:00", TZ), end: zonedDateTime(tomorrow, "16:00", TZ) },
  ];
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((event, i) => [
      "BEGIN:VEVENT",
      `UID:bp${i}@example.test`,
      `DTSTART:${stamp(event.start)}`,
      `DTEND:${stamp(event.end)}`,
      `SUMMARY:${event.title}`,
      "LOCATION:Secret Street 1",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

let fetches = 0;
const calendarNet: CalendarNet = {
  async resolve() {
    return [{ address: "93.184.216.34", family: 4 }];
  },
  request: (async (url: URL) => {
    fetches += 1;
    const body = Buffer.from(url.hostname === HOST && url.pathname.endsWith("/basic.ics") ? aliceIcs() : "");
    return {
      status: body.length ? 200 : 404,
      headers: { "content-type": "text/calendar" },
      body: (async function* () { yield body; })(),
      destroy() {},
    };
  }) as Transport,
};

const hangry = useHangry({ tz: TZ, calendarNet });
const { call } = hangry;

function link(tag: string) {
  return `https://${HOST}/private-${tag}-0123456789abcdef/basic.ics`;
}

async function phone(width: number, height: number, token: string, circleId: string) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, timezoneId: TZ });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

/** The calendar link is a secret: any field that could hold it is masked. */
async function shot(page: Page, name: string, width: number) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}-${width}.png`);
  await page.waitForFunction(() => document.getAnimations().every((item) => item.playState !== "running" || item.effect?.getComputedTiming().iterations === Infinity));
  await page.screenshot({ path: file, mask: [page.locator("#calendar-sync-url"), page.locator(".feed-url")], maskColor: "#3a3a3c" });
  if (width === 360) fs.copyFileSync(file, path.join(SHOT_DIR, `${name}.png`));
}

async function noSideScroll(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, `page scrolls sideways by ${wide}px`);
}

function absent(text: string, label: string) {
  for (const title of SECRET_TITLES) assert.ok(!text.includes(title), `${label} leaks an event title`);
  assert.ok(!text.includes("private-"), `${label} leaks the calendar link`);
}

async function seed(tag: string, share: boolean) {
  const alex = await call("POST", "/api/auth/start", undefined, { name: "Alex" });
  const friends = (await call("POST", "/api/circles", alex.token, { name: `Friends ${tag}` })).circle;
  const bea = await call("POST", "/api/auth/start", undefined, { name: "Bea", code: friends.inviteCode });
  await call("PUT", "/api/me/calendar-sync", alex.token, { url: link(tag) });
  if (share) await call("PATCH", "/api/me/calendar-sync", alex.token, { sharedCircleIds: [friends.id] });
  return { alex, bea, friends };
}

function nowParts() {
  const now = Math.floor(Date.now() / MIN) * MIN;
  return { now, tomorrow: addDays(isoDate(now, TZ), 1) };
}

async function openPreview(page: Page) {
  await openYouSection(page, "Availability & calendar");
  await page.locator(".page").getByRole("button", { name: "See what friends see", exact: true }).click();
  await page.getByRole("heading", { name: "What friends see", exact: true, level: 1 }).waitFor();
}

for (const [width, height] of SIZES) {
  test(`at ${width}: Alex sees the same busy times as Bea, no titles, and Check now works`, { timeout: 120_000 }, async () => {
    const { now, tomorrow } = nowParts();
    const { alex, bea, friends } = await seed(`p${width}`, true);
    const busyUntil = untilText(now + 90 * MIN, Date.now(), TZ);

    // What Bea sees in the plan sheet.
    const beaPage = await phone(width, height, bea.token, friends.id);
    let beaLine = "";
    try {
      await openPlanSheet(beaPage);
      await beaPage.locator("#plan-date").fill(tomorrow);
      await beaPage.locator("#plan-time").fill("11:30");
      const busy = beaPage.locator(".busy-at", { hasText: "Busy then: Alex until 12:00" });
      await busy.waitFor();
      beaLine = (await busy.innerText()).trim();
    } finally {
      await beaPage.context().close();
    }
    assert.equal(beaLine, "Busy then: Alex until 12:00");

    const page = await phone(width, height, alex.token, friends.id);
    const seen: string[] = [];
    page.on("response", async (response) => {
      if (response.url().includes("/api/")) seen.push(await response.text().catch(() => ""));
    });
    try {
      await openYouSection(page, "Availability & calendar");
      const entry = page.locator(".page").getByRole("button", { name: "See what friends see", exact: true });
      await entry.waitFor();
      const box = await entry.boundingBox();
      assert.ok(box && box.height >= 44, `entry is at least 44px tall: ${box?.height}`);
      if (height >= 640) assert.ok(box && box.y + box.height <= height, `entry is visible without scrolling: bottom ${box && box.y + box.height} of ${height}`);
      await noSideScroll(page);
      await shot(page, "entry", width);

      const loaded = page.waitForResponse((r) => r.url().endsWith("/api/me/calendar-sync/preview"));
      await entry.click();
      await page.getByRole("heading", { name: "What friends see", exact: true, level: 1 }).waitFor();
      assert.equal((await loaded).status(), 200);
      await page.getByText("This is what friends in your circles see. They never see event names.").waitFor();
      await page.getByText(`Shared with: Friends p${width}`).waitFor();
      const times = page.getByRole("region", { name: "Busy times" });
      await times.getByRole("heading", { name: "Tomorrow" }).waitFor();
      const text = await times.innerText();
      assert.match(text, /today/i, "today's block is listed");
      assert.ok(text.includes("Blocked from 11:00 to 12:00"), "tomorrow 11:00 to 12:00 is listed, the block Bea sees as busy until 12:00");
      assert.ok(text.includes("Blocked from 15:00 to 16:00"));
      assert.ok(text.includes(`to ${busyUntil}`), `today's block ends at ${busyUntil}`);
      assert.ok(text.includes("Calendar link"), "source tag");
      await page.getByText("Last checked", { exact: false }).waitFor();
      await page.getByText("Something wrong? Fix it in your calendar, then tap Check now. Changes show here within a minute.").waitFor();
      absent(await page.locator("body").innerText(), "the preview");
      await noSideScroll(page);
      const checkBox = await page.getByRole("button", { name: "Check now" }).boundingBox();
      assert.ok(checkBox && checkBox.height >= 44, `Check now is at least 44px tall: ${checkBox?.height}`);
      await shot(page, "view", width);

      // Check now fetches the calendar again and reloads the preview.
      const before = fetches;
      const refresh = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/me/calendar-sync/refresh"));
      const reload = page.waitForResponse((r) => r.url().endsWith("/api/me/calendar-sync/preview"));
      await page.getByRole("button", { name: "Check now" }).click();
      assert.equal((await refresh).status(), 200);
      assert.equal((await reload).status(), 200);
      await page.getByRole("button", { name: "Check now" }).waitFor();
      assert.ok(fetches > before, "the calendar was fetched again");
      await times.getByRole("heading", { name: "Tomorrow" }).waitFor();

      // Back returns to Availability & calendar.
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("heading", { name: "Availability & calendar", exact: true, level: 1 }).waitFor();
      await page.getByRole("region", { name: "Calendar availability" }).waitFor();
      assert.equal(await page.getByRole("heading", { name: "What friends see", exact: true }).count(), 0);
      absent(seen.join("\n").replace(/"lastError":"[^"]*"/g, ""), "Alex's API responses");
    } finally {
      await page.context().close();
    }
  });
}

test("at 360: not shared, then shared again, and history back leaves the view first", { timeout: 120_000 }, async () => {
  const { alex, friends } = await seed("ns", true);
  const page = await phone(360, 640, alex.token, friends.id);
  try {
    await openPreview(page);
    await page.getByText("Shared with: Friends ns").waitFor();
    await page.getByRole("button", { name: "Back", exact: true }).click();

    const panel = page.getByRole("region", { name: "Calendar availability" });
    await panel.getByRole("checkbox", { name: friends.name, checked: true }).click();
    await panel.getByRole("checkbox", { name: friends.name, checked: false }).waitFor();
    await page.locator(".page").getByRole("button", { name: "See what friends see", exact: true }).click();
    await page.getByText("Not shared with any circle. Friends see none of your calendar busy times.").waitFor();
    await page.getByText("Turn a circle on in Availability & calendar.").waitFor();
    await page.getByText("Your weekly hours and your status are shown to everyone in your circles.").waitFor();
    assert.equal(await page.getByRole("region", { name: "Busy times" }).getByRole("heading", { name: "Tomorrow" }).count(), 0, "no calendar times when nobody gets them");
    await noSideScroll(page);
    await shot(page, "not-shared", 360);

    const url = page.url();
    await page.evaluate(() => history.back());
    await page.getByRole("heading", { name: "Availability & calendar", exact: true, level: 1 }).waitFor();
    assert.equal(page.url(), url, "Back stayed inside the app");
  } finally {
    await page.context().close();
  }
});

test("at 360: a status and weekly hours show without a calendar, and an empty user sees the free state", { timeout: 120_000 }, async () => {
  const alex = await call("POST", "/api/auth/start", undefined, { name: "Alex" });
  const friends = (await call("POST", "/api/circles", alex.token, { name: "Friends none" })).circle;
  const empty = await phone(360, 640, alex.token, friends.id);
  try {
    await openPreview(empty);
    await empty.getByText("Nothing busy. Friends see you as free.").waitFor();
    assert.equal(await empty.getByRole("button", { name: "Check now" }).count(), 0, "no Check now without a calendar");
    assert.equal(await empty.getByText("Shared with", { exact: false }).count(), 0);
    await noSideScroll(empty);
    await shot(empty, "empty", 360);
    await empty.getByRole("button", { name: "Back", exact: true }).click();
    await empty.getByRole("button", { name: "See what friends see", exact: true }).waitFor();

    await call("PUT", "/api/me/status", alex.token, { type: "away", text: "Trip", until: Date.now() + 3 * 86_400_000 });
    await empty.reload();
    await openPreview(empty);
    await empty.getByRole("region", { name: "Busy times" }).getByText(/^Away until/).waitFor();
    assert.equal(await empty.getByText("Nothing busy.").count(), 0);
    await shot(empty, "status", 360);
  } finally {
    await empty.context().close();
  }
});

test("at 360: a stale calendar says so, and a failed load can be retried", { timeout: 120_000 }, async () => {
  const { alex, friends } = await seed("st", true);
  hangry.db.prepare("UPDATE calendar_sync SET last_ok_at = ? WHERE user_id = ?").run(Date.now() - 3 * 86_400_000, alex.user.id);
  const page = await phone(360, 640, alex.token, friends.id);
  try {
    await openPreview(page);
    await page.getByText("Your calendar is out of date, so friends see nothing from it. Tap Check now.").waitFor();
    assert.equal(await page.getByRole("region", { name: "Busy times" }).getByRole("heading", { name: "Tomorrow" }).count(), 0);
    await noSideScroll(page);
    await shot(page, "stale", 360);

    await page.getByRole("button", { name: "Back", exact: true }).click();
    let fail = true;
    await page.route("**/api/me/calendar-sync/preview", (route) => (fail ? route.abort() : route.continue()));
    await page.locator(".page").getByRole("button", { name: "See what friends see", exact: true }).click();
    await page.getByText("Could not load. Try again.").waitFor();
    await shot(page, "error", 360);
    fail = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByText("This is what friends in your circles see.", { exact: false }).waitFor();
    assert.equal(await page.getByText("Could not load. Try again.").count(), 0);
  } finally {
    await page.context().close();
  }
});
