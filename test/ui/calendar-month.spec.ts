import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

const RAILWAY_DIR = "/workspace/hangry-railway";

// Tue 10 Nov 2026, 12:00 in Berlin. Server and browser share this clock.
const NOW = Date.parse("2026-11-10T11:00:00Z");
const SHOT_DIR = path.resolve("test/ui/screenshots/calendar-month");
const EXTRA_DIR = process.env.CALENDAR_SHOT_DIR ? path.resolve(process.env.CALENDAR_SHOT_DIR) : "";
const BUSY = "2026-11-14";
const PARTY_DAY = "2026-11-21";
const PARTY = "Dana's birthday";
/** In on the party, with distinct initials. Maybe and Can't stay off the stack. */
const GUESTS = ["Cem", "Ida", "Jo", "Kai", "Lu"];
const GUEST_INITIALS = GUESTS.map((name) => name[0]);
const PAST = "2026-11-03";
const HOME_PLAN = "Home board games";
const HOME_DAY = "2026-11-18";
const HOME_DINNER = "Home dinner";

const hangry = useHangry({ tz: "Europe/Berlin", now: () => NOW });

async function open(width: number, height: number, token: string, circleId: string, mobile = true): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile ? UA : undefined,
  });
  await skipWhatsNew(context);
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn|protomaps|\.pmtiles/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate(({ value, circle }) => {
    localStorage.clear();
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, { value: token, circle: circleId });
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

/** The Events tab (formerly Map). It opens on Calendar unless Map was picked before. */
async function goEvents(page: Page) {
  await page.locator(".tabbar").getByRole("button", { name: "Events", exact: true }).click();
  await page.locator(".events-view").waitFor({ timeout: 10_000 });
}

/** The Events tab is open on Calendar: the segment, the grid, the title and the tab all agree. */
async function assertCalendarDefault(page: Page, tag: string) {
  const view = page.locator(".events-view");
  assert.equal(await view.getByRole("button", { name: "Calendar", exact: true }).getAttribute("aria-pressed"), "true", `${tag} Calendar is the default`);
  assert.equal(await view.getByRole("button", { name: "Map", exact: true }).getAttribute("aria-pressed"), "false", tag);
  await page.locator(".cal-grid .cal-crowd").first().waitFor({ timeout: 10_000 });
  assert.ok(await page.locator(".cal-grid").isVisible(), `${tag} month grid`);
  assert.equal(await page.locator("#hangry-map").count(), 0, `${tag} no live map`);
  assert.equal((await page.locator(".screen-title").first().textContent())?.trim(), "Events", tag);
  const tab = page.locator(".tabbar .tab[aria-current='page']");
  assert.equal(await tab.getAttribute("aria-label"), "Events", tag);
  assert.equal((await tab.locator(".tab-label").textContent())?.trim(), "Events", tag);
  // The calendar glyph (a rounded box), not the map pin.
  assert.equal(await tab.locator("svg rect").count(), 1, `${tag} calendar icon`);
}

/** The busy day's list for the scope that is on: Uni only, or Uni and Home with circle names. */
async function assertBusyDay(page: Page, all: boolean, tag: string) {
  await page.waitForFunction(([day, more]) => document.querySelector(`.cal-cell[data-day="${day}"] .cal-more`)?.textContent === more, [BUSY, all ? "+4" : "+3"], { timeout: 10_000 });
  await cell(page, BUSY).click();
  await page.waitForFunction((want) => document.querySelectorAll(".cal-event").length === want, all ? 5 : 4, { timeout: 10_000 });
  const rows = page.locator(".cal-event");
  const titles = await rows.locator("strong").allTextContents();
  if (all) {
    assert.deepEqual(titles, ["Brunch", "Library", "Climbing", HOME_PLAN, "Late film"], tag);
    assert.match((await rows.nth(3).textContent()) || "", /18:00 · Bea · Home/, tag);
    assert.match((await rows.nth(0).textContent()) || "", /Uni friends/, tag);
  } else {
    assert.deepEqual(titles, ["Brunch", "Library", "Climbing", "Late film"], `${tag} This circle has no Home plan`);
    for (const text of await rows.allTextContents()) assert.doesNotMatch(text, /Uni friends|Home/, `${tag} no circle names on This circle`);
  }
  assert.equal(await cell(page, HOME_DAY).locator(".cal-crowd").count(), all ? 1 : 0, `${tag} Home-only day`);
  const scope = page.locator(".map-scope");
  assert.equal(await scope.getByRole("button", { name: "All circles" }).getAttribute("aria-pressed"), all ? "true" : "false", tag);
  assert.equal(await scope.getByRole("button", { name: "This circle" }).getAttribute("aria-pressed"), all ? "false" : "true", tag);
}

/** Full-viewport Events shots at 360 and 1280, into the repo folder and the Railway review folder. */
async function eventsShot(page: Page, scope: "this-circle" | "all-circles", width: number) {
  if (width !== 360 && width !== 1280) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  const name = `events-${scope}-${width}.png`;
  for (const dir of [SHOT_DIR, RAILWAY_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, name), animations: "disabled" });
  }
}

/** Map / Calendar and This circle / All circles share one short row that fits, with every label whole. */
async function assertCompactControls(page: Page, tag: string) {
  const row = await page.locator(".events-controls").evaluate((node) => {
    const outer = node.getBoundingClientRect();
    const view = node.querySelector(".events-view")!.getBoundingClientRect();
    const scope = node.querySelector(".map-scope")!.getBoundingClientRect();
    const buttons = [...node.querySelectorAll("button")].map((button) => {
      const b = button.getBoundingClientRect();
      return { label: button.textContent || button.getAttribute("aria-label"), clipped: button.scrollWidth > button.clientWidth, left: b.left, right: b.right, height: b.height };
    });
    return {
      height: outer.height, left: outer.left, right: outer.right,
      overflow: node.scrollWidth > node.clientWidth,
      view: { top: view.top, height: view.height },
      scope: { top: scope.top, height: scope.height },
      buttons,
    };
  });
  const info = `${tag} ${JSON.stringify(row)}`;
  assert.ok(Math.abs(row.view.top - row.scope.top) <= 1, `${info} one row`);
  assert.ok(row.view.height <= 40 && row.scope.height <= 40, `${info} neither wraps`);
  // The old stack of two 52px segments was 120px with its margins.
  assert.ok(row.height <= 40, `${info} short row`);
  assert.equal(row.overflow, false, `${info} no overflow`);
  assert.deepEqual(row.buttons.map((button) => button.label), ["Map", "Calendar", "This circle", "All circles"], info);
  for (const button of row.buttons) {
    assert.equal(button.clipped, false, `${info} ${button.label} whole`);
    assert.ok(button.left >= row.left - 0.5 && button.right <= row.right + 0.5, `${info} ${button.label} inside`);
    assert.ok(button.height >= 32, `${info} ${button.label} tap height`);
  }
}

/** The last event of the picked day scrolls fully into view above the fixed tab bar. */
async function assertDayClearsTab(page: Page, tag: string) {
  const last = page.locator(".cal-list .cal-event").last();
  await last.evaluate((node) => node.scrollIntoView({ block: "end" }));
  const box = (await last.boundingBox())!;
  const bar = (await page.locator(".tabbar").boundingBox())!;
  assert.ok(box.y + box.height <= bar.y + 1, `${tag} last row ${JSON.stringify(box)} clears the tab bar at ${bar.y}`);
  // Nothing covers its middle: the tap lands on the row, not the tab bar.
  const hit = await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest(".cal-event")), [box.x + box.width / 2, box.y + box.height - 4]);
  assert.ok(hit, `${tag} last row is not covered`);
  const brunch = page.locator(".cal-event", { hasText: "Brunch" });
  await brunch.evaluate((node) => node.scrollIntoView({ block: "end" }));
  const brunchBox = (await brunch.boundingBox())!;
  assert.ok(brunchBox.y + brunchBox.height <= bar.y + 1, `${tag} Brunch ${JSON.stringify(brunchBox)} clears the tab bar at ${bar.y}`);
  await page.locator(".cal").evaluate((node) => { node.scrollTop = 0; });
}

function cell(page: Page, day: string) {
  return page.locator(`.cal-cell[data-day="${day}"]`);
}

/** Phone shots also go to the Railway review folder; 1280 stays in the repo folder. */
async function shot(page: Page, name: string, focus = "") {
  // Centre it, since the fixed tab bar covers the bottom of the viewport.
  if (focus) await page.locator(focus).first().evaluate((node) => node.scrollIntoView({ block: "center" }));
  const phone = !/-1280\.png$/.test(name);
  for (const dir of [SHOT_DIR, phone ? RAILWAY_DIR : "", EXTRA_DIR].filter(Boolean)) {
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, name), animations: "disabled" });
  }
}

async function noSideScroll(page: Page, width: number, tag: string) {
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(scroll <= width, `${tag} scrollWidth ${scroll} > ${width}`);
}

/** A small warm "photo" drawn by Chrome, so one face is a photo and the rest are initials. */
async function testPhoto(): Promise<Buffer> {
  const page = await hangry.browser.newPage();
  try {
    const data = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      const grad = ctx.createLinearGradient(0, 0, 64, 64);
      grad.addColorStop(0, "#ff9f0a");
      grad.addColorStop(1, "#ff2d78");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#ffd6a0";
      ctx.beginPath();
      ctx.arc(32, 26, 13, 0, Math.PI * 2);
      ctx.fill();
      return canvas.toDataURL("image/webp", 0.9).split(",")[1];
    });
    return Buffer.from(data, "base64");
  } finally {
    await page.close();
  }
}

async function seed() {
  const alex = await hangry.call("POST", "/api/auth/start", undefined, { name: "Alex" });
  const uni = (await hangry.call("POST", "/api/circles", alex.token, { name: "Uni friends" })).circle;
  const home = (await hangry.call("POST", "/api/circles", alex.token, { name: "Home" })).circle;
  const bea = await hangry.call("POST", "/api/auth/start", undefined, { name: "Bea", code: uni.inviteCode });
  await hangry.call("POST", "/api/circles/join", bea.token, { code: home.inviteCode });
  // A busy Saturday: four Uni plans and one Home plan, so This circle shows +1 and All shows +2.
  for (const [note, time] of [["Brunch", "10:30"], ["Library", "13:00"], ["Climbing", "16:00"], ["Late film", "21:00"]]) {
    await hangry.call("POST", `/api/plans?circle=${uni.id}`, alex.token, { note, time, date: BUSY });
  }
  const homePlan = (await hangry.call("POST", `/api/plans?circle=${home.id}`, bea.token, {
    note: HOME_PLAN, time: "18:00", date: BUSY, place: "Rosenstein", lat: 48.8, lng: 9.21, precise: true,
  })).plan;
  // A Home-only evening, so All circles visibly adds a day the This circle grid leaves empty.
  await hangry.call("POST", `/api/plans?circle=${home.id}`, bea.token, { note: HOME_DINNER, time: "19:30", date: HOME_DAY });
  // Free now today, and a plan last week that is over.
  await hangry.call("POST", `/api/socials?circle=${uni.id}`, bea.token, { note: "Coffee on the steps" });
  const old = (await hangry.call("POST", `/api/plans?circle=${uni.id}`, alex.token, { note: "Old hike", date: "2026-11-20" })).plan;
  hangry.db.prepare("UPDATE plans SET for_date = ? WHERE id = ?").run(PAST, old.id);
  await hangry.call("POST", `/api/plans?circle=${uni.id}`, alex.token, { note: "Winter market", time: "19:00", date: "2026-12-05" });
  // Dana's party: Dana hosts (with a photo), five friends In, one maybe and one Can't.
  const dana = await hangry.call("POST", "/api/auth/start", undefined, { name: "Dana", code: uni.inviteCode });
  const photo = await fetch(`${hangry.baseUrl}/api/me/avatar`, {
    method: "PUT",
    headers: { authorization: `Bearer ${dana.token}`, "content-type": "image/webp" },
    body: await testPhoto(),
  });
  assert.equal(photo.status, 200, await photo.text());
  const party = (await hangry.call("POST", `/api/plans?circle=${uni.id}`, dana.token, { note: PARTY, time: "20:00", date: PARTY_DAY })).plan;
  for (const name of GUESTS) {
    const guest = await hangry.call("POST", "/api/auth/start", undefined, { name, code: uni.inviteCode });
    await hangry.call("POST", `/api/plans/${party.id}/reply?circle=${uni.id}`, guest.token, { reply: "coming" });
  }
  for (const [name, reply] of [["Mo", "maybe"], ["Nia", "declined"]]) {
    const guest = await hangry.call("POST", "/api/auth/start", undefined, { name, code: uni.inviteCode });
    await hangry.call("POST", `/api/plans/${party.id}/reply?circle=${uni.id}`, guest.token, { reply });
  }
  return { alex, bea, uni, home, homePlan };
}

test("calendar: the Events tab opens on a month of events, This circle and All circles, with day lists and details", { timeout: 300_000 }, async () => {
  const { alex, uni, homePlan } = await seed();
  const sizes: Array<[number, number, boolean]> = [...SIZES.map(([w, h]) => [w, h, true] as [number, number, boolean]), [1280, 800, false]];
  for (const [width, height, mobile] of sizes) {
    const tag = String(width);
    const page = await open(width, height, alex.token, uni.id, mobile);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      // No stored view: the Events tab opens straight on Calendar, and nothing is saved until a tap.
      await goEvents(page);
      await assertCalendarDefault(page, tag);
      assert.equal(await page.evaluate(() => localStorage.getItem("hangry-events-view-v2")), null, tag);
      assert.equal((await page.locator(".cal-title").textContent())?.trim(), "November 2026", tag);

      // Today is marked and picked, and shows the Free now post.
      const today = cell(page, "2026-11-10");
      assert.match((await today.getAttribute("class")) || "", /today/);
      assert.equal(await today.getAttribute("aria-pressed"), "true", tag);
      await page.locator(".cal-event", { hasText: "Coffee on the steps" }).waitFor();
      assert.match((await page.locator(".cal-event", { hasText: "Coffee on the steps" }).textContent()) || "", /Free now · Bea/);

      // This circle: four on the busy day, so one stack and +3 more events.
      assert.equal(await cell(page, BUSY).locator(".cal-crowd").count(), 1, tag);
      assert.equal((await cell(page, BUSY).locator(".cal-more").textContent())?.trim(), "+3", tag);

      // The party cell: Dana's photo, then one initial, then +4 (five In, maybe and Can't left out).
      const partyStack = cell(page, PARTY_DAY).locator(".cal-crowd");
      await partyStack.locator("img.avatar.photo").waitFor({ timeout: 10_000 });
      assert.equal(await partyStack.getAttribute("data-in"), "6", tag);
      const cellFaces = await partyStack.locator(".cal-face:not(.cal-face-more)").evaluateAll((nodes) => nodes.map((node) => node.tagName === "IMG" ? "photo" : node.textContent));
      // Host first; replies share one fixed clock, so which guest comes next is the server's tie order.
      assert.equal(cellFaces.length, 2, tag);
      assert.equal(cellFaces[0], "photo", tag);
      assert.ok(GUEST_INITIALS.includes(String(cellFaces[1])), `${tag} ${cellFaces[1]}`);
      assert.equal((await partyStack.locator(".cal-face-more").textContent())?.trim(), "+4", tag);
      const stackBox = (await partyStack.boundingBox())!;
      const partyBox = (await cell(page, PARTY_DAY).boundingBox())!;
      assert.ok(stackBox.x >= partyBox.x - 0.5 && stackBox.x + stackBox.width <= partyBox.x + partyBox.width + 0.5, `${tag} stack fits its cell ${JSON.stringify({ stackBox, partyBox })}`);

      // Every cell fits; at 320 they are still a usable size.
      const box = (await cell(page, BUSY).boundingBox())!;
      assert.ok(box.width >= 38 && box.height >= 44, `${tag} cell ${JSON.stringify(box)}`);
      await noSideScroll(page, width, tag);

      // This circle: the busy day has the four Uni plans and no Home plan.
      await assertBusyDay(page, false, tag);
      await assertCompactControls(page, tag);
      await assertDayClearsTab(page, tag);
      await eventsShot(page, "this-circle", width);

      // All circles adds the Home plan, on the grid and in the day list, with the circle on each row.
      await page.locator(".map-scope").getByRole("button", { name: "All circles" }).click();
      await assertBusyDay(page, true, tag);
      assert.equal(await page.evaluate(() => localStorage.getItem("hangry-map-all")), "1", tag);
      await eventsShot(page, "all-circles", width);
      await shot(page, `calendar-month-${tag}.png`);
      if (mobile) await shot(page, `calendar-friends-month-${tag}.png`, `.cal-cell[data-day="${PARTY_DAY}"]`);

      // The busy day lists all five in time order.
      const rows = page.locator(".cal-event");
      const colors = await rows.locator(".cal-dot").evaluateAll((dots) => dots.map((dot) => getComputedStyle(dot).backgroundColor));
      assert.notEqual(colors[3], colors[0], `${tag} Home and Uni have their own colours`);
      // Each event keeps its own stack: Alex hosts the Uni ones, Bea the Home one.
      assert.equal(await rows.locator(".cal-row-crowd").count(), 5, tag);
      assert.equal((await rows.nth(3).locator(".cal-face").first().textContent())?.trim(), "B", tag);
      assert.equal((await rows.nth(0).locator(".cal-face").first().textContent())?.trim(), "A", tag);
      await noSideScroll(page, width, tag);
      await shot(page, `calendar-day-${tag}.png`, ".cal-event:nth-child(3)");

      // The Home plan opens its detail sheet with the circle, chat and In.
      await rows.nth(3).click();
      const sheet = page.locator(".sheet[aria-label='Details']");
      await sheet.waitFor();
      assert.equal((await sheet.locator("h2").first().textContent())?.trim(), HOME_PLAN);
      await sheet.locator(".map-card-circle", { hasText: "Home" }).waitFor();
      await sheet.locator(".chat-row").waitFor();
      const inBtn = sheet.locator(".in-toggle");
      await inBtn.waitFor();
      await shot(page, `calendar-detail-${tag}.png`);
      if (width === 360) {
        // In goes to the plan's own circle even though Uni is the circle in the header.
        await inBtn.click();
        await sheet.getByRole("button", { name: "In ✓" }).waitFor({ timeout: 10_000 });
        const month = await hangry.call("GET", "/api/calendar-month?from=2026-11-01&to=2026-11-30&all=1", alex.token);
        const joined = month.plans.find((plan: { id: string }) => plan.id === homePlan.id).joined;
        assert.ok(joined.some((person: { id: string }) => person.id === alex.user.id), "Alex is in on the Home plan");
      }
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached", timeout: 5000 });

      // A past plan is muted and its sheet has no In.
      await cell(page, PAST).click();
      const old = page.locator(".cal-event", { hasText: "Old hike" });
      await old.waitFor();
      assert.match((await old.getAttribute("class")) || "", /over/);
      assert.match((await old.textContent()) || "", /Ended/);
      await old.click();
      await sheet.waitFor();
      assert.match((await sheet.locator(".help").first().textContent()) || "", /Ended/);
      assert.equal(await sheet.locator(".in-toggle").count(), 0, `${tag} no In on a past plan`);
      await sheet.locator(".chat-row").waitFor();
      await shot(page, `calendar-past-${tag}.png`);
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached", timeout: 5000 });

      // The party in the day list: four faces, then +2, each row still fits.
      await cell(page, PARTY_DAY).click();
      const partyRow = page.locator(".cal-event", { hasText: PARTY });
      await partyRow.waitFor();
      const rowStack = partyRow.locator(".cal-row-crowd");
      await rowStack.locator("img.avatar.photo").waitFor({ timeout: 10_000 });
      const rowFaces = await rowStack.locator(".cal-face:not(.cal-face-more)").evaluateAll((nodes) => nodes.map((node) => node.tagName === "IMG" ? "photo" : node.textContent));
      assert.equal(rowFaces.length, 4, tag);
      assert.equal(rowFaces[0], "photo", tag);
      assert.equal(new Set(rowFaces.slice(1)).size, 3, `${tag} three different guests`);
      for (const face of rowFaces.slice(1)) assert.ok(GUEST_INITIALS.includes(String(face)), `${tag} ${face}`);
      assert.equal((await rowStack.locator(".cal-face-more").textContent())?.trim(), "+2", tag);
      assert.match((await rowStack.getAttribute("aria-label")) || "", /^Dana, \w+, \w+, \w+ and 2 more are in$/);
      const rowBox = (await partyRow.boundingBox())!;
      const crowdBox = (await rowStack.boundingBox())!;
      assert.ok(crowdBox.x + crowdBox.width <= rowBox.x + rowBox.width + 0.5, `${tag} row stack fits`);
      assert.equal(await page.locator(".cal-free").count(), 0, `${tag} no free-today line yet`);
      await noSideScroll(page, width, tag);
      if (mobile) await shot(page, `calendar-friends-${tag}.png`, ".cal-event");

      // Back to This circle: the Home plan leaves the grid and the day list again.
      await page.locator(".map-scope").getByRole("button", { name: "This circle" }).click();
      await assertBusyDay(page, false, tag);
      assert.equal(await page.evaluate(() => localStorage.getItem("hangry-map-all")), "0", tag);

      // An empty day says so.
      await cell(page, "2026-11-11").click();
      await page.locator(".cal-quiet", { hasText: "Nothing on this day." }).waitFor();

      // October is empty, December has the market, Today comes back.
      await page.getByRole("button", { name: "Previous month" }).click();
      assert.equal((await page.locator(".cal-title").textContent())?.trim(), "October 2026");
      await page.locator(".cal-empty", { hasText: "Nothing planned this month." }).waitFor({ timeout: 10_000 });
      await shot(page, `calendar-empty-${tag}.png`, ".cal-empty");
      await page.getByRole("button", { name: "Next month" }).click();
      await page.getByRole("button", { name: "Next month" }).click();
      assert.equal((await page.locator(".cal-title").textContent())?.trim(), "December 2026");
      await cell(page, "2026-12-05").locator(".cal-crowd").first().waitFor({ timeout: 10_000 });
      await cell(page, "2026-12-05").click();
      await page.locator(".cal-event", { hasText: "Winter market" }).waitFor();
      await page.getByRole("button", { name: "Today", exact: true }).click();
      assert.equal((await page.locator(".cal-title").textContent())?.trim(), "November 2026");
      assert.equal(await cell(page, "2026-11-10").getAttribute("aria-pressed"), "true");

      // A padding day jumps to its month.
      await cell(page, "2026-12-01").click();
      assert.equal((await page.locator(".cal-title").textContent())?.trim(), "December 2026");
      assert.equal(await cell(page, "2026-12-01").getAttribute("aria-pressed"), "true");

      // Calendar is still the view after a reload, and Map brings the live map back.
      await page.reload();
      await goEvents(page);
      await page.locator(".cal-grid").waitFor();
      await page.locator(".events-view").getByRole("button", { name: "Map", exact: true }).click();
      // Only the Home plan has a place, so the map needs All circles for a pin.
      await page.locator(".map-scope").getByRole("button", { name: "All circles" }).click();
      await page.locator("#hangry-map").waitFor({ timeout: 10_000 });
      assert.equal(await page.locator(".cal-grid").count(), 0);
      await page.locator(".leaflet-marker-icon.pin-plan").first().waitFor({ timeout: 10_000 });
      const map = await page.locator("#hangry-map").boundingBox();
      const bar = await page.locator(".tabbar").boundingBox();
      assert.ok(map && bar && map.y + map.height <= bar.y + 1, `${tag} map ends above the tab bar`);
      await shot(page, `calendar-mapview-${tag}.png`);
      assert.equal(await page.evaluate(() => localStorage.getItem("hangry-events-view-v2")), "map");
      assert.deepEqual(errors, [], tag);
    } finally {
      await page.context().close();
    }
  }
});

test("calendar: one circle opens on Calendar without the scope switch", { timeout: 60_000 }, async () => {
  const solo = await hangry.call("POST", "/api/auth/start", undefined, { name: "Solo" });
  const { circle } = await hangry.call("POST", "/api/circles", solo.token, { name: "Only" });
  await hangry.call("POST", "/api/plans", solo.token, { note: "Solo walk", time: "15:00", date: "2026-11-12" });
  const page = await open(320, 568, solo.token, circle.id);
  try {
    await goEvents(page);
    await assertCalendarDefault(page, "solo");
    assert.equal(await page.locator(".map-scope").count(), 0);
    await cell(page, "2026-11-12").click();
    const row = page.locator(".cal-event", { hasText: "Solo walk" });
    await row.waitFor();
    assert.doesNotMatch((await row.textContent()) || "", /Only/, "no circle name with one circle");
    await noSideScroll(page, 320, "solo");
    await shot(page, "calendar-solo-320.png", ".cal-event");
  } finally {
    await page.context().close();
  }
});

test("events view: a picked Map is kept on the v2 key, and the old key does not keep anyone on the map", { timeout: 60_000 }, async () => {
  const user = await hangry.call("POST", "/api/auth/start", undefined, { name: "Vee" });
  const { circle } = await hangry.call("POST", "/api/circles", user.token, { name: "Pins" });
  await hangry.call("POST", "/api/plans", user.token, { note: "Pin walk", time: "15:00", date: "2026-11-12", place: "Park", lat: 48.77, lng: 9.18, precise: true });
  const page = await open(360, 640, user.token, circle.id);
  const view = page.locator(".events-view");
  try {
    // Someone who stayed on Map in the earlier build: only the old key is set, so Calendar shows.
    await page.evaluate(() => localStorage.setItem("hangry-events-view", "map"));
    await page.reload();
    await goEvents(page);
    await assertCalendarDefault(page, "old key");

    // The new key set to map opens the map.
    await page.evaluate(() => localStorage.setItem("hangry-events-view-v2", "map"));
    await page.reload();
    await goEvents(page);
    assert.equal(await view.getByRole("button", { name: "Map", exact: true }).getAttribute("aria-pressed"), "true");
    await page.locator("#hangry-map").waitFor({ timeout: 10_000 });
    assert.equal(await page.locator(".cal-grid").count(), 0);
    assert.equal((await page.locator(".screen-title").first().textContent())?.trim(), "Events");

    // Tapping Calendar saves it, and it sticks.
    await view.getByRole("button", { name: "Calendar", exact: true }).click();
    await page.locator(".cal-grid").waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("hangry-events-view-v2")), "calendar");
    await page.reload();
    await goEvents(page);
    await assertCalendarDefault(page, "picked calendar");
  } finally {
    await page.context().close();
  }
});
