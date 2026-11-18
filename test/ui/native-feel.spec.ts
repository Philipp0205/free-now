import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page, Route } from "playwright-core";
import { UA, useHangry, testEmail } from "./harness.js";
import { skipWhatsNew } from "./whats-new-seen.js";

// Fake people and plans only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/native-feel");
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
  for (const [index, note] of ["Sushi night", "Board games", "Morning run", "Rooftop drinks", "Museum trip", "Picnic"].entries()) {
    await hangry.call("POST", "/api/plans", host.token, { note, date: tomorrow(), time: `1${index}:30` });
  }
  return host;
}

async function phone(token: string, width: number, height: number, reducedMotion: "reduce" | "no-preference" = "no-preference") {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, reducedMotion, colorScheme: "dark" });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
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

/** Alpha of a computed rgb()/rgba() colour. */
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

test("html wears ak-native and ak-no-bounce, the kit files load, and inputs stay selectable", { timeout: 120_000 }, async () => {
  const host = await seed();
  for (const [width, height] of SIZES) {
    const page = await phone(host.token, width, height);
    try {
      const root = await page.evaluate(() => ({
        classes: [...document.documentElement.classList],
        overscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
        bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
        scroll: typeof (window as any).AppKit?.scroll?.toTop,
        sheets: [...document.styleSheets].map((sheet) => sheet.href || "").filter((href) => href.includes("/app-kit/")),
        scripts: [...document.scripts].map((script) => script.src).filter((src) => src.includes("/app-kit/")),
      }));
      assert.ok(root.classes.includes("ak-native"), `${width}: ak-native`);
      assert.ok(root.classes.includes("ak-no-bounce"), `${width}: ak-no-bounce`);
      assert.equal(root.overscroll, "none");
      assert.equal(root.bodyOverscroll, "none");
      assert.equal(root.scroll, "function", "AppKit.scroll.toTop comes from ak-native.js");
      assert.ok(root.sheets.some((href) => href.endsWith("/app-kit/ak-native.css")), "ak-native.css is linked");
      const sheetOrder = root.sheets.map((href) => href.split("/").pop());
      assert.ok(sheetOrder.indexOf("ak-native.css") > sheetOrder.indexOf("ak-components.css"), "ak-native.css comes after ak-components.css");
      assert.ok(root.scripts.some((src) => src.endsWith("/app-kit/ak-native.js")), "ak-native.js is loaded");
      // The kit does not load what is out of scope. ak-transition.js came with part B.
      assert.ok(!root.scripts.some((src) => /ak-(swr|sw)/.test(src)));

      // Chrome is not selectable, inputs and text are.
      await tab(page, "Circle").click();
      await page.getByRole("heading", { name: "Circle", exact: true, level: 1 }).waitFor();
      const input = page.locator("input").first();
      await input.waitFor();
      const select = await page.evaluate(() => {
        const field = document.querySelector("input") as HTMLElement;
        const button = document.querySelector("button.btn") as HTMLElement;
        const text = document.querySelector(".panel .help") as HTMLElement;
        return {
          input: getComputedStyle(field).userSelect,
          text: getComputedStyle(text).userSelect,
          button: getComputedStyle(button).userSelect,
          tabbar: getComputedStyle(document.querySelector(".tabbar .tab")!).userSelect,
        };
      });
      assert.notEqual(select.input, "none", `${width}: input is selectable`);
      assert.notEqual(select.text, "none", `${width}: text is selectable`);
      assert.equal(select.button, "none");
      assert.equal(select.tabbar, "none");
      await input.fill("Native crew 2");
      assert.equal(await input.inputValue(), "Native crew 2");
    } finally {
      await page.context().close();
    }
  }
});

test("the tab bar is dark glass whatever the OS scheme, and the page scrolls under it", { timeout: 120_000 }, async () => {
  const host = await seed();
  for (const [width, height] of SIZES) {
    const page = await phone(host.token, width, height);
    try {
      await page.locator(".card-plan").first().waitFor();
      await makeTall(page);
      for (const scheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const bar = await page.locator(".tabbar").evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            backdrop: style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter"),
            background: style.backgroundColor,
            border: style.borderTopColor,
            position: style.position,
          };
        });
        assert.match(bar.backdrop, /blur/, `${width} ${scheme}: blur, got ${JSON.stringify(bar)}`);
        assert.match(bar.backdrop, /saturate/, `${width} ${scheme}: saturate`);
        assert.ok(alpha(bar.background) < 1 && alpha(bar.background) > 0, `${width} ${scheme}: translucent, got ${bar.background}`);
        assert.ok(alpha(bar.border) > 0, `${width} ${scheme}: hairline is visible`);
        assert.equal(bar.position, "fixed");
        // Hangry is always dark: a light OS setting gets the same dark bar.
        const [r] = /\d+/.exec(bar.background)!.map(Number);
        assert.ok(r < 50, `${width} ${scheme}: bar colour ${bar.background}`);
        // The current tab stays readable on the bar.
        const current = await page.locator(".tabbar .tab[aria-current='page']").evaluate((node) => getComputedStyle(node).color);
        assert.ok(Number(/\d+/.exec(current)![0]) > 200, `${width} ${scheme}: current tab colour ${current}`);

        // Content really sits under the bar: scrolled down, the last card reaches behind it.
        await page.evaluate(() => window.scrollTo(0, 400));
        await page.waitForFunction(() => window.scrollY > 100);
        if (width === 360 || width === 390) await shot(page, `tabbar-${scheme}`);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page.emulateMedia({ colorScheme: "dark" });
    } finally {
      await page.context().close();
    }
  }
});

test("tapping the current tab scrolls that page to the top; another tab still switches", { timeout: 180_000 }, async () => {
  const host = await seed();
  for (const [width, height] of SIZES) {
    const page = await phone(host.token, width, height);
    try {
      await page.locator(".card-plan").first().waitFor();
      await makeTall(page);
      const scrollY = () => page.evaluate(() => window.scrollY);
      const down = async () => {
        await page.evaluate(() => window.scrollTo(0, 700));
        await page.waitForFunction(() => window.scrollY > 300);
      };

      for (const name of ["Now", "Circle", "You"]) {
        if (name !== "Now") {
          await tab(page, name).tap();
          await page.locator(`nav.tabbar .tab[aria-current='page']`).filter({ hasText: name }).waitFor();
        }
        await down();
        if (width === 360 && name === "Now") await shot(page, "retap-before");
        await tab(page, name).tap();
        await page.waitForFunction(() => window.scrollY === 0, undefined, { timeout: 5000 });
        assert.equal(await scrollY(), 0, `${width} ${name}: back at the top`);
        assert.equal(await tab(page, name).getAttribute("aria-current"), "page", `${width} ${name}: still the current tab`);
        if (width === 360 && name === "Now") await shot(page, "retap-after");
      }

      // A different tab behaves as before: it switches the page.
      await tab(page, "Now").tap();
      await page.locator(".card-plan").first().waitFor();
      await down();
      await tab(page, "Events").tap();
      await page.getByRole("heading", { name: "Events", exact: true, level: 1 }).waitFor();
      assert.equal(await tab(page, "Events").getAttribute("aria-current"), "page");
      assert.equal(await tab(page, "Now").getAttribute("aria-current"), null);

      // Chat is its own screen: it opens, it does not scroll the page.
      await tab(page, "Chat").tap();
      await page.locator(".chat-screen").waitFor();
    } finally {
      await page.context().close();
    }
  }
});

test("with reduced motion the re-tap jumps to the top at once", { timeout: 60_000 }, async () => {
  const host = await seed();
  const page = await phone(host.token, 360, 640, "reduce");
  try {
    await page.locator(".card-plan").first().waitFor();
    await makeTall(page);
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForFunction(() => window.scrollY > 300);
    await tab(page, "Now").tap();
    await page.waitForFunction(() => window.scrollY === 0, undefined, { timeout: 2000 });
  } finally {
    await page.context().close();
  }
});

/** Hold every request to a path until release() is called. */
function hold(page: Page, pattern: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let seen = 0;
  const ready = page.route(pattern, async (route: Route) => {
    seen += 1;
    await gate;
    await route.continue();
  });
  return { ready, release: () => release(), seen: () => seen };
}

test("the Events calendar shows skeletons while the month loads, then the day list", { timeout: 120_000 }, async () => {
  const host = await seed();
  for (const [width, height] of SIZES) {
    const page = await phone(host.token, width, height);
    try {
      await page.locator(".card-plan").first().waitFor();
      const month = hold(page, "**/api/calendar-month?**");
      await month.ready;
      await tab(page, "Events").tap();
      const loading = page.locator(".cal-below [aria-busy='true']");
      await loading.waitFor();
      const info = await loading.evaluate((node) => ({
        skeletons: node.querySelectorAll(".ak-skeleton").length,
        hidden: [...node.querySelectorAll(".ak-skeleton")].every((item) => item.getAttribute("aria-hidden") === "true"),
        circles: node.querySelectorAll(".ak-skeleton-circle").length,
        lines: node.querySelectorAll(".ak-skeleton-line").length,
        short: node.querySelectorAll(".ak-skeleton-short").length,
        text: (node.textContent || "").trim(),
        overflow: node.scrollWidth > node.clientWidth,
      }));
      assert.ok(info.skeletons >= 6, `${width}: skeleton rows`);
      assert.ok(info.hidden, "every skeleton is aria-hidden");
      assert.ok(info.circles >= 3 && info.lines >= 6 && info.short >= 3, "avatar circle and two lines per row");
      assert.equal(info.text, "Loading", "screen readers still hear Loading");
      assert.ok(!info.overflow, `${width}: skeleton fits`);
      assert.equal(await page.locator(".cal-below", { hasText: "Loading…" }).count(), 0, "the plain Loading… text is gone");
      assert.equal(await page.locator(".cal-day").count(), 0, "no day list yet");
      assert.ok(month.seen() >= 1, "the month request is pending");
      if (width === 360 || width === 390) {
        await loading.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await page.evaluate(() => window.scrollTo(0, 400));
        await shot(page, "events-skeleton");
      }

      month.release();
      await page.locator(".cal-below .cal-day, .cal-below .cal-empty").first().waitFor();
      assert.equal(await page.locator(".cal-below .ak-skeleton").count(), 0, "skeletons are gone");
      assert.equal(await page.locator(".cal-below [aria-busy='true']").count(), 0);
      if (width === 360 || width === 390) await shot(page, "events-loaded");
    } finally {
      await page.context().close();
    }
  }
});

test("Past events shows skeletons while the list loads", { timeout: 120_000 }, async () => {
  const host = await seed();
  for (const [width, height] of SIZES) {
    const page = await phone(host.token, width, height);
    try {
      await page.locator(".card-plan").first().waitFor();
      const past = hold(page, "**/api/past");
      await past.ready;
      await page.getByRole("button", { name: "Past events", exact: true }).tap();
      const loading = page.locator(".past-screen [aria-busy='true']");
      await loading.waitFor();
      const info = await loading.evaluate((node) => ({
        skeletons: node.querySelectorAll(".ak-skeleton").length,
        hidden: [...node.querySelectorAll(".ak-skeleton")].every((item) => item.getAttribute("aria-hidden") === "true"),
        text: (node.textContent || "").trim(),
      }));
      assert.ok(info.skeletons >= 8, `${width}: skeleton rows`);
      assert.ok(info.hidden);
      assert.equal(info.text, "Loading");
      assert.equal(await page.locator(".past-screen", { hasText: "Loading…" }).count(), 0);
      if (width === 360 || width === 390) await shot(page, "past-skeleton");

      past.release();
      await page.locator(".past-screen .past-empty").waitFor();
      assert.equal(await page.locator(".past-screen .ak-skeleton").count(), 0);
      assert.equal(await page.locator(".past-screen [aria-busy='true']").count(), 0);
    } finally {
      await page.context().close();
    }
  }
});

test("the Circle tab has no loading state: members arrive with the page", { timeout: 60_000 }, async () => {
  const host = await seed();
  const page = await phone(host.token, 360, 640);
  try {
    await tab(page, "Circle").tap();
    await page.getByRole("heading", { name: "Members" }).waitFor();
    // The list is drawn at once, from /api/me, with no placeholder.
    assert.equal(await page.locator(".page .ak-skeleton").count(), 0);
    assert.equal(await page.locator(".member-row").count(), 4);
    await shot(page, "circle");
  } finally {
    await page.context().close();
  }
});
