import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { devices, type BrowserContext, type Page } from "playwright-core";
import type { GiphyFetch } from "../../src/chat/giphy.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { dismissPaymentReminder, openEventsMap, openYou, openYouSection, testEmail, useHangry } from "./harness.js";
import { FIELD_REVEAL_MS } from "../../public/js/keyboard.js";

// The iOS Safari set: WebKit with the iPhone 13 device, run only by the iphone-webkit project (playwright.config.ts).
// It proves the F1 to F5 fixes in a real WebKit: form fields never drop under 16px (iOS zooms the page on focus
// otherwise), the safe-area rules are wired, nothing scrolls sideways, and a sheet stays usable when the
// keyboard shrinks the viewport. Fake people only. Screenshots go to test/ui/screenshots/ios-safari (gitignored).
const TAG = { tag: "@ios-safari" };
const shotsDir = path.resolve("test/ui/screenshots/ios-safari");

const fakeGiphy: GiphyFetch = async (url) => {
  const q = new URL(url).searchParams.get("q");
  const names = q ? [`${q} one`, `${q} two`] : ["Trending one", "Trending two", "Trending three"];
  const data = names.map((title, index) => {
    const id = `${q ? "s" : "t"}${index}`;
    const image = (file: string, width: number, height: number) => ({ url: `https://media${index}.giphy.com/media/${id}/${file}`, width: String(width), height: String(height) });
    return { id, title, images: { fixed_width: image("200w.gif", 200, 150), fixed_width_small: image("100w.gif", 100, 75) } };
  });
  return { ok: true, status: 200, json: async () => ({ data }) };
};

const hangry = useHangry({ tz: "UTC", env: { GIPHY_API_KEY: "test-giphy-key" }, giphyFetch: fakeGiphy });

const GIF_IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150"><rect width="200" height="150" fill="#ff4d8d"/><circle cx="100" cy="75" r="40" fill="#fff"/></svg>';

type Seed = { host: { token: string }; friend: { token: string }; inviteCode: string };
let seeded: Promise<Seed> | undefined;

/** Alex hosts Friends with a Ramen social (Bea is in, and has written) and a Pizza night plan tomorrow with a pin. */
function seed(): Promise<Seed> {
  seeded ??= (async () => {
    const post = (pathname: string, body: unknown, token?: string) => hangry.call("POST", pathname, token, body);
    const host = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
    const { circle } = await post("/api/circles", { name: "Friends" }, host.token);
    const friend = await post("/api/auth/start", { email: testEmail(), name: "Bea", code: circle.inviteCode });
    hangry.confirmEmails();
    const social = await post("/api/socials", { note: "Ramen" }, host.token);
    await post(`/api/socials/${social.social.id}/reply`, { reply: "in" }, friend.token);
    await post(`/api/socials/${social.social.id}/chat`, { text: "Who is bringing the party hats?" }, friend.token);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const plan = await post("/api/plans", { note: "Pizza night", date: tomorrow, time: "19:00", place: "Schlossplatz", lat: 48.7784, lng: 9.18, precise: true }, host.token);
    await post(`/api/plans/${plan.plan.id}/reply`, { reply: "in" }, friend.token);
    return { host, friend, inviteCode: circle.inviteCode as string };
  })();
  return seeded;
}

async function phone(token?: string): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await hangry.browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "block" });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    if (value) {
      localStorage.setItem("fn_token", value);
      localStorage.setItem("fn_installed", "1");
    }
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token ?? "");
  // Map tiles and GIF images never reach the network.
  await context.route(/arcgisonline|tile\.openstreetmap|basemaps\.cartocdn|protomaps/, (route) => route.fulfill({ status: 204, body: "" }));
  await context.route(/^https:\/\/(media\d*|i)\.giphy\.com\//, (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: GIF_IMAGE }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return { context, page, errors };
}

/** Signed in, past the install sheet and the payment reminder. */
async function signedIn(token: string) {
  const app = await phone(token);
  await app.page.goto(hangry.baseUrl);
  await app.page.locator("nav.tabbar").waitFor();
  const later = app.page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await dismissPaymentReminder(app.page, 800);
  return app;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(shotsDir, { recursive: true });
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished.catch(() => null)),
  ).then(() => undefined));
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

/** The page and body must not scroll sideways. */
async function noSidewaysScroll(page: Page, label: string) {
  const over = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  assert.ok(over.doc <= 1 && over.body <= 1, `${label}: scrolls sideways ${JSON.stringify(over)}`);
}

/**
 * Every visible text-like field under scope: its computed font size must be 16px or more, or iOS zooms the page on focus.
 * Returns how many fields it looked at, so a spec can tell "all fine" from "found nothing".
 */
async function fieldsAre16(page: Page, scope: string, label: string): Promise<number> {
  const found = await page.evaluate((root) => {
    const skip = new Set(["hidden", "checkbox", "radio", "file", "range", "button", "submit", "reset", "image", "color"]);
    const nodes = Array.from(document.querySelectorAll(`${root} input, ${root} textarea, ${root} select`));
    const seen: string[] = [];
    const small: string[] = [];
    for (const node of nodes) {
      const field = node as HTMLInputElement;
      if (node.tagName === "INPUT" && skip.has(field.type)) continue;
      if (node.closest(".visually-hidden, .copy-buffer, [aria-hidden='true']")) continue;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden") continue;
      const name = `${node.tagName.toLowerCase()}${field.type && node.tagName === "INPUT" ? `[${field.type}]` : ""}${node.id ? `#${node.id}` : ""}`;
      seen.push(name);
      if (parseFloat(style.fontSize) < 16) small.push(`${name} ${style.fontSize}`);
    }
    return { seen, small };
  }, scope);
  assert.deepEqual(found.small, [], `${label}: fields under 16px`);
  return found.seen.length;
}

type CssRule = { selector: string; css: string; media: string };

/** Every style rule of every stylesheet, with the media condition it sits in. */
async function styleRules(page: Page): Promise<CssRule[]> {
  return page.evaluate(() => {
    const out: Array<{ selector: string; css: string; media: string }> = [];
    const stack: Array<[CSSRuleList, string]> = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try { stack.push([sheet.cssRules, ""]); } catch { /* a cross-origin sheet */ }
    }
    while (stack.length) {
      const [rules, media] = stack.pop()!;
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) out.push({ selector: rule.selectorText, css: rule.cssText, media });
        else if (rule instanceof CSSMediaRule) stack.push([rule.cssRules, `${media} ${rule.media.mediaText}`.trim()]);
        else if ("cssRules" in rule) stack.push([(rule as CSSGroupingRule).cssRules, media]);
      }
    }
    return out;
  });
}

const selects = (rules: CssRule[], selector: string) => rules.filter((rule) => rule.selector.split(",").some((part) => part.trim() === selector));

test("iOS Safari: head, safe-area rules, tap flash, hover rules and a bare date field", TAG, async () => {
  const { inviteCode } = await seed();
  const { context, page, errors } = await phone();
  try {
    await page.goto(`${hangry.baseUrl}/join/${inviteCode}`);
    await page.locator("#name").waitFor();

    // The page paints under the notch and home bar, and the rules that keep content clear of them exist.
    assert.match(await page.locator('meta[name="viewport"]').getAttribute("content") ?? "", /viewport-fit=cover/);
    const rules = await styleRules(page);
    for (const selector of [".tabbar", ".sheet", ".chat-compose", ".phone"]) {
      const withInset = selects(rules, selector).filter((rule) => /env\(\s*safe-area-inset-/.test(rule.css));
      assert.ok(withInset.length > 0, `${selector} has a rule that uses env(safe-area-inset-*)`);
    }

    // F1: no grey tap flash on links and buttons.
    assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("-webkit-tap-highlight-color")), /rgba\(0, 0, 0, 0\)|transparent/);

    // F4: hover styles only apply where hover exists, and a press still shows through :active.
    for (const selector of [".gate-about:hover", ".map-card-close:hover"]) {
      const hover = selects(rules, selector);
      assert.ok(hover.length > 0, `${selector} exists`);
      for (const rule of hover) assert.match(rule.media, /hover:\s*hover/, `${selector} sits inside (hover: hover)`);
    }
    for (const selector of [".gate-about:active", ".map-card-close:active"]) assert.ok(selects(rules, selector).length > 0, `${selector} is kept`);

    // F3: the sheet's extra area and long text box follow the visual viewport, not only the layout one.
    assert.ok(rules.some((rule) => rule.selector.split(",").some((part) => part.trim() === ".sheet-extra") && /--vv-height/.test(rule.css)), ".sheet-extra reads --vv-height");

    // F5: a bare date, time, text, email and url field (no sheet-control class) is still 16px.
    const bare = await page.evaluate(() => {
      const host = document.createElement("div");
      document.body.append(host);
      const sizes: Record<string, string> = {};
      for (const type of ["date", "time", "text", "email", "url"]) {
        const input = document.createElement("input");
        input.type = type;
        host.append(input);
        sizes[type] = getComputedStyle(input).fontSize;
      }
      host.remove();
      return sizes;
    });
    assert.deepEqual(bare, { date: "16px", time: "16px", text: "16px", email: "16px", url: "16px" });

    // F2: the welcome page can be added to the Home Screen like the app.
    const welcome = await (await fetch(`${hangry.baseUrl}/welcome`)).text();
    assert.match(welcome, /<meta name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(welcome, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
    assert.match(welcome, /<meta name="apple-mobile-web-app-title" content="Spontaco"/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("iOS Safari: welcome, invite gate and recovery form keep 16px fields and fit the width", TAG, async () => {
  const { inviteCode } = await seed();
  const { context, page, errors } = await phone();
  try {
    await page.goto(`${hangry.baseUrl}/welcome`);
    await page.locator("h1").first().waitFor();
    await noSidewaysScroll(page, "welcome");

    await page.goto(`${hangry.baseUrl}/join/${inviteCode}`);
    await page.locator("#name").waitFor();
    await page.locator("#email").waitFor();
    assert.ok(await fieldsAre16(page, ".gate", "gate") >= 2, "the gate has a name and an email field");
    assert.equal(await page.locator("#email").getAttribute("type"), "email");
    await noSidewaysScroll(page, "gate");
    await shot(page, "gate");

    await page.getByRole("button", { name: "I already have an account" }).click();
    await page.locator("#recover-code").waitFor();
    assert.ok(await fieldsAre16(page, ".gate", "recovery gate") >= 1, "the recovery form has a code field");
    await noSidewaysScroll(page, "recovery gate");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("iOS Safari: Now, compact list and map fit the width", TAG, async () => {
  const { host } = await seed();
  const { context, page, errors } = await signedIn(host.token);
  try {
    await page.locator("article", { has: page.locator("h3", { hasText: "Ramen" }) }).waitFor();
    await noSidewaysScroll(page, "Now cards");
    await shot(page, "now");

    await page.getByRole("group", { name: "Event list" }).getByRole("button", { name: "Compact" }).click();
    await page.locator(".compact-row").first().waitFor();
    await noSidewaysScroll(page, "compact");
    await page.getByRole("group", { name: "Event list" }).getByRole("button", { name: "Cards" }).click();

    await openEventsMap(page);
    const pin = page.locator(".leaflet-marker-icon.pin-plan").first();
    await pin.waitFor({ timeout: 10_000 });
    await noSidewaysScroll(page, "map");
    await pin.click();
    await page.locator(".map-card").waitFor();
    await noSidewaysScroll(page, "map card");
    await shot(page, "map-card");
    await page.locator(".map-card-close").click();
    await page.locator(".map-card").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("iOS Safari: the plan sheet keeps 16px fields, and its dock and fields stay in view when the viewport shrinks", TAG, async () => {
  const { host } = await seed();
  const { context, page, errors } = await signedIn(host.token);
  try {
    await page.getByRole("button", { name: "Let friends know you're free now" }).click();
    await page.locator("form.sheet").waitFor();
    await noSidewaysScroll(page, "create sheet");
    await page.locator("form.sheet").getByRole("button", { name: "Plan for another day" }).click();
    await page.locator("#plan-date").waitFor();
    await page.locator("#plan-time").waitFor();
    await page.locator("#sheet-note").waitFor();

    const count = await fieldsAre16(page, ".sheet", "plan sheet");
    assert.ok(count >= 3, `the plan sheet has its note, date and time fields (${count})`);
    for (const id of ["#plan-date", "#plan-time"]) {
      assert.equal(await page.locator(id).evaluate((node) => getComputedStyle(node).fontSize), "16px", id);
    }
    await noSidewaysScroll(page, "plan sheet");
    await shot(page, "plan-sheet");

    // F3: when the visual viewport is short, a long text box in a sheet caps at 40% of it, not 40% of the layout viewport.
    // The plan sheet's own description box is the unlimited .sheet-textarea variant, so measure a plain
    // textarea.sheet-control placed in the open sheet, then take it out again.
    const capped = await page.evaluate(() => {
      const sheet = document.querySelector(".sheet");
      if (!sheet) return null;
      const area = document.createElement("textarea");
      area.className = "sheet-control";
      sheet.append(area);
      const root = document.documentElement;
      const before = root.style.getPropertyValue("--vv-height");
      root.style.setProperty("--vv-height", "300px");
      const max = getComputedStyle(area).maxHeight;
      if (before) root.style.setProperty("--vv-height", before);
      else root.style.removeProperty("--vv-height");
      area.remove();
      return max;
    });
    assert.ok(capped !== null, "the plan sheet is open");
    assert.ok(Math.abs(parseFloat(capped) - 120) <= 1, `max-height follows --vv-height: ${capped}`);

    // The keyboard-ish case: a field is focused, then the layout viewport loses 45% of its height.
    await page.locator("#sheet-note").focus();
    const full = page.viewportSize()!;
    await page.setViewportSize({ width: full.width, height: Math.round(full.height * 0.55) });
    await page.evaluate(() => {
      window.visualViewport?.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(FIELD_REVEAL_MS + 250);

    const placed = await page.evaluate(() => {
      const view = window.visualViewport?.height ?? window.innerHeight;
      const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const dock = rect(".sheet-dock");
      const head = rect(".sheet-head");
      const note = document.activeElement?.getBoundingClientRect();
      const scroll = document.querySelector(".sheet-scroll");
      // Bring each date and time field into the scroll area the way a person would, without focusing it (no native picker).
      const fields: Record<string, { top: number; bottom: number } | null> = {};
      for (const id of ["plan-date", "plan-time"]) {
        const node = document.getElementById(id);
        node?.scrollIntoView({ block: "nearest" });
        const box = node?.getBoundingClientRect();
        fields[id] = box ? { top: box.top, bottom: box.bottom } : null;
      }
      const dockNow = rect(".sheet-dock");
      return {
        view,
        focusedId: document.activeElement?.id ?? "",
        dock: dock ? { top: dock.top, bottom: dock.bottom } : null,
        dockNow: dockNow ? { top: dockNow.top, bottom: dockNow.bottom } : null,
        headBottom: head?.bottom ?? 0,
        note: note ? { top: note.top, bottom: note.bottom } : null,
        hasScroll: Boolean(scroll),
        fields,
      };
    });
    const info = JSON.stringify(placed);
    assert.ok(placed.view <= full.height * 0.55 + 1, `the viewport shrank ${info}`);
    assert.equal(placed.focusedId, "sheet-note", info);
    assert.ok(placed.hasScroll && placed.dock, info);
    assert.ok(placed.dock.top >= -1 && placed.dock.bottom <= placed.view + 1, `the dock is in view ${info}`);
    assert.ok(placed.note && placed.note.top >= -1 && placed.note.bottom <= placed.view + 1, `the focused field is in view ${info}`);
    for (const id of ["plan-date", "plan-time"]) {
      const box = placed.fields[id];
      assert.ok(box, `${id} exists ${info}`);
      assert.ok(box.top >= placed.headBottom - 1, `${id} sits below the sheet head ${info}`);
      assert.ok(box.bottom <= placed.dockNow!.top + 1, `${id} sits above the dock ${info}`);
    }
    await shot(page, "sheet-shrunken-viewport");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("iOS Safari: the event chat composer and the GIF search keep 16px fields", TAG, async () => {
  const { host } = await seed();
  const { context, page, errors } = await signedIn(host.token);
  try {
    await page.locator("article", { has: page.locator("h3", { hasText: "Ramen" }) }).locator(".chat-row").click();
    await page.locator(".chat-screen").waitFor();
    await page.locator(".chat-msg", { hasText: "party hats" }).waitFor();
    await page.locator("#chat-input").waitFor();
    assert.ok(await fieldsAre16(page, ".chat-compose", "chat composer") >= 1, "the composer has its text box");
    assert.equal(await page.locator("#chat-input").evaluate((node) => getComputedStyle(node).fontSize), "16px");
    await noSidewaysScroll(page, "event chat");
    await shot(page, "event-chat");

    await page.getByRole("button", { name: "Choose a GIF" }).click();
    const sheet = page.getByRole("dialog", { name: "GIFs" });
    await sheet.waitFor();
    const search = sheet.getByRole("searchbox", { name: "Search GIFs" });
    await search.waitFor();
    assert.equal(await search.getAttribute("type"), "search");
    assert.ok(await fieldsAre16(page, ".sheet", "GIF sheet") >= 1, "the GIF sheet has its search field");
    assert.equal(await search.evaluate((node) => getComputedStyle(node).fontSize), "16px");
    await noSidewaysScroll(page, "GIF sheet");
    await shot(page, "gif-sheet");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("iOS Safari: You and availability keep 16px fields, date and time included, and fit the width", TAG, async () => {
  const { host } = await seed();
  const { context, page, errors } = await signedIn(host.token);
  try {
    await openYou(page);
    await noSidewaysScroll(page, "You");

    await openYouSection(page, "Availability & calendar");
    await noSidewaysScroll(page, "availability");
    await page.getByRole("button", { name: /Set Away/ }).click();
    await page.locator("#status-until").waitFor();
    assert.equal(await page.locator("#status-until").getAttribute("type"), "date");
    assert.ok(await fieldsAre16(page, ".status-editor", "away editor") >= 3, "note, place and a date field");
    assert.equal(await page.locator("#status-until").evaluate((node) => getComputedStyle(node).fontSize), "16px");
    await noSidewaysScroll(page, "away editor");
    await shot(page, "availability-away");

    await page.locator(".status-editor .segment button", { hasText: "Busy" }).click();
    await page.locator("#status-until-time").waitFor();
    assert.ok(await fieldsAre16(page, ".status-editor", "busy editor") >= 3, "note, place and a time field");
    await noSidewaysScroll(page, "busy editor");

    // The editor holds the page; start over to reach the weekly hours form.
    await page.reload();
    await page.locator("nav.tabbar").waitFor();
    await dismissPaymentReminder(page, 800);
    await openYouSection(page, "Availability & calendar");
    await page.getByRole("button", { name: /weekly hours/ }).first().click();
    await page.locator(".hours-start").first().waitFor();
    assert.ok(await fieldsAre16(page, ".page", "weekly hours") >= 2, "a from and a to time field");
    await noSidewaysScroll(page, "weekly hours");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
