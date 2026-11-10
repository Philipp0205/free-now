import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, useHangry } from "./harness.js";

const PLACE = "Secret Garden Bar";

/** No navigator.share, and a clipboard that records what was copied. */
const CLIPBOARD = `(() => {
  try { delete Navigator.prototype.share; } catch {}
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  window.__copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { window.__copied.push(text); } },
  });
})();`;

const hangry = useHangry();
const { call } = hangry;

/** A host with a circle, a friend in it, and an outsider in a circle of their own. */
async function people(circleName = "Kreuzberg crew") {
  const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: circleName });
  const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
  const outsider = await call("POST", "/api/auth/start", undefined, { name: "Sam" });
  await call("POST", "/api/circles", outsider.token, { name: "Elsewhere" });
  return { host, friend, outsider, circle };
}

async function makePlan(token: string, body: Record<string, unknown>) {
  return (await call("POST", "/api/plans", token, { time: "19:30", ...body })).plan;
}

async function phone(width = 360, height = 640) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: CHROME_UA });
  await context.addInitScript(CLIPBOARD);
  await skipWhatsNew(context);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function asUser(page: Page, token: string | null, circleId = "") {
  await page.goto(`${hangry.baseUrl}/robots.txt`);
  await page.evaluate(([value, circle]) => {
    localStorage.clear();
    if (value) localStorage.setItem("fn_token", value);
    if (circle) localStorage.setItem("fn_circle", circle);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, [token, circleId] as const);
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function noSideScroll(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, `page scrolls sideways by ${wide}px`);
}

test("the host shares a plan, a friend opens the link on the map, an outsider sees only the preview", { timeout: 120_000 }, async () => {
  const { host, friend, outsider, circle } = await people();
  const plan = await makePlan(host.token, { note: "Rooftop drinks", place: PLACE, lat: 52.5, lng: 13.42, precise: true });

  const hostPage = await phone();
  const errors: string[] = [];
  hostPage.on("pageerror", (error) => errors.push(String(error)));
  try {
    await asUser(hostPage, host.token);
    await hostPage.goto(hangry.baseUrl);
    await dismiss(hostPage);
    const card = hostPage.locator(".card-plan", { has: hostPage.getByRole("heading", { name: "Rooftop drinks" }) });
    await card.getByRole("button", { name: "Share Rooftop drinks", exact: true }).click();
    await hostPage.locator(".toast", { hasText: "Link copied" }).waitFor();
    const copied = await hostPage.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
    assert.equal(copied.length, 1);
    assert.match(copied[0], new RegExp(`^${hangry.baseUrl}/p/[A-Za-z0-9_-]{24}$`));
    assert.ok(!copied[0].includes(plan.id));
    assert.deepEqual(errors, []);

    // The friend lands on the map with the plan card open, and the path is clean.
    const friendPage = await phone();
    try {
      await asUser(friendPage, friend.token);
      await friendPage.goto(copied[0]);
      await friendPage.locator(".map-card").getByText("Rooftop drinks").waitFor({ timeout: 10_000 });
      assert.equal(await friendPage.locator(".screen-title").innerText(), "Events");
      assert.equal(new URL(friendPage.url()).pathname, "/");
      await friendPage.locator(".map-card").getByRole("button", { name: /^More for / }).waitFor();
    } finally {
      await friendPage.context().close();
    }

    // Signed out or not in the circle: title, day and time only. No place, no people, no map.
    for (const [token, signedIn] of [[null, false], [outsider.token, true]] as const) {
      const visitor = await phone();
      try {
        await asUser(visitor, token);
        await visitor.goto(copied[0]);
        const preview = visitor.locator(".share-preview");
        await preview.getByRole("heading", { name: "Rooftop drinks" }).waitFor();
        const when = await preview.locator(".share-when").innerText();
        assert.match(when, /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}( \d{4})? · 19:30$/);
        assert.ok(!/Today|Tomorrow/.test(when));
        const text = await visitor.locator("body").innerText();
        for (const leak of [PLACE, "Hana", "Finn", "Chat", circle.name]) assert.ok(!text.includes(leak), `${leak} shown`);
        assert.equal(await visitor.locator(".leaflet-container, .map-card, .tabbar").count(), 0);
        if (signedIn) await visitor.getByRole("button", { name: "Open Hangry" }).waitFor();
        else await visitor.getByRole("button", { name: "Sign back in" }).waitFor();
      } finally {
        await visitor.context().close();
      }
    }

    // Ended: the same copy as an unknown link.
    await call("DELETE", `/api/plans/${plan.id}`, host.token);
    for (const link of [copied[0], `${hangry.baseUrl}/p/AAAAAAAAAAAAAAAAAAAAAAAA`]) {
      const visitor = await phone();
      try {
        await asUser(visitor, null);
        await visitor.goto(link);
        await visitor.getByRole("heading", { name: "This link no longer works" }).waitFor();
        assert.ok(!(await visitor.locator("body").innerText()).includes("Rooftop drinks"));
      } finally {
        await visitor.context().close();
      }
    }
  } finally {
    await hostPage.context().close();
  }
});

test("a plan with no place opens on its card at home", { timeout: 90_000 }, async () => {
  const { host, friend } = await people("Picnic people");
  const plan = await makePlan(host.token, { note: "Board games" });
  const friendPage = await phone();
  try {
    await asUser(friendPage, friend.token);
    await friendPage.goto(`${hangry.baseUrl}/p/${plan.shareId}`);
    await friendPage.locator(".card-plan.focused", { hasText: "Board games" }).waitFor({ timeout: 10_000 });
    assert.equal(await friendPage.locator(".screen-title").innerText(), "Now");
    assert.equal(new URL(friendPage.url()).pathname, "/");
  } finally {
    await friendPage.context().close();
  }
});

test("at 320x568 the chat row, I'm in toggle, Share and more menu fit the card", { timeout: 90_000 }, async () => {
  const { host } = await people("A circle with a rather long name");
  const plan = await makePlan(host.token, { note: "A plan with a fairly long title for a tiny phone", place: PLACE, lat: 52.5, lng: 13.42 });
  const page = await phone(320, 568);
  try {
    await asUser(page, host.token);
    await page.goto(hangry.baseUrl);
    await dismiss(page);
    const card = page.locator(".card-plan").first();
    await card.getByRole("button", { name: /^More for / }).waitFor();
    await card.getByRole("button", { name: "Chat" }).waitFor();
    await card.getByRole("button", { name: "In ✓" }).waitFor();
    await card.locator(".card-share").waitFor();
    const fit = await card.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const out: string[] = [];
      const controls = [...node.querySelectorAll(".chat-row, .in-toggle, .card-share, .card-more")].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width, cls: el.className };
      });
      for (const chip of controls) {
        if (chip.left < box.left - 0.5 || chip.right > box.right + 0.5) out.push(`outside card ${chip.cls}`);
        if (chip.height < 44 - 0.5) out.push(`too short ${chip.cls} ${chip.height}`);
      }
      return out;
    });
    assert.deepEqual(fit, []);
    await card.getByRole("button", { name: /^More for / }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const clipped = await menu.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    assert.ok(clipped.left >= -1, JSON.stringify(clipped));
    assert.ok(clipped.right <= clipped.vw + 1, JSON.stringify(clipped));
    assert.ok(clipped.bottom <= clipped.vh + 1, JSON.stringify(clipped));
    await noSideScroll(page);

    await asUser(page, null);
    await page.goto(`${hangry.baseUrl}/p/${plan.shareId}`);
    await page.locator(".share-preview h2").waitFor();
    await noSideScroll(page);
    const button = await page.getByRole("button", { name: "Sign back in" }).boundingBox();
    assert.ok(button && button.y + button.height <= 568 + 200, "sign-in button reachable");
  } finally {
    await page.context().close();
  }
});

test("the host stops sharing in Edit; the old link no longer works and Share makes a new one", { timeout: 120_000 }, async () => {
  const { host, friend } = await people("Revoke crew");
  const plan = await makePlan(host.token, { note: "Board games" });
  const oldLink = `${hangry.baseUrl}/p/${plan.shareId}`;

  // A friend in the circle gets Share on the card and ⋯ (Can't) but no host actions.
  const friendPage = await phone();
  try {
    await asUser(friendPage, friend.token);
    await friendPage.goto(hangry.baseUrl);
    await dismiss(friendPage);
    const card = friendPage.locator(".card-plan", { hasText: "Board games" });
    await card.waitFor();
    await card.getByRole("button", { name: "Share Board games", exact: true }).waitFor();
    await card.getByRole("button", { name: /^More for / }).click();
    const menu = friendPage.getByRole("menu");
    await menu.getByRole("menuitem", { name: "Can't make it" }).waitFor();
    assert.equal(await menu.getByRole("menuitem", { name: "Share link" }).count(), 0, "Share lives on the card now");
    for (const name of ["Edit", "End plan", "Stop sharing"]) {
      assert.equal(await menu.getByRole("menuitem", { name, exact: true }).count(), 0, `friend should not see ${name}`);
    }
  } finally {
    await friendPage.context().close();
  }

  const hostPage = await phone(320, 568);
  try {
    await asUser(hostPage, host.token);
    await hostPage.goto(hangry.baseUrl);
    await dismiss(hostPage);
    const card = hostPage.locator(".card-plan", { hasText: "Board games" });
    await card.getByRole("button", { name: /^More for / }).click();
    await hostPage.getByRole("menuitem", { name: "Edit" }).click();
    const stop = hostPage.getByRole("button", { name: "Stop sharing" });
    await stop.scrollIntoViewIfNeeded();
    await stop.click();
    await hostPage.locator(".toast", { hasText: "Link stopped" }).waitFor();
    await noSideScroll(hostPage);

    const visitor = await phone();
    try {
      await asUser(visitor, friend.token);
      await visitor.goto(oldLink);
      await visitor.getByRole("heading", { name: "This link no longer works" }).waitFor();
      assert.ok(!(await visitor.locator("body").innerText()).includes("Board games"));
    } finally {
      await visitor.context().close();
    }

    await hostPage.keyboard.press("Escape").catch(() => {});
    await hostPage.goto(hangry.baseUrl);
    await dismiss(hostPage);
    // No link now and no share sheet in this browser: the tap makes a new link and copies it.
    await hostPage.locator(".card-plan", { hasText: "Board games" }).getByRole("button", { name: "Share Board games", exact: true }).click();
    await hostPage.locator(".toast", { hasText: "Link copied" }).waitFor();
    const copied = await hostPage.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
    assert.match(copied.at(-1)!, new RegExp(`^${hangry.baseUrl}/p/[A-Za-z0-9_-]{24}$`));
    assert.notEqual(copied.at(-1), oldLink);
  } finally {
    await hostPage.context().close();
  }
});
