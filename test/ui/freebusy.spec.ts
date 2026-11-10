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
import { SIZES, UA, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
const MIN = 60_000;
/** Screenshots land here (gitignored). Override with FB_SHOT_DIR. */
const SHOT_DIR = path.resolve(process.env.FB_SHOT_DIR || "test/ui/screenshots/freebusy");
const HOST = "calendar.example.test";
/** Titles only Alex may ever see. */
const SECRET_TITLES = ["Tennis lesson", "Dentist", "Team lunch"];

/** Each fake user gets their own private path. Events are laid out from the moment of the fetch. */
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
      `UID:fb${i}@example.test`,
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

const calendarNet: CalendarNet = {
  async resolve() {
    return [{ address: "93.184.216.34", family: 4 }];
  },
  request: (async (url: URL) => {
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

async function phone(width: number, height: number, token: string, circleId: string, mobile = true) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, userAgent: UA });
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

/** The calendar link is a secret: the field is masked in every screenshot. */
async function shot(page: Page, name: string, width: number) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const options = { mask: [page.locator("#calendar-sync-url"), page.locator(".feed-url")], maskColor: "#3a3a3c" };
  const file = path.join(SHOT_DIR, `${name}-${width}.png`);
  // Wait out page fades and sheet slides so the picture shows the settled screen.
  await page.waitForFunction(() => document.getAnimations().every((item) => item.playState !== "running" || item.effect?.getComputedTiming().iterations === Infinity));
  await page.screenshot({ path: file, ...options });
  if (width === 360 || width === 1280) fs.copyFileSync(file, path.join(SHOT_DIR, `${name}.png`));
  return file;
}

async function noSideScroll(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, `page scrolls sideways by ${wide}px`);
}

/** A secret is only ever checked as a boolean, so a failure never prints it. */
function absent(text: string, label: string) {
  for (const title of SECRET_TITLES) assert.ok(!text.includes(title), `${label} leaks an event title`);
  assert.ok(!text.includes("private-"), `${label} leaks the calendar link`);
}

/** Alex shares with Friends (Bea), not with Work (Cleo). */
async function seed(tag: string, connect: boolean) {
  const alex = await call("POST", "/api/auth/start", undefined, { name: "Alex" });
  const friends = (await call("POST", "/api/circles", alex.token, { name: `Friends ${tag}` })).circle;
  const work = (await call("POST", "/api/circles", alex.token, { name: `Work ${tag}` })).circle;
  const bea = await call("POST", "/api/auth/start", undefined, { name: "Bea", code: friends.inviteCode });
  const cleo = await call("POST", "/api/auth/start", undefined, { name: "Cleo", code: work.inviteCode });
  if (connect) {
    await call("PUT", "/api/me/calendar-sync", alex.token, { url: link(tag) });
    await call("PATCH", "/api/me/calendar-sync", alex.token, { sharedCircleIds: [friends.id] });
  }
  return { alex, bea, cleo, friends, work };
}

function nowParts() {
  const now = Math.floor(Date.now() / MIN) * MIN;
  const today = isoDate(now, TZ);
  return { now, today, tomorrow: addDays(today, 1) };
}

const WIDTHS: Array<readonly [number, number, boolean]> = [...SIZES.map(([w, h]) => [w, h, true] as const), [1280, 900, false]];

for (const [width, height, mobile] of WIDTHS) {
  test(`at ${width}: Alex connects a calendar link on the You tab and picks a circle`, { timeout: 120_000 }, async () => {
    const tag = `s${width}`;
    const { alex, friends, work } = await seed(tag, false);
    const page = await phone(width, height, alex.token, friends.id, mobile);
    try {
      await page.locator(".tabbar").getByRole("button", { name: "You", exact: true }).click();
      const panel = page.getByRole("region", { name: "Calendar availability" });
      await panel.getByRole("button", { name: "Connect calendar" }).waitFor();
      await panel.getByText("They never see what is in your calendar.", { exact: false }).waitFor();
      await page.locator("#calendar-sync-url").fill(link(tag));
      await panel.scrollIntoViewIfNeeded();
      await noSideScroll(page);
      await shot(page, mobile ? "freebusy-settings" : "freebusy-settings-desktop-off", width);

      const put = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/me/calendar-sync"));
      await panel.getByRole("button", { name: "Connect calendar" }).click();
      assert.equal((await put).status(), 200);
      await panel.getByText(`Connected: ${HOST}`).waitFor();
      await panel.getByText("Last checked", { exact: false }).waitFor();
      const friendsBox = panel.getByRole("checkbox", { name: friends.name });
      const workBox = panel.getByRole("checkbox", { name: work.name });
      assert.equal(await friendsBox.isChecked(), false, "off until turned on");
      assert.equal(await workBox.isChecked(), false);
      await panel.getByText("Off everywhere.", { exact: false }).waitFor();

      const patch = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith("/api/me/calendar-sync"));
      await friendsBox.check();
      assert.deepEqual((await patch).request().postDataJSON(), { sharedCircleIds: [friends.id] });
      await panel.getByRole("checkbox", { name: friends.name, checked: true }).waitFor();
      assert.equal(await panel.getByRole("checkbox", { name: work.name }).isChecked(), false);
      const status = await call("GET", "/api/me/calendar-sync", alex.token);
      assert.deepEqual(status.sharedCircleIds, [friends.id]);
      absent(JSON.stringify(status), "status");
      absent(await panel.innerText(), "the panel after connect");

      for (const box of await panel.locator(".share-toggle").all()) {
        const rect = await box.boundingBox();
        assert.ok(rect && rect.height >= 44, `circle toggle is at least 44px tall: ${rect?.height}`);
      }
      await panel.scrollIntoViewIfNeeded();
      await noSideScroll(page);
      await shot(page, mobile ? "freebusy-settings-connected" : "freebusy-settings-desktop", width);

      // Remove asks first, then forgets everything.
      await panel.getByRole("button", { name: "Remove" }).click();
      await page.locator(".sheet-confirm").getByRole("button", { name: "Remove" }).click();
      await panel.getByRole("button", { name: "Connect calendar" }).waitFor();
      assert.equal((await call("GET", "/api/me/calendar-sync", alex.token)).connected, false);
    } finally {
      await page.context().close();
    }
  });
}

for (const [width, height] of SIZES) {
  test(`at ${width}: Bea sees Alex as busy, with no event names, in members, free sheet, and plan sheet`, { timeout: 120_000 }, async () => {
    const { now } = nowParts();
    const { alex, bea, cleo, friends, work } = await seed(`m${width}`, true);
    const busyUntil = `Busy until ${untilText(now + 90 * MIN, Date.now(), TZ)}`;

    // Cleo shares a circle with Alex, but not one Alex picked.
    const cleoMe = await call("GET", `/api/me?circle=${work.id}`, cleo.token);
    assert.equal(cleoMe.circle.members.find((m: { id: string }) => m.id === alex.user.id).availability, null);
    absent(JSON.stringify(cleoMe), "Cleo's /api/me");
    const beaMe = await call("GET", "/api/me", bea.token);
    assert.equal(beaMe.circle.members.find((m: { id: string }) => m.id === alex.user.id).availability.state, "busy");
    absent(JSON.stringify(beaMe), "Bea's /api/me");

    const page = await phone(width, height, bea.token, friends.id);
    const seen: string[] = [];
    page.on("response", async (response) => {
      if (!response.url().includes("/api/")) return;
      seen.push(await response.text().catch(() => ""));
    });
    try {
      await page.locator(".tabbar").getByRole("button", { name: "Circle", exact: true }).click();
      const row = page.locator(".member-row", { hasText: "Alex" });
      await row.locator(".avail-line.busy", { hasText: busyUntil }).waitFor();
      assert.equal(await page.locator(".member-row", { hasText: "Bea" }).locator(".avail-line").count(), 0, "no line for yourself");
      // The tab fades in and a refresh may re-render, so scroll until the row stays in view.
      await page.waitForFunction(() => {
        const node = [...document.querySelectorAll(".member-row")].find((item) => item.textContent?.includes("Alex"));
        node?.scrollIntoView({ block: "center" });
        const box = node?.getBoundingClientRect();
        return Boolean(box && box.top > 0 && box.bottom < window.innerHeight - 80);
      }, null, { polling: 200 });
      await page.waitForTimeout(400);
      await noSideScroll(page);
      await shot(page, "freebusy-member-list", width);
      absent(await page.locator("body").innerText(), "Bea's circle tab");

      await page.locator(".tabbar").getByRole("button", { name: "Now", exact: true }).click();
      await page.getByRole("button", { name: "Let friends know you're free now" }).click();
      const sheet = page.locator("form.sheet");
      await sheet.locator(".busy-at", { hasText: `Busy now: Alex until ${untilText(now + 90 * MIN, Date.now(), TZ)}` }).waitFor();
      await noSideScroll(page);
      await shot(page, "freebusy-plan-sheet", width);

      await sheet.getByRole("button", { name: "Plan for another day" }).click();
      await page.locator("#plan-date").waitFor();
      await page.locator("#plan-date").fill(nowParts().tomorrow);
      assert.equal(await page.locator(".busy-at").innerText(), "", "an untimed plan names nobody");
      const asked = page.waitForResponse((r) => r.url().includes("/api/circles/availability?at="));
      await page.locator("#plan-time").fill("11:30");
      assert.equal((await asked).status(), 200);
      await page.locator(".busy-at", { hasText: "Busy then: Alex until 12:00" }).waitFor();
      await page.locator("#plan-time").fill("13:00");
      await page.waitForFunction(() => document.querySelector(".busy-at")?.textContent === "");
      await page.locator("#plan-time").fill("11:30");
      await page.locator(".busy-at", { hasText: "Busy then: Alex until 12:00" }).waitFor();
      await page.locator(".busy-at").scrollIntoViewIfNeeded();
      await noSideScroll(page);
      await shot(page, "freebusy-planning-busy", width);

      absent(await page.locator("body").innerText(), "Bea's sheets");
      absent(seen.join("\n"), "Bea's API responses");
    } finally {
      await page.context().close();
    }
  });

  test(`at ${width}: Alex's I'm in shows their own day first, highlights the clash, and joins only on confirm`, { timeout: 120_000 }, async () => {
    const { today, tomorrow } = nowParts();
    const { alex, bea, friends } = await seed(`i${width}`, true);
    const brunch = (await call("POST", "/api/plans", bea.token, { note: "Brunch", date: tomorrow, time: "11:30" })).plan;
    const bowling = (await call("POST", "/api/plans", bea.token, { note: "Bowling", date: addDays(today, 5) })).plan;
    const alexPlan = (await call("POST", `/api/plans?circle=${friends.id}`, alex.token, { note: "Pizza", date: tomorrow, time: "19:00" })).plan;

    const page = await phone(width, height, alex.token, friends.id);
    const dayCalls: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/api/me/calendar-sync/day")) dayCalls.push(request.url()); });
    try {
      const card = page.locator(`.card-plan[data-plan="${brunch.id}"]`);
      await card.locator(".in-toggle", { hasText: "I'm in" }).click();
      const check = page.locator(".sheet-confirm");
      await check.getByRole("heading", { name: "This clashes with your calendar" }).waitFor();
      assert.ok(dayCalls.some((url) => url.endsWith(`date=${tomorrow}`)), "asks for the plan's day");
      const clash = check.locator(".cal-event.clash");
      assert.equal(await clash.count(), 1);
      assert.match((await clash.textContent()) || "", /^11:00 to 12:00Tennis lessonOverlaps$/);
      await check.locator(".cal-event:not(.clash)", { hasText: "Team lunch" }).waitFor();
      assert.match(await check.locator(".cal-event", { hasText: "Team lunch" }).innerText(), /15:00 to 16:00/);
      await check.getByText("Only you can see this.", { exact: false }).waitFor();
      await noSideScroll(page);
      await shot(page, "freebusy-im-in-check", width);

      // Cancel does not join.
      await check.getByRole("button", { name: "Cancel" }).click();
      await check.waitFor({ state: "detached" });
      assert.equal(await card.locator(".in-toggle.on").count(), 0);
      let plans = await call("GET", "/api/plans", bea.token);
      assert.equal(plans.plans.find((p: { id: string }) => p.id === brunch.id).joined.length, 0);

      // I'm in on the sheet joins.
      await card.locator(".in-toggle", { hasText: "I'm in" }).click();
      const reply = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/plans/${brunch.id}/reply`));
      await page.locator(".sheet-confirm").getByRole("button", { name: "I'm in", exact: true }).click();
      assert.equal((await reply).status(), 200);
      await card.locator(".in-toggle.on").waitFor();

      // An empty day joins straight away.
      const before = dayCalls.length;
      const bowl = page.locator(`.card-plan[data-plan="${bowling.id}"]`);
      await bowl.scrollIntoViewIfNeeded();
      await bowl.locator(".in-toggle", { hasText: "I'm in" }).click();
      await bowl.locator(".in-toggle.on").waitFor();
      assert.equal(dayCalls.length, before + 1);
      assert.equal(await page.locator(".sheet-confirm").count(), 0, "no sheet for an empty day");
      plans = await call("GET", "/api/plans", bea.token);
      assert.equal(plans.plans.find((p: { id: string }) => p.id === bowling.id).joined.length, 1);
    } finally {
      await page.context().close();
    }

    // Bea has no calendar: I'm in joins as before and never asks.
    const beaPage = await phone(width, height, bea.token, friends.id);
    const beaCalls: string[] = [];
    beaPage.on("request", (request) => { if (request.url().includes("/calendar-sync/day")) beaCalls.push(request.url()); });
    try {
      const card = beaPage.locator(`.card-plan[data-plan="${alexPlan.id}"]`);
      await card.locator(".in-toggle", { hasText: "I'm in" }).click();
      await card.locator(".in-toggle.on").waitFor();
      assert.equal(beaCalls.length, 0);
      assert.equal(await beaPage.locator(".sheet-confirm").count(), 0);
      absent(await beaPage.locator("body").innerText(), "Bea's Now tab");
    } finally {
      await beaPage.context().close();
    }
  });
}

test("at 360: I'm in on a buzz checks today and highlights what overlaps now", { timeout: 120_000 }, async () => {
  const { friends, alex, bea } = await seed("buzz", true);
  const social = (await call("POST", "/api/socials", bea.token, { note: "Coffee" })).social;
  const page = await phone(360, 640, alex.token, friends.id);
  try {
    const card = page.locator(`[data-social="${social.id}"]`);
    await card.locator(".in-toggle", { hasText: "I'm in" }).click();
    const check = page.locator(".sheet-confirm");
    await check.locator(".cal-event.clash", { hasText: "Dentist" }).waitFor();
    await noSideScroll(page);
    await shot(page, "freebusy-im-in-buzz", 360);
    const reply = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/socials/${social.id}/reply`));
    await check.getByRole("button", { name: "I'm in", exact: true }).click();
    assert.equal((await reply).status(), 200);
    await card.locator(".in-toggle.on").waitFor();
  } finally {
    await page.context().close();
  }
});
