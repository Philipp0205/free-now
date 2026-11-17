import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { UA, useHangry, testEmail } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";

// Native feel part B: sheets that snap and flick, large titles, screen transitions. Fake people only.
// Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/native-feel-b");
const SIZES = [[320, 568], [360, 640], [390, 844], [412, 915]] as const;

const hangry = useHangry({ tz: "UTC" });

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

async function seed() {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const circle = (await hangry.call("POST", "/api/circles", host.token, { name: "Native crew" })).circle;
  for (const name of ["Finn", "Uma", "Ben"]) {
    await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name, code: circle.inviteCode });
  }
  for (const [index, note] of ["Sushi night", "Board games", "Morning run", "Rooftop drinks"].entries()) {
    await hangry.call("POST", "/api/plans", host.token, { note, date: tomorrow(), time: `1${index}:30` });
  }
  // No "confirm your email" banner above the page, so the bar is the first thing on screen.
  hangry.confirmEmails();
  return host;
}

type Options = { width: number; height: number; reducedMotion?: "reduce" | "no-preference"; colorScheme?: "dark" | "light" };

/** A phone with a spy on document.startViewTransition: how often it ran, and which data-ak-nav it ran with. */
async function phone(token: string, { width, height, reducedMotion = "no-preference", colorScheme = "dark" }: Options) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, reducedMotion, colorScheme });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
    const spy = { count: 0, directions: [] as (string | null)[] };
    (window as any).__vt = spy;
    const original = document.startViewTransition?.bind(document);
    if (original) {
      (document as any).startViewTransition = (callback: () => unknown) => {
        spy.count += 1;
        spy.directions.push(document.documentElement.getAttribute("data-ak-nav"));
        return original(callback);
      };
    }
  }, token);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator("nav.tabbar").waitFor();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return page;
}

const tab = (page: Page, name: string) => page.locator("nav.tabbar").getByRole("button", { name, exact: true });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

function alpha(color: string): number {
  const match = /^rgba?\(([^)]+)\)$/.exec(color);
  assert.ok(match, `not a colour: ${color}`);
  const parts = match[1].split(/[,/]\s*|\s+/).filter(Boolean);
  return parts.length >= 4 ? Number(parts[3]) : 1;
}

/** Make the page tall enough to scroll, inside the test only. */
async function makeTall(page: Page) {
  await page.addStyleTag({ content: ".page { min-height: 2600px !important; }" });
}

// ---- Sheets ----

const sheetBox = (page: Page) => page.getByRole("dialog").evaluate((node) => {
  const rect = node.getBoundingClientRect();
  return { height: rect.height, top: rect.top, bottom: rect.bottom };
});

async function openMember(page: Page, name = "Finn") {
  await tab(page, "Circle").click();
  await page.getByRole("button", { name: `Details for ${name}` }).click();
  await page.getByRole("dialog", { name }).waitFor();
}

/** Tall enough that the sheet needs a half stop. */
async function padSheet(page: Page) {
  await page.addStyleTag({ content: ".sheet .actions::after { content: ''; display: block; height: 700px; }" });
}

async function grab(page: Page) {
  const box = (await page.locator(".sheet .grabber").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drag the grabber. Slow stays under the flick speed (0.5 px/ms); flick is a few quick moves. */
async function drag(page: Page, dy: number, mode: "slow" | "flick") {
  const from = await grab(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = mode === "slow" ? 6 : 4;
  for (let index = 1; index <= steps; index += 1) {
    await page.mouse.move(from.x, from.y + (dy * index) / steps);
    if (mode === "slow") await page.waitForTimeout(130);
  }
  await page.mouse.up();
}

const SETTLE = 450;

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`a tall sheet snaps half and full, and a flick closes it (${reducedMotion})`, { timeout: 240_000 }, async () => {
    const host = await seed();
    for (const [width, height] of SIZES) {
      if (reducedMotion === "reduce" && width !== 360 && width !== 412) continue;
      const tag = `${width}x${height} ${reducedMotion}`;
      const page = await phone(host.token, { width, height, reducedMotion });
      try {
        await padSheet(page);
        await openMember(page);
        const half = Math.round(height * 0.5);

        // It opens resting on the half stop, with no settle animation on the way in.
        const opened = await sheetBox(page);
        assert.ok(Math.abs(opened.height - half) <= 2, `${tag}: opens at half ${opened.height} vs ${half}`);
        assert.ok(Math.abs(opened.bottom - height) <= 1, `${tag}: opens on the bottom edge`);
        assert.equal(await page.locator(".sheet.snap-settle").count(), 0, `${tag}: no settle animation on open`);
        assert.equal(await page.locator(".sheet .actions").getByRole("button", { name: "Make admin" }).count(), 1);
        if (width === 360 || width === 390) await shot(page, `sheet-half-${reducedMotion}`);

        // A slow pull up goes to full.
        await drag(page, -(height - half), "slow");
        if (reducedMotion === "reduce") {
          assert.equal(await page.locator(".sheet.snap-settle").count(), 0, `${tag}: no settle animation`);
        }
        await page.waitForTimeout(SETTLE);
        const full = (await sheetBox(page)).height;
        assert.ok(full > half + 60, `${tag}: the sheet is taller than the half stop (${full})`);
        assert.equal(await page.getByRole("dialog").evaluate((node) => (node as HTMLElement).style.maxHeight), "", `${tag}: full has no inline cap`);
        if (width === 360 || width === 390) await shot(page, `sheet-full-${reducedMotion}`);

        // A short slow pull from full is nearer full than half, so it springs back.
        await drag(page, 40, "slow");
        await page.waitForTimeout(SETTLE);
        assert.ok(Math.abs((await sheetBox(page)).height - full) <= 2, `${tag}: small pull springs back`);

        // A slow pull down to about the middle rests on the half stop.
        await drag(page, full - half + 10, "slow");
        await page.waitForTimeout(SETTLE);
        const atHalf = await sheetBox(page);
        assert.ok(Math.abs(atHalf.height - half) <= 2, `${tag}: slow pull rests on half ${atHalf.height} vs ${half}`);
        assert.ok(Math.abs(atHalf.bottom - height) <= 1, `${tag}: still on the bottom edge`);

        // A quick flick up from half goes to full.
        await drag(page, -70, "flick");
        await page.waitForTimeout(SETTLE);
        assert.ok(Math.abs((await sheetBox(page)).height - full) <= 2, `${tag}: flick up lands on full`);

        // A quick flick down from full steps to half. It does not close.
        await drag(page, 70, "flick");
        await page.waitForTimeout(SETTLE);
        const flicked = await sheetBox(page);
        assert.ok(Math.abs(flicked.height - half) <= 2, `${tag}: flick from full lands on half (${flicked.height})`);

        // A second flick down from half closes it.
        await drag(page, 60, "flick");
        await page.getByRole("dialog").waitFor({ state: "detached" });

        // Reopening starts on the half stop again.
        await openMember(page);
        assert.ok(Math.abs((await sheetBox(page)).height - half) <= 2, `${tag}: reopens at half`);
      } finally {
        await page.context().close();
      }
    }
  });
}

test("a long slow pull below the half stop closes the sheet, and a short one does not", { timeout: 120_000 }, async () => {
  const host = await seed();
  const page = await phone(host.token, { width: 360, height: 640 });
  try {
    await padSheet(page);
    await openMember(page);
    assert.ok(Math.abs((await sheetBox(page)).height - 320) <= 2, "opens on half");
    // 30px below the half stop: not far enough to close.
    await drag(page, 30, "slow");
    await page.waitForTimeout(SETTLE);
    assert.ok(Math.abs((await sheetBox(page)).height - 320) <= 2, "springs back to half");
    assert.equal(await page.getByRole("dialog").count(), 1);
    // More than 72px below it closes, and Back history is clean afterwards.
    await drag(page, 120, "slow");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.locator(".phone .page").getByRole("heading", { name: "Circle", exact: true, level: 1 }).waitFor();
  } finally {
    await page.context().close();
  }
});

test("a short sheet has no half stop: a slow pull springs back, a long one or a flick closes it", { timeout: 120_000 }, async () => {
  const host = await seed();
  const page = await phone(host.token, { width: 412, height: 915 });
  try {
    await openMember(page);
    const before = await sheetBox(page);
    assert.ok(before.height < 915 / 2, `short sheet (${before.height})`);
    assert.equal(await page.getByRole("dialog").evaluate((node) => (node as HTMLElement).style.maxHeight), "", "opens at its natural height, no cap");
    await shot(page, "sheet-short");
    await drag(page, 40, "slow");
    await page.waitForTimeout(SETTLE);
    assert.ok(Math.abs((await sheetBox(page)).height - before.height) <= 1, "same height, no half stop");
    assert.ok(Math.abs((await sheetBox(page)).bottom - 915) <= 1, "back on the bottom edge");
    await drag(page, 130, "slow");
    await page.getByRole("dialog").waitFor({ state: "detached" });

    await openMember(page, "Uma");
    await drag(page, 60, "flick");
    await page.getByRole("dialog").waitFor({ state: "detached" });
  } finally {
    await page.context().close();
  }
});

// ---- Event details ----

/** A plan with eight people in, so its details sheet is tall. */
async function seedCrowd() {
  const host = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Hana" });
  const circle = (await hangry.call("POST", "/api/circles", host.token, { name: "Crowd crew" })).circle;
  const { plan } = await hangry.call("POST", "/api/plans", host.token, { note: "Big picnic", date: tomorrow(), time: "13:00" });
  for (const name of ["Alex", "Bea", "Cy", "Dee", "Eli", "Fay", "Gus", "Ivy"]) {
    const friend = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name, code: circle.inviteCode });
    await hangry.call("POST", `/api/plans/${plan.id}/reply`, friend.token, { reply: "in" });
  }
  hangry.confirmEmails();
  return { host, circle, plan };
}

const dockBox = (page: Page) => page.locator(".sheet .sheet-dock").evaluate((node) => {
  const rect = node.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, height: rect.height };
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`event details open at half, go full, keep their stop through a refresh, and flick closed (${reducedMotion})`, { timeout: 300_000 }, async () => {
    const { host, circle, plan } = await seedCrowd();
    for (const [width, height] of SIZES) {
      const tag = `details ${width}x${height} ${reducedMotion}`;
      const page = await phone(host.token, { width, height, reducedMotion });
      try {
        await page.locator(`.card-plan[data-plan="${plan.id}"] .card-body`).click();
        await page.getByRole("dialog", { name: "Details" }).waitFor();
        const half = Math.round(height * 0.5);
        const opened = await sheetBox(page);
        const natural = await page.getByRole("dialog").evaluate((node) => {
          const panel = node as HTMLElement;
          const held = panel.style.maxHeight;
          panel.style.maxHeight = "";
          const value = panel.getBoundingClientRect().height;
          panel.style.maxHeight = held;
          return value;
        });
        assert.equal(await page.locator(".sheet.snap-settle").count(), 0, `${tag}: no settle animation on open`);
        if (natural - half < 48) {
          // Genuinely too short for two stops: it opens at its natural height.
          console.log(`${tag}: details are only ${natural}px tall, too short for a half stop; asserting natural height only`);
          assert.ok(Math.abs(opened.height - natural) <= 1, `${tag}: opens at its natural height ${opened.height} vs ${natural}`);
          assert.equal(await page.getByRole("dialog").evaluate((node) => (node as HTMLElement).style.maxHeight), "", `${tag}: no cap`);
          continue;
        }

        assert.ok(Math.abs(opened.height - half) <= 2, `${tag}: opens at half ${opened.height} vs ${half}`);
        assert.ok(Math.abs(opened.bottom - height) <= 1, `${tag}: bottom edge`);
        const dockHalf = await dockBox(page);
        assert.ok(dockHalf.height > 20 && dockHalf.bottom <= height + 1 && dockHalf.top >= opened.top, `${tag}: the dock stays visible at half`);
        await page.locator(".sheet .sheet-dock").getByRole("button", { name: "End plan" }).waitFor();
        if (width === 360 || width === 390) await shot(page, `details-half-${reducedMotion}`);

        // A slow drag up goes to full.
        await drag(page, -(height - half), "slow");
        await page.waitForTimeout(SETTLE);
        const full = await sheetBox(page);
        assert.ok(Math.abs(full.height - natural) <= 2, `${tag}: full ${full.height} vs ${natural}`);
        assert.ok(Math.abs(full.bottom - height) <= 1, `${tag}: full on the bottom edge`);
        assert.ok((await dockBox(page)).bottom <= height + 1, `${tag}: the dock stays visible at full`);
        if (width === 360 || width === 390) await shot(page, `details-full-${reducedMotion}`);

        // A re-render (someone else posts, the 3s refresh redraws) keeps the full stop.
        await page.evaluate(() => {
          (window as any).__draws = 0;
          new MutationObserver(() => { (window as any).__draws += 1; }).observe(document.getElementById("app")!, { childList: true, subtree: true });
        });
        const poster = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: `Zed${width}${reducedMotion === "reduce" ? "r" : "m"}`, code: circle.inviteCode });
        await hangry.call("POST", "/api/socials", poster.token, { note: `Coffee ${width}` });
        await page.waitForFunction(() => (window as any).__draws > 0, undefined, { timeout: 10_000 });
        await page.waitForTimeout(3500);
        const kept = await sheetBox(page);
        assert.ok(Math.abs(kept.height - full.height) <= 2, `${tag}: still full after a refresh (${kept.height} vs ${full.height})`);

        // A flick down from full goes to half.
        await drag(page, 70, "flick");
        await page.waitForTimeout(SETTLE);
        const flicked = await sheetBox(page);
        assert.ok(Math.abs(flicked.height - half) <= 2, `${tag}: flick from full lands on half (${flicked.height})`);
        assert.ok((await dockBox(page)).bottom <= height + 1, `${tag}: the dock is visible again at half`);

        // A refresh while at half keeps half.
        await hangry.call("POST", "/api/socials", poster.token, { note: `Tea ${width}` });
        await page.waitForTimeout(3500);
        assert.ok(Math.abs((await sheetBox(page)).height - half) <= 2, `${tag}: still half after a refresh`);

        // A flick down from half closes it.
        await drag(page, 60, "flick");
        await page.getByRole("dialog").waitFor({ state: "detached" });

        // Reopening starts on half again.
        await page.locator(`.card-plan[data-plan="${plan.id}"] .card-body`).click();
        await page.getByRole("dialog", { name: "Details" }).waitFor();
        assert.ok(Math.abs((await sheetBox(page)).height - half) <= 2, `${tag}: reopens at half`);
      } finally {
        await page.context().close();
      }
    }
  });
}

// ---- Large titles ----

for (const name of ["Now", "Events", "Circle", "You"]) {
  test(`${name} has a large title that collapses into the bar and comes back`, { timeout: 180_000 }, async () => {
    const host = await seed();
    for (const [width, height] of SIZES) {
      const tag = `${name} ${width}x${height}`;
      const page = await phone(host.token, { width, height });
      try {
        if (name !== "Now") await tab(page, name).click();
        const heading = page.getByRole("heading", { name, exact: true, level: 1 });
        await heading.waitFor();
        await makeTall(page);
        const info = await page.evaluate(() => {
          const bar = document.querySelector(".ak-navbar")!;
          const title = document.querySelector(".screen-head .ak-large-title")!;
          const small = bar.querySelector(".ak-navbar-title")!;
          const bell = document.querySelector(".screen-head .icon-btn[aria-label^='Alerts']");
          return {
            bars: document.querySelectorAll(".ak-navbar").length,
            barAria: bar.getAttribute("aria-hidden"),
            collapsed: bar.classList.contains("ak-collapsed"),
            smallText: small.textContent,
            smallOpacity: getComputedStyle(small).opacity,
            barTop: bar.getBoundingClientRect().top,
            sticky: getComputedStyle(bar).position,
            titleClass: title.className,
            titleSize: parseFloat(getComputedStyle(title).fontSize),
            titleTop: title.getBoundingClientRect().top,
            bell: Boolean(bell),
            bellInHead: Boolean(bell?.closest(".screen-head")),
          };
        });
        assert.equal(info.bars, 1, `${tag}: one bar`);
        assert.equal(info.barAria, "true", `${tag}: the small title is hidden from screen readers`);
        assert.equal(info.collapsed, false, `${tag}: expanded at the top`);
        assert.equal(info.smallText, name);
        assert.equal(info.smallOpacity, "0", `${tag}: small title hidden at the top`);
        assert.equal(info.sticky, "sticky");
        assert.ok(info.barTop <= 1, `${tag}: the bar reaches the top edge (${info.barTop})`);
        assert.ok(info.titleSize >= 32, `${tag}: large (${info.titleSize}px)`);
        assert.ok(info.bellInHead, `${tag}: the bell stays in the head`);
        if (width === 360 || width === 390) await shot(page, `title-${name.toLowerCase()}-top`);

        await page.evaluate(() => window.scrollTo(0, 400));
        await page.waitForFunction(() => document.querySelector(".ak-navbar")?.classList.contains("ak-collapsed"));
        await page.waitForTimeout(300);
        const scrolled = await page.evaluate(() => {
          const bar = document.querySelector(".ak-navbar")!;
          const title = document.querySelector(".screen-head .ak-large-title")!;
          return {
            y: window.scrollY,
            barTop: bar.getBoundingClientRect().top,
            barBottom: bar.getBoundingClientRect().bottom,
            titleBottom: title.getBoundingClientRect().bottom,
            smallOpacity: getComputedStyle(bar.querySelector(".ak-navbar-title")!).opacity,
            border: getComputedStyle(bar).borderBottomColor,
            background: getComputedStyle(bar).backgroundColor,
          };
        });
        assert.ok(scrolled.y >= 300, `${tag}: scrolled (${scrolled.y})`);
        assert.ok(Math.abs(scrolled.barTop) <= 1, `${tag}: the bar sticks to the top (${scrolled.barTop})`);
        assert.ok(scrolled.titleBottom <= scrolled.barBottom + 1, `${tag}: the large title is under the bar`);
        assert.equal(scrolled.smallOpacity, "1", `${tag}: small title shown`);
        assert.ok(alpha(scrolled.border) > 0, `${tag}: hairline under the bar`);
        assert.ok(alpha(scrolled.background) > 0, `${tag}: the bar has a glass background`);
        if (width === 360 || width === 390) await shot(page, `title-${name.toLowerCase()}-collapsed`);

        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForFunction(() => !document.querySelector(".ak-navbar")?.classList.contains("ak-collapsed"));
      } finally {
        await page.context().close();
      }
    }
  });
}

test("the collapsed bar survives a refresh redraw, and Alerts keeps its plain header", { timeout: 120_000 }, async () => {
  const host = await seed();
  const page = await phone(host.token, { width: 360, height: 640 });
  try {
    await makeTall(page);
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForFunction(() => document.querySelector(".ak-navbar")?.classList.contains("ak-collapsed"));
    // Count redraws of the app root, then let someone else post so the next refresh redraws.
    await page.evaluate(() => {
      (window as any).__draws = 0;
      new MutationObserver(() => { (window as any).__draws += 1; }).observe(document.getElementById("app")!, { childList: true });
    });
    const finn = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Zoe", code: (await hangry.call("GET", "/api/me", host.token)).circle.inviteCode });
    await hangry.call("POST", "/api/socials", finn.token, { note: "Coffee" });
    await page.waitForFunction(() => (window as any).__draws > 0, undefined, { timeout: 10_000 });
    const after = await page.evaluate(() => ({
      y: window.scrollY,
      collapsed: document.querySelector(".ak-navbar")?.classList.contains("ak-collapsed"),
    }));
    assert.ok(after.y >= 300, `scroll kept (${after.y})`);
    assert.equal(after.collapsed, true, "bar still collapsed after the redraw");

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(".screen-head .icon-btn[aria-label^='Alerts']").click();
    await page.getByRole("heading", { name: "Alerts", exact: true, level: 1 }).waitFor();
    assert.equal(await page.locator(".ak-navbar").count(), 0, "Alerts is not a large-title screen");
    assert.equal(await page.locator(".ak-large-title").count(), 0);
  } finally {
    await page.context().close();
  }
});

test("the large title bar reads well in light mode", { timeout: 60_000 }, async () => {
  const host = await seed();
  const page = await phone(host.token, { width: 360, height: 640, colorScheme: "light" });
  try {
    await makeTall(page);
    await shot(page, "title-now-top-light");
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForFunction(() => document.querySelector(".ak-navbar")?.classList.contains("ak-collapsed"));
    await page.waitForTimeout(300);
    const colors = await page.evaluate(() => {
      const bar = document.querySelector(".ak-navbar")!;
      return {
        bg: getComputedStyle(bar).backgroundColor,
        text: getComputedStyle(bar.querySelector(".ak-navbar-title")!).color,
      };
    });
    assert.ok(alpha(colors.bg) > 0.5, `glass bar ${colors.bg}`);
    assert.notEqual(colors.text, colors.bg);
    await shot(page, "title-now-collapsed-light");
  } finally {
    await page.context().close();
  }
});

// ---- Transitions ----

const vt = (page: Page) => page.evaluate(() => ({ ...(window as any).__vt, nav: document.documentElement.getAttribute("data-ak-nav") }));

test("Past events and an event chat slide in and out, and the tab bar stays out of the slide", { timeout: 180_000 }, async () => {
  const host = await seed();
  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const page = await phone(host.token, { width, height });
    try {
      await page.locator(".card-plan").first().waitFor();
      assert.equal(await page.locator("nav.tabbar").evaluate((node) => getComputedStyle(node).viewTransitionName), "ak-tabbar", `${tag}: tab bar is its own layer`);
      assert.equal((await vt(page)).count, 0, `${tag}: nothing has slid yet`);

      // Past events: push in, pop out with the in-app Back.
      await page.getByRole("button", { name: "Past events", exact: true }).click();
      await page.locator(".past-screen").waitFor();
      await page.waitForFunction(() => !document.documentElement.hasAttribute("data-ak-nav"));
      const pushed = await vt(page);
      assert.equal(pushed.count, 1, `${tag}: one transition for Past events`);
      assert.deepEqual(pushed.directions, ["push"], tag);
      if (width === 360 || width === 390) await shot(page, "past-pushed");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.locator(".card-plan").first().waitFor();
      await page.waitForFunction(() => !document.documentElement.hasAttribute("data-ak-nav"));
      assert.deepEqual((await vt(page)).directions, ["push", "pop"], `${tag}: Back pops`);

      // The phone's own Back pops too.
      await page.getByRole("button", { name: "Past events", exact: true }).click();
      await page.locator(".past-screen").waitFor();
      await page.goBack();
      await page.locator(".card-plan").first().waitFor();
      await page.waitForFunction(() => !document.documentElement.hasAttribute("data-ak-nav"));
      assert.deepEqual((await vt(page)).directions, ["push", "pop", "push", "pop"], `${tag}: history Back pops`);

      // An event chat from a card.
      await page.locator(".card-plan").first().getByRole("button", { name: "Chat", exact: true }).click();
      await page.getByRole("button", { name: "Back", exact: true }).waitFor();
      await page.waitForFunction(() => !document.documentElement.hasAttribute("data-ak-nav"));
      assert.deepEqual((await vt(page)).directions.slice(4), ["push"], `${tag}: chat pushes`);
      if (width === 360 || width === 390) await shot(page, "chat-pushed");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.locator(".card-plan").first().waitFor();
      await page.waitForFunction(() => !document.documentElement.hasAttribute("data-ak-nav"));
      assert.deepEqual((await vt(page)).directions.slice(4), ["push", "pop"], `${tag}: chat Back pops`);
      assert.equal(await page.locator("nav.tabbar").count(), 1, `${tag}: tab bar is back`);
    } finally {
      await page.context().close();
    }
  }
});

test("with reduced motion the screens change at once and no view transition runs", { timeout: 90_000 }, async () => {
  const host = await seed();
  const page = await phone(host.token, { width: 360, height: 640, reducedMotion: "reduce" });
  try {
    await page.locator(".card-plan").first().waitFor();
    await page.getByRole("button", { name: "Past events", exact: true }).click();
    await page.locator(".past-screen").waitFor();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.locator(".card-plan").first().waitFor();
    await page.locator(".card-plan").first().getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Back", exact: true }).waitFor();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.locator(".card-plan").first().waitFor();
    const after = await vt(page);
    assert.equal(after.count, 0, "no view transition");
    assert.equal(after.nav, null, "no data-ak-nav left behind");
  } finally {
    await page.context().close();
  }
});

// No page links ak-view-transitions.css. Chrome aborts a cross-document transition into or out of the app at
// random ("ViewTransition opt-in disabled") and reports it as an uncatchable page error, so only the screens
// inside the app slide (AppKit.transition.go).
test("no page opts in to cross-document view transitions", { timeout: 90_000 }, async () => {
  const host = await seed();
  const page = await phone(host.token, { width: 360, height: 640 });
  try {
    for (const route of ["/", "/welcome", "/privacy"]) {
      await page.goto(`${hangry.baseUrl}${route}`);
      const linked = await page.evaluate(() => [...document.styleSheets].some((sheet) => (sheet.href || "").endsWith("/app-kit/ak-view-transitions.css")));
      assert.ok(!linked, `${route} does not link ak-view-transitions.css`);
    }
  } finally {
    await page.context().close();
  }
});
