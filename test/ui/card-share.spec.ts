import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
/** Screenshots of the card Share button. Inside the worktree and gitignored. */
const SHOT_DIR = path.resolve(process.env.CARD_SHARE_SHOT_DIR || "test/ui/screenshots/card-share");
const PLACE = "Boulderhalle Ostkreuz, Hauptstr. 12";

/**
 * Stubs for navigator.share and the clipboard. Modes live on window so a test can switch them:
 * __shareMode: "ok" | "abort" | "notallowed" | "none" (no navigator.share at all)
 * __clipMode: "ok" | "fail" (writeText rejects and the execCommand fallback fails too)
 * Each share call records the payload, whether it ran inside a click (window.event) and user activation.
 */
const STUBS = `(() => {
  window.__shareMode = "ok";
  window.__clipMode = "ok";
  window.__shares = [];
  window.__copied = [];
  window.__toasts = [];
  window.__fetches = [];
  const share = function (data) {
    window.__shares.push({
      data: JSON.parse(JSON.stringify(data)),
      inEvent: window.event ? window.event.type : null,
      active: navigator.userActivation ? navigator.userActivation.isActive : null,
    });
    if (window.__shareMode === "abort") return Promise.reject(new DOMException("Share canceled", "AbortError"));
    if (window.__shareMode === "notallowed") return Promise.reject(new DOMException("Not allowed", "NotAllowedError"));
    return Promise.resolve();
  };
  Object.defineProperty(Navigator.prototype, "share", {
    configurable: true,
    get() { return window.__shareMode === "none" ? undefined : share; },
  });
  Object.defineProperty(Navigator.prototype, "canShare", {
    configurable: true,
    get() { return window.__shareMode === "none" ? undefined : () => true; },
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        if (window.__clipMode === "fail") throw new DOMException("Denied", "NotAllowedError");
        window.__copied.push(text);
      },
    },
  });
  const exec = document.execCommand.bind(document);
  document.execCommand = (name, ...rest) => (window.__clipMode === "fail" && name === "copy" ? false : exec(name, ...rest));
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    window.__fetches.push({ url: String(input && input.url ? input.url : input), method: (init && init.method) || "GET" });
    return realFetch(input, init);
  };
  new MutationObserver(() => {
    for (const node of document.querySelectorAll(".toast")) {
      const text = node.textContent || "";
      if (window.__toasts.at(-1) !== text) window.__toasts.push(text);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
})();`;

const hangry = useHangry({ tz: TZ });
const { call } = hangry;

type Person = { token: string; user: { id: string; name: string } };

/** Hana hosts in Kreuzberg crew, Finn is a member there. */
async function people(circleName = "Kreuzberg crew") {
  const host: Person = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: circleName });
  const friend: Person = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
  return { host, friend, circle };
}

async function makePlan(token: string, body: Record<string, unknown>) {
  return (await call("POST", "/api/plans", token, { time: "18:30", ...body })).plan;
}

type Phone = { page: Page; errors: string[]; logs: string[] };

async function phone(token: string, width = 360, height = 640, circleId = ""): Promise<Phone> {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, timezoneId: TZ });
  await skipWhatsNew(context);
  await context.addInitScript(STUBS);
  await context.addInitScript(([value, circle]) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
    if (circle) localStorage.setItem("fn_circle", circle);
  }, [token, circleId] as const);
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await context.newPage();
  const errors: string[] = [];
  const logs: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => logs.push(message.text()));
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  return { page, errors, logs };
}

const planCard = (page: Page, note: string) => page.locator(".card-plan", { has: page.getByRole("heading", { name: note }) });
const win = <T>(page: Page, key: string) => page.evaluate((name) => (window as any)[name], key) as Promise<T>;
const setMode = (page: Page, share: string, clip = "ok") => page.evaluate(([s, c]) => {
  (window as any).__shareMode = s;
  (window as any).__clipMode = c;
}, [share, clip] as const);

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

/** Share and In sit on one row inside the card, both 44px+, label on one line, nothing scrolls sideways. */
async function checkLayout(page: Page, card: Locator, where: string) {
  const out = await card.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const problems: string[] = [];
    const share = node.querySelector(".card-share") as HTMLElement | null;
    const toggle = node.querySelector(".in-toggle") as HTMLElement | null;
    if (!share) return ["no share button"];
    const s = share.getBoundingClientRect();
    if (s.height < 44 || s.width < 44) problems.push(`share too small ${s.width}x${s.height}`);
    if (s.left < box.left - 0.5 || s.right > box.right + 0.5) problems.push(`share outside card ${s.left}-${s.right} vs ${box.left}-${box.right}`);
    const label = share.querySelector("span:not(.icon)") as HTMLElement | null;
    if (!label || label.getBoundingClientRect().height > 26) problems.push("label wraps");
    if (share.scrollWidth > share.clientWidth + 1) problems.push("label clipped");
    if (toggle) {
      const t = toggle.getBoundingClientRect();
      if (t.height < 44) problems.push(`toggle short ${t.height}`);
      if (Math.abs(t.top - s.top) > 1) problems.push("share and In are not on one row");
      if (t.right > s.left + 0.5) problems.push("share overlaps In");
      if (t.width < 100) problems.push(`In squeezed to ${t.width}`);
    }
    for (const other of node.querySelectorAll(".chat-row, .card-more")) {
      const r = other.getBoundingClientRect();
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5) problems.push(`outside ${other.className}`);
    }
    if (document.documentElement.scrollWidth > window.innerWidth) problems.push(`page scrolls sideways ${document.documentElement.scrollWidth}`);
    return problems;
  });
  assert.deepEqual(out, [], where);
}

/** No toast text and no console line ever carries the link or its id. */
async function noLinkLeak(phone: Phone, shareIds: string[]) {
  const toasts = await win<string[]>(phone.page, "__toasts");
  for (const text of [...toasts, ...phone.logs]) {
    assert.ok(!text.includes("/p/"), `link in ${text}`);
    for (const id of shareIds) if (id) assert.ok(!text.includes(id), `share id in ${text}`);
  }
}

/**
 * Brings the card's In + Share row into view for a screenshot. scrollIntoViewIfNeeded alone counts a
 * row hidden behind the fixed tab bar as visible, so the row is then centred in the viewport.
 */
async function showActions(card: Locator) {
  const row = card.locator(".card-cta");
  await row.scrollIntoViewIfNeeded();
  await row.evaluate((node) => node.scrollIntoView({ block: "center" }));
}

/** Where the first card's Share and In buttons sit on first load, against the viewport and the tab bar. */
async function foldReport(page: Page) {
  // A string, so tsx does not wrap the inner helper in __name (which the page does not have).
  return page.evaluate(`(() => {
    const card = document.querySelector(".cards > .card-plan");
    const tabTop = document.querySelector(".tabbar")?.getBoundingClientRect().top ?? window.innerHeight;
    function at(selector) {
      const node = card && card.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), inViewport: r.top >= 0 && r.bottom <= window.innerHeight, clearOfTabbar: r.bottom <= tabTop };
    }
    return { viewport: window.innerWidth + "x" + window.innerHeight, scrollY: window.scrollY, tabbarTop: Math.round(tabTop), share: at(".card-share"), inButton: at(".in-toggle") };
  })()`);
}

async function openMap(page: Page) {
  await page.locator(".tabbar").getByRole("button", { name: /^Map/ }).click();
  const pin = page.locator(".leaflet-marker-icon.pin").first();
  await pin.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await pin.click();
  const card = page.locator(".map-card");
  await card.waitFor();
  return card;
}

for (const [width, height] of SIZES) {
  test(`at ${width}x${height}: Share on the list and map card fits, labels itself and goes through the ready state`, { timeout: 120_000 }, async () => {
    const { host, friend } = await people(`Crew ${width}`);
    const note = `Bouldering at the big hall ${width}`;
    const plan = await makePlan(host.token, { note, place: PLACE, lat: 52.5, lng: 13.42, precise: true });
    const member = await phone(friend.token, width, height);
    const { page } = member;
    try {
      const card = planCard(page, note);
      const share = card.getByRole("button", { name: `Share ${note}`, exact: true });
      await share.waitFor();
      assert.equal((await share.innerText()).trim(), "Share");
      // Measured only, the layout is not changed for it.
      console.log(`fold ${width}x${height}: ${JSON.stringify(await foldReport(page))}`);
      await checkLayout(page, card, `list ${width}`);
      await showActions(card);
      await shot(page, "1-list-card");

      // Known link: one tap shares, no request first.
      await share.click();
      await page.waitForFunction(() => (window as any).__shares.length === 1);
      const [first] = await win<any[]>(page, "__shares");
      assert.equal(first.inEvent, "click");
      assert.equal(first.data.url, `${hangry.baseUrl}/p/${plan.shareId}`);

      // Map card: same button, same rules.
      const mapCard = await openMap(page);
      await mapCard.getByRole("button", { name: `Share ${note}`, exact: true }).waitFor();
      await checkLayout(page, mapCard, `map ${width}`);
      await shot(page, "2-map-card");
      await page.locator(".tabbar").getByRole("button", { name: /^Now/ }).click();

      // The host stops sharing, so the member's next tap has to make a new link first.
      await call("DELETE", `/api/plans/${plan.id}/share`, host.token);
      await page.reload();
      await share.waitFor();
      await share.click();
      const ready = card.getByRole("button", { name: `Send link for ${note}`, exact: true });
      await ready.waitFor();
      assert.equal((await ready.innerText()).trim(), "Send link");
      await page.locator(".toast", { hasText: "Link ready. Tap Send link." }).waitFor();
      await checkLayout(page, card, `ready ${width}`);
      await showActions(card);
      await shot(page, "3-ready-toast");
      // The reload cleared the recorded calls: the request alone opened no share sheet.
      assert.equal((await win<any[]>(page, "__shares")).length, 0, "no share sheet after the request");
      await ready.click();
      await page.waitForFunction(() => (window as any).__shares.length === 1);
      const second = (await win<any[]>(page, "__shares"))[0];
      assert.equal(second.inEvent, "click");
      assert.match(second.data.url, new RegExp(`^${hangry.baseUrl}/p/[A-Za-z0-9_-]{24}$`));
      assert.notEqual(second.data.url, first.data.url);
      await share.waitFor();

      // Copy toast, for the screenshot set.
      await setMode(page, "none");
      await share.click();
      await page.locator(".toast", { hasText: "Link copied" }).waitFor();
      await showActions(card);
      await shot(page, "4-copied-toast");
      await noLinkLeak(member, [plan.shareId, second.data.url.split("/p/")[1]]);
      assert.deepEqual(member.errors, []);
    } finally {
      await page.context().close();
    }
  });
}

test("a known link shares inside the tap with title, day and time only, and the tap opens nothing else", { timeout: 90_000 }, async () => {
  const { host, friend, circle } = await people();
  const plan = await makePlan(host.token, { note: "Bouldering", place: PLACE, lat: 52.52, lng: 13.405, precise: true });
  await call("PATCH", `/api/plans/${plan.id}`, host.token, { description: "Bring chalk, ask Finn for shoes" });
  const member = await phone(friend.token);
  const { page } = member;
  try {
    const card = planCard(page, "Bouldering");
    await card.getByRole("button", { name: "Share Bouldering", exact: true }).click();
    await page.waitForFunction(() => (window as any).__shares.length === 1);
    const [call1] = await win<any[]>(page, "__shares");
    assert.equal(call1.inEvent, "click", "navigator.share ran inside the click handler");
    assert.equal(call1.active, true, "user activation was still there");
    const posts = (await win<Array<{ url: string; method: string }>>(page, "__fetches")).filter((row) => row.url.includes("/share"));
    assert.deepEqual(posts, [], "no request before or after sharing");
    assert.deepEqual(Object.keys(call1.data).sort(), ["text", "title", "url"]);
    assert.equal(call1.data.title, "Bouldering");
    assert.match(call1.data.text, /^Bouldering, [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}( \d{4})? 18:30 on Hangry$/);
    assert.equal(call1.data.url, `${hangry.baseUrl}/p/${plan.shareId}`);
    const blob = JSON.stringify(call1.data);
    for (const leak of [PLACE, "Hauptstr", "52.52", "13.405", "Hana", "Finn", "chalk", circle.name, circle.inviteCode, plan.id]) {
      assert.ok(!blob.includes(leak), `payload has ${leak}`);
    }

    // The tap neither opened the details sheet nor the ⋯ menu.
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("dialog").count(), 0, "no sheet opened");
    assert.equal(await page.getByRole("menu").count(), 0, "no menu opened");
    assert.equal(await card.locator(".card-more").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".toast").count(), 0, "a finished share says nothing");
    await noLinkLeak(member, [plan.shareId]);
    assert.deepEqual(member.errors, []);
  } finally {
    await page.context().close();
  }
});

test("cancel is quiet; a share error copies; a failed copy asks to try again and the retry works", { timeout: 90_000 }, async () => {
  const { host, friend } = await people();
  const plan = await makePlan(host.token, { note: "Pizza night" });
  const member = await phone(friend.token);
  const { page } = member;
  try {
    const share = planCard(page, "Pizza night").locator(".card-share");
    await share.waitFor();

    // AbortError: the person closed the sheet. No toast, no copy, button unchanged.
    await setMode(page, "abort");
    await share.click();
    await page.waitForFunction(() => (window as any).__shares.length === 1);
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".toast").count(), 0);
    assert.deepEqual(await win(page, "__copied"), []);
    assert.equal((await share.innerText()).trim(), "Share");

    // NotAllowedError: fall back to copying the link.
    await setMode(page, "notallowed");
    await share.click();
    await page.locator(".toast", { hasText: "Link copied" }).waitFor();
    assert.deepEqual(await win(page, "__copied"), [`${hangry.baseUrl}/p/${plan.shareId}`]);

    // Share and copy both fail: an honest, retryable message, never the link.
    await setMode(page, "notallowed", "fail");
    await share.click();
    await page.locator(".toast", { hasText: "Couldn't share. Try again." }).waitFor();
    const retry = planCard(page, "Pizza night").getByRole("button", { name: "Copy link for Pizza night", exact: true });
    await retry.waitFor();
    await showActions(planCard(page, "Pizza night"));
    await shot(page, "5-copy-failed");
    await setMode(page, "notallowed", "ok");
    await retry.click();
    await page.locator(".toast", { hasText: "Link copied" }).waitFor();
    assert.equal((await win<string[]>(page, "__copied")).length, 2);
    await planCard(page, "Pizza night").getByRole("button", { name: "Share Pizza night", exact: true }).waitFor();
    await noLinkLeak(member, [plan.shareId]);
    assert.deepEqual(member.errors, []);
  } finally {
    await page.context().close();
  }
});

test("without navigator.share the button copies; a failed copy says so without the link", { timeout: 90_000 }, async () => {
  const { host, friend } = await people();
  const plan = await makePlan(host.token, { note: "Board games" });
  const member = await phone(friend.token);
  const { page } = member;
  try {
    await setMode(page, "none");
    const share = planCard(page, "Board games").getByRole("button", { name: "Share Board games", exact: true });
    await share.click();
    await page.locator(".toast", { hasText: "Link copied" }).waitFor();
    assert.deepEqual(await win(page, "__copied"), [`${hangry.baseUrl}/p/${plan.shareId}`]);
    assert.deepEqual(await win(page, "__shares"), []);

    await setMode(page, "none", "fail");
    await share.click();
    await page.locator(".toast", { hasText: "Couldn't share. Try again." }).waitFor();
    await noLinkLeak(member, [plan.shareId]);
    assert.deepEqual(member.errors, []);
  } finally {
    await page.context().close();
  }
});

test("a failed link request says so and the next tap works; a double tap makes one request", { timeout: 90_000 }, async () => {
  const { host, friend } = await people();
  const plan = await makePlan(host.token, { note: "Lake swim" });
  await call("DELETE", `/api/plans/${plan.id}/share`, host.token);
  const member = await phone(friend.token);
  const { page } = member;
  try {
    let posts = 0;
    let fail = true;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/plans/${plan.id}/share`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts += 1;
      if (fail) {
        fail = false;
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
      }
      await held;
      return route.fallback();
    });
    const card = planCard(page, "Lake swim");
    const share = card.locator(".card-share");
    await share.click();
    await page.locator(".toast", { hasText: "Couldn't get a link. Try again." }).waitFor();
    assert.equal((await share.innerText()).trim(), "Share");
    assert.equal(await share.getAttribute("aria-busy"), null);

    // Retry: busy while the request is held, a second tap does nothing.
    await share.click();
    await card.locator(".card-share[aria-busy='true']").waitFor();
    // aria-disabled, so Playwright needs force to tap it; the handler itself must ignore the tap.
    await card.locator(".card-share[aria-busy='true']").click({ force: true });
    await page.waitForTimeout(200);
    assert.equal(posts, 2, "the busy tap made no request");
    release();
    await card.getByRole("button", { name: "Send link for Lake swim", exact: true }).click();
    await page.waitForFunction(() => (window as any).__shares.length === 1);
    const [shared] = await win<any[]>(page, "__shares");
    assert.equal(shared.inEvent, "click");
    assert.equal(posts, 2);
    await noLinkLeak(member, [shared.data.url.split("/p/")[1]]);
    assert.deepEqual(member.errors, []);
  } finally {
    await page.context().close();
  }
});

test("an ended plan says so and the button stays usable", { timeout: 60_000 }, async () => {
  const { host, friend } = await people();
  const plan = await makePlan(host.token, { note: "Gone soon" });
  await call("DELETE", `/api/plans/${plan.id}/share`, host.token);
  const member = await phone(friend.token);
  const { page } = member;
  try {
    const share = planCard(page, "Gone soon").locator(".card-share");
    await share.waitFor();
    await call("DELETE", `/api/plans/${plan.id}`, host.token);
    await share.click();
    await page.locator(".toast", { hasText: "That plan has ended." }).waitFor();
    assert.deepEqual(await win(page, "__shares"), []);
    assert.deepEqual(member.errors, []);
  } finally {
    await page.context().close();
  }
});

test("who sees it: a member does; a free post, a stale past plan and a removed guest do not; ⋯ has no Share link", { timeout: 120_000 }, async () => {
  const { host, friend } = await people();
  await makePlan(host.token, { note: "Open plan" });
  const stale = await makePlan(host.token, { note: "Yesterday plan" });
  const kicked = await makePlan(host.token, { note: "Kicked plan" });
  await call("POST", `/api/plans/${kicked.id}/join`, friend.token, {});
  await call("DELETE", `/api/plans/${kicked.id}/people/${friend.user.id}`, host.token);
  await call("POST", "/api/socials", host.token, { note: "Free for coffee" });
  const member = await phone(friend.token);
  const { page } = member;
  try {
    // A copy left over from yesterday: the day has passed, so no Share.
    await page.route("**/api/plans", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      for (const row of body.plans) if (row.id === stale.id) row.forDate = "2020-01-01";
      return route.fulfill({ response, json: body });
    });
    await page.reload();
    await planCard(page, "Open plan").getByRole("button", { name: "Share Open plan", exact: true }).waitFor();
    await planCard(page, "Yesterday plan").waitFor();
    assert.equal(await planCard(page, "Yesterday plan").locator(".card-share").count(), 0, "past plan");
    const removed = planCard(page, "Kicked plan");
    await removed.locator(".removed-note").waitFor();
    assert.equal(await removed.locator(".card-share").count(), 0, "removed guest");
    const social = page.locator(".card-now", { hasText: "Free for coffee" });
    await social.waitFor();
    assert.equal(await social.locator(".card-share").count(), 0, "free post");
    assert.equal(await page.locator(".card-share").count(), 1);

    await planCard(page, "Open plan").locator(".card-more").click();
    const texts = await page.getByRole("menu").getByRole("menuitem").allInnerTexts();
    assert.equal(texts.includes("Share link"), false, JSON.stringify(texts));
    assert.ok(texts.includes("Remind friends"), JSON.stringify(texts));
    assert.deepEqual(member.errors, []);
  } finally {
    await page.context().close();
  }
});

test("a host in two circles keeps Share with other circles in ⋯, apart from the card Share", { timeout: 90_000 }, async () => {
  const { host, circle } = await people("Friends");
  await call("POST", "/api/circles", host.token, { name: "Climbing" });
  await call("POST", `/api/plans?circle=${circle.id}`, host.token, { note: "Crag day", time: "10:00" });
  const owner = await phone(host.token, 360, 640, circle.id);
  const { page } = owner;
  try {
    const card = planCard(page, "Crag day");
    await card.getByRole("button", { name: "Share Crag day", exact: true }).waitFor();
    await card.locator(".card-more").click();
    const texts = await page.getByRole("menu").getByRole("menuitem").allInnerTexts();
    assert.equal(texts[0], "Share with other circles", JSON.stringify(texts));
    assert.equal(texts.includes("Share link"), false, JSON.stringify(texts));
    await page.getByRole("menuitem", { name: "Share with other circles" }).click();
    await page.getByRole("dialog", { name: "Share with other circles" }).waitFor();
    assert.deepEqual(await win(page, "__shares"), [], "the internal share never calls the native sheet");
    assert.deepEqual(owner.errors, []);
  } finally {
    await page.context().close();
  }
});
