import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { fakeGoogle, type Fake } from "../fake-google.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
const MIN = 60_000;
/** Screenshots land here (gitignored). Override with GF_SHOT_DIR. */
const SHOT_DIR = path.resolve(process.env.GF_SHOT_DIR || "test/ui/screenshots/google-freebusy");
const PERMISSIONS = "https://myaccount.google.com/permissions";
/** Google never sends titles, so none of these may ever show up. */
const SECRET_TITLES = ["Tennis lesson", "Dentist", "Team lunch", "Secret Street"];

// The fake Google starts first (top-level await) so both Hangry servers get its URLs in their env.
const fake: Fake = await fakeGoogle();
const googleEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(fake.env)) if (value !== undefined) googleEnv[key] = value;
test.after(async () => {
  await fake.close();
});

// PUBLIC_BASE_URL stays unset on purpose: the callback origin comes from the Host header, which is the test server.
const on = useHangry({ tz: TZ, env: googleEnv });
const off = useHangry({ tz: TZ });

type Hangry = typeof on;

async function phone(h: Hangry, width: number, height: number, token: string, circleId: string, route = "/") {
  const context = await h.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_circle", circle);
  }, [token, circleId]);
  await context.route("https://*.tile.openstreetmap.org/**", (r) => r.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(`${h.baseUrl}${route}`);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

/** The calendar link field and any feed URL are masked in every shot. */
async function shot(page: Page, name: string, width: number) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}-${width}.png`);
  await page.waitForFunction(() => document.getAnimations().every((item) => item.playState !== "running" || item.effect?.getComputedTiming().iterations === Infinity));
  await page.screenshot({ path: file, mask: [page.locator("#calendar-sync-url"), page.locator(".feed-url")], maskColor: "#3a3a3c" });
  if (width === 360) fs.copyFileSync(file, path.join(SHOT_DIR, `${name}.png`));
}

async function noSideScroll(page: Page, panel: ReturnType<Page["getByRole"]>) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, `page scrolls sideways by ${wide}px`);
  const inner = await panel.evaluate((node) => node.scrollWidth - node.clientWidth);
  assert.ok(inner <= 1, `panel overflows by ${inner}px`);
  const box = await panel.boundingBox();
  const viewport = page.viewportSize()!;
  assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1, "panel fits the width");
}

function absent(text: string, label: string) {
  for (const title of SECRET_TITLES) assert.ok(!text.includes(title), `${label} leaks an event title`);
}

async function openYou(page: Page) {
  await page.locator(".tabbar").getByRole("button", { name: "You", exact: true }).click();
  const panel = page.getByRole("region", { name: "Calendar availability" });
  await panel.waitFor();
  return panel;
}

/** Waits for the panel to settle (loaded) then brings a node to the middle of the screen. */
async function show(page: Page, locator: ReturnType<Page["locator"]>) {
  await locator.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(250);
}

async function seed(h: Hangry, tag: string) {
  const alex = await h.call("POST", "/api/auth/start", undefined, { name: "Alex" });
  const friends = (await h.call("POST", "/api/circles", alex.token, { name: `Friends ${tag}` })).circle;
  const work = (await h.call("POST", "/api/circles", alex.token, { name: `Work ${tag}` })).circle;
  const bea = await h.call("POST", "/api/auth/start", undefined, { name: "Bea", code: friends.inviteCode });
  return { alex, bea, friends, work };
}

function busyNow() {
  const now = Math.floor(Date.now() / MIN) * MIN;
  fake.busy = [
    { start: now - 30 * MIN, end: now + 90 * MIN },
    { start: now + 26 * 60 * MIN, end: now + 27 * 60 * MIN },
  ];
}

/** The same trip the browser makes, without a browser: start, fake consent, callback. */
async function connectViaApi(h: Hangry, token: string) {
  const started = await h.call("GET", "/api/calendar/google/start", token);
  const auth = new URL(started.url);
  const back = new URL(auth.searchParams.get("redirect_uri")!);
  back.searchParams.set("code", "good-code");
  back.searchParams.set("state", auth.searchParams.get("state")!);
  const reply = await fetch(back, { redirect: "manual" });
  assert.equal(reply.status, 302);
  assert.ok(String(reply.headers.get("location")).endsWith("/?calendar=google"));
}

for (const [width, height] of SIZES) {
  test(`at ${width}: feature off shows only the private link, with the honest note`, { timeout: 120_000 }, async () => {
    const { alex, friends } = await seed(off, `o${width}`);
    const page = await phone(off, width, height, alex.token, friends.id);
    try {
      const panel = await openYou(page);
      await panel.getByRole("button", { name: "Connect calendar" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Connect Google Calendar" }).count(), 0);
      assert.equal(await panel.getByText("What Hangry can and can't see").count(), 0);
      await panel.getByText("including event names", { exact: false }).waitFor();
      await panel.getByText("Friends still only see busy or free.", { exact: false }).waitFor();
      await panel.getByText("They never see what is in your calendar.", { exact: false }).waitFor();
      assert.equal((await off.call("GET", "/api/me/calendar-sync", alex.token)).googleAvailable, false);
      await show(page, panel);
      await noSideScroll(page, panel);
      await shot(page, "off-settings", width);
    } finally {
      await page.context().close();
    }
  });

  test(`at ${width}: feature on, not connected, explains what Hangry sees and stores`, { timeout: 120_000 }, async () => {
    const { alex, friends } = await seed(on, `n${width}`);
    const page = await phone(on, width, height, alex.token, friends.id);
    try {
      const panel = await openYou(page);
      const connect = panel.getByRole("button", { name: "Connect Google Calendar" });
      await connect.waitFor();
      const text = (await panel.innerText()).replace(/\s+/g, " ");
      for (const phrase of [
        "They never see what is in your calendar.",
        "never event names, places, people or notes",
        "only for the free/busy permission",
        "never receives event titles or details, and never stores them",
        "busy times for the next 14 days",
        "encrypted token",
        "about every 20 minutes",
        "tap Remove in this panel",
        "deletes the token and the busy times, and tells Google to revoke access",
        "A private calendar link lets Hangry download the whole calendar file, including event names.",
        "your event names encrypted for you alone",
        "It discards places, notes and people. Friends still only see busy or free.",
      ]) assert.ok(text.includes(phrase), `panel says: ${phrase}`);
      const link = panel.getByRole("link", { name: "myaccount.google.com/permissions" });
      assert.equal(await link.getAttribute("href"), PERMISSIONS);
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
      await panel.getByRole("button", { name: "Connect calendar" }).waitFor();
      assert.ok(await panel.locator("#calendar-sync-url").isVisible(), "private link form is still there");

      // Google comes first, the private link after.
      const top = async (selector: string) => (await panel.locator(selector).first().boundingBox())?.y ?? -1;
      const order = { google: await top(".sync-google"), facts: await top(".sync-facts"), form: await top("form") };
      assert.ok(order.google < order.facts && order.facts < order.form, "Google first, then the facts, then the link");

      const tall = await connect.boundingBox();
      assert.ok(tall && tall.height >= 44, `Connect Google Calendar is at least 44px tall: ${tall?.height}`);
      const submit = await panel.getByRole("button", { name: "Connect calendar" }).boundingBox();
      assert.ok(submit && submit.height >= 44, `Connect calendar is at least 44px tall: ${submit?.height}`);
      await noSideScroll(page, panel);
      await show(page, panel);
      await shot(page, "settings", width);
      await show(page, panel.locator(".sync-facts"));
      await shot(page, "explanation", width);
      await show(page, panel.locator(".secret-link-note"));
      await shot(page, "link-fallback", width);
    } finally {
      await page.context().close();
    }
  });

  test(`at ${width}: Alex connects Google, shares a circle, and Bea sees busy or free`, { timeout: 180_000 }, async () => {
    busyNow();
    const { alex, bea, friends, work } = await seed(on, `g${width}`);
    const revokesBefore = fake.revokes.length;
    const page = await phone(on, width, height, alex.token, friends.id);
    const seen: string[] = [];
    page.on("response", async (response) => {
      if (response.url().includes("/api/")) seen.push(await response.text().catch(() => ""));
    });
    try {
      let panel = await openYou(page);
      await panel.getByRole("button", { name: "Connect Google Calendar" }).click();

      // Fake Google's consent page, then back to Hangry.
      await page.locator("#allow").waitFor();
      assert.ok(page.url().startsWith(fake.env.GOOGLE_OAUTH_AUTH_URL!), "went to the consent page");
      await page.locator("#allow").click();
      await page.waitForURL((url) => url.origin === on.baseUrl);

      // Landed on You with the connected state, the toast, and a clean URL.
      panel = page.getByRole("region", { name: "Calendar availability" });
      await panel.getByText("Connected: Google").waitFor();
      await page.locator(".toast", { hasText: "Google Calendar connected" }).waitFor();
      assert.equal(new URL(page.url()).search, "", "calendar param is stripped");
      await panel.getByText("Last checked", { exact: false }).waitFor();
      await panel.getByText("Hangry never sees the names of your events, so they will not appear when you tap I'm in.").waitFor();
      assert.equal(await panel.getByText("you see your own events for that day first", { exact: false }).count(), 0);
      assert.equal(await panel.getByRole("link", { name: "myaccount.google.com/permissions" }).getAttribute("href"), PERMISSIONS);
      assert.equal(await page.getByRole("button", { name: "Connect Google Calendar" }).count(), 0);
      assert.equal(await panel.locator("#calendar-sync-url").count(), 0);

      const status = await on.call("GET", "/api/me/calendar-sync", alex.token);
      assert.equal(status.source, "google");
      assert.equal(status.host, "Google");
      assert.deepEqual((await on.call("GET", `/api/me/calendar-sync/day?date=${new Date().toISOString().slice(0, 10)}`, alex.token)).events, []);

      // Share with Friends, not Work.
      const patch = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith("/api/me/calendar-sync"));
      await panel.getByRole("checkbox", { name: friends.name }).check();
      assert.deepEqual((await patch).request().postDataJSON(), { sharedCircleIds: [friends.id] });
      await panel.getByRole("checkbox", { name: friends.name, checked: true }).waitFor();
      assert.equal(await panel.getByRole("checkbox", { name: work.name }).isChecked(), false);
      for (const box of await panel.locator(".share-toggle").all()) {
        const rect = await box.boundingBox();
        assert.ok(rect && rect.height >= 44, `circle toggle is at least 44px tall: ${rect?.height}`);
      }
      for (const button of await panel.locator(".feed-manage .text-btn").all()) {
        const rect = await button.boundingBox();
        assert.ok(rect && rect.height >= 44, `manage button is at least 44px tall: ${rect?.height}`);
      }
      absent(await page.locator("body").innerText(), "Alex's You tab");
      await show(page, panel);
      await noSideScroll(page, panel);
      await shot(page, "connected", width);
      await show(page, panel.locator(".feed-manage"));
      await shot(page, "connected-bottom", width);

      // Bea sees Alex as busy, with no names.
      const beaPage = await phone(on, width, height, bea.token, friends.id);
      try {
        await beaPage.locator(".tabbar").getByRole("button", { name: "Circle", exact: true }).click();
        const row = beaPage.locator(".member-row", { hasText: "Alex" });
        await row.locator(".avail-line.busy", { hasText: "Busy until" }).waitFor();
        await row.scrollIntoViewIfNeeded();
        await beaPage.waitForTimeout(400);
        absent(await beaPage.locator("body").innerText(), "Bea's circle tab");
        const wide = await beaPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(wide <= 1, `Bea's page scrolls sideways by ${wide}px`);
        await shot(beaPage, "friend-view", width);
      } finally {
        await beaPage.context().close();
      }
      const beaMe = JSON.stringify(await on.call("GET", "/api/me", bea.token));
      absent(beaMe, "Bea's /api/me");
      absent(seen.join("\n"), "Alex's API responses");

      // Remove: the confirmation names the revoke, then the Google UI comes back.
      await panel.getByRole("button", { name: "Remove" }).click();
      const sheet = page.locator(".sheet-confirm");
      await sheet.getByText("Friends stop seeing when you're busy. Hangry deletes the token and the busy times, and tells Google to revoke access.").waitFor();
      await shot(page, "remove-confirm", width);
      await sheet.getByRole("button", { name: "Remove" }).click();
      await panel.getByRole("button", { name: "Connect Google Calendar" }).waitFor();
      assert.equal((await on.call("GET", "/api/me/calendar-sync", alex.token)).connected, false);
      assert.equal(fake.revokes.length, revokesBefore + 1, "Google was asked to revoke");
      const gone = await on.call("GET", "/api/me", bea.token);
      assert.equal(gone.circle.members.find((m: { name: string }) => m.name === "Alex").availability, null);
    } finally {
      await page.context().close();
    }
  });
}

test("at 360: a failed start shows a short error and never the URL", { timeout: 120_000 }, async () => {
  const { alex, friends } = await seed(on, "fail");
  const page = await phone(on, 360, 640, alex.token, friends.id);
  try {
    const panel = await openYou(page);
    await panel.getByRole("button", { name: "Connect Google Calendar" }).waitFor();
    await page.route("**/api/calendar/google/start", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
    await panel.getByRole("button", { name: "Connect Google Calendar" }).click();
    await panel.getByText("Could not reach Google Calendar. Try again.").waitFor();
    assert.ok(page.url().startsWith(on.baseUrl), "stayed in Hangry");
    await panel.getByRole("button", { name: "Connect Google Calendar" }).waitFor();
    assert.ok(!(await panel.innerText()).includes("accounts"), "no URL in the panel");
  } finally {
    await page.context().close();
  }
});

test("at 360: ?calendar=google-error shows the error toast and the disconnected panel", { timeout: 120_000 }, async () => {
  const { alex, friends } = await seed(on, "err");
  const page = await phone(on, 360, 640, alex.token, friends.id, "/?calendar=google-error");
  try {
    await page.locator(".toast", { hasText: "Could not connect Google Calendar. Try again." }).waitFor();
    assert.equal(new URL(page.url()).search, "", "calendar param is stripped");
    const panel = page.getByRole("region", { name: "Calendar availability" });
    await panel.getByRole("button", { name: "Connect Google Calendar" }).waitFor();
    assert.equal(await panel.getByText("Connected:", { exact: false }).count(), 0);
    await show(page, panel);
    await shot(page, "error-landing", 360);
  } finally {
    await page.context().close();
  }
});

test("at 360: ?calendar=google lands on You with the connected panel", { timeout: 120_000 }, async () => {
  busyNow();
  const { alex, friends } = await seed(on, "land");
  await connectViaApi(on, alex.token);
  const page = await phone(on, 360, 640, alex.token, friends.id, "/?calendar=google");
  try {
    await page.locator(".toast", { hasText: "Google Calendar connected" }).waitFor();
    const panel = page.getByRole("region", { name: "Calendar availability" });
    await panel.getByText("Connected: Google").waitFor();
    assert.equal(new URL(page.url()).search, "");
  } finally {
    await page.context().close();
  }
});

/** What Android does after Google: a browser tab with no Hangry session. */
async function bareTab(h: Hangry, route: string) {
  const context = await h.browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
  const page = await context.newPage();
  await page.goto(`${h.baseUrl}${route}`);
  return page;
}

async function noLoginForm(page: Page) {
  await page.getByText("Go back to Hangry.").waitFor();
  assert.equal(await page.getByLabel("Your name").count(), 0, "no name field");
  assert.equal(await page.getByRole("button", { name: "Continue" }).count(), 0, "no Continue button");
  assert.equal(await page.getByText("A private circle", { exact: false }).count(), 0, "no login lede");
  assert.equal(await page.locator("input").count(), 0, "no inputs at all");
  assert.equal(new URL(page.url()).search, "", "calendar param is stripped");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, `page scrolls sideways by ${wide}px`);
}

test("at 360: ?calendar=google with no session says connected and go back, with no login form", { timeout: 120_000 }, async () => {
  busyNow();
  const { alex } = await seed(on, "ret");
  await connectViaApi(on, alex.token);
  const page = await bareTab(on, "/?calendar=google");
  try {
    await page.getByText("Google Calendar connected.").waitFor();
    await noLoginForm(page);
    assert.equal(await page.getByText("Could not connect", { exact: false }).count(), 0);
    await shot(page, "return-no-session", 360);
  } finally {
    await page.context().close();
  }
});

test("at 360: ?calendar=google-error with no session says it failed and go back, with no login form", { timeout: 120_000 }, async () => {
  const page = await bareTab(on, "/?calendar=google-error");
  try {
    await page.getByText("Could not connect Google Calendar.").waitFor();
    await noLoginForm(page);
    assert.equal(await page.getByText("Google Calendar connected", { exact: false }).count(), 0);
    await shot(page, "return-error-no-session", 360);
  } finally {
    await page.context().close();
  }
});

test("at 360: a signed-in page left on You notices Google connected when it comes back", { timeout: 120_000 }, async () => {
  busyNow();
  const { alex, friends } = await seed(on, "vis");
  const page = await phone(on, 360, 640, alex.token, friends.id);
  try {
    const panel = await openYou(page);
    await panel.getByRole("button", { name: "Connect Google Calendar" }).waitFor();
    await connectViaApi(on, alex.token);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator(".toast", { hasText: "Google Calendar connected" }).waitFor();
    await panel.getByText("Connected: Google").waitFor();
    assert.equal(new URL(page.url()).pathname, "/");
    await shot(page, "return-visible", 360);

    // Already connected: later app switches stay quiet.
    await page.waitForFunction(() => !document.querySelector(".toast"), undefined, { timeout: 8000 });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".toast").count(), 0, "no second toast");
  } finally {
    await page.context().close();
  }
});
