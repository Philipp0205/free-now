import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db.js";
import type { PushPayload, PushSender, PushSubscription } from "../../src/push/push.js";
import { skipWhatsNew } from "./whats-new-seen.js";

const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
/** Set to a folder to keep screenshots, for example BF_SHOT_DIR=/tmp/shots. */
const SHOT_DIR = process.env.BF_SHOT_DIR ? path.resolve(process.env.BF_SHOT_DIR) : "";
const SIZES = [[320, 568], [360, 640], [412, 915]] as const;

const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
const fakePush: PushSender = {
  async send(subscription: PushSubscription, payload: PushPayload) { sent.push({ endpoint: subscription.endpoint, payload }); },
};

let browser: Browser;
let baseUrl = "";
let closeServer: () => Promise<void> = async () => {};

test.beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hangry-button-feel-"));
  const dbPath = path.join(dir, "test.sqlite");
  const db = openDb(dbPath);
  const config = loadConfig({ PORT: "3000", DB_PATH: dbPath, APP_TZ: "UTC" });
  const server = http.createServer(createApp({ db, push: fakePush, config: { ...config, dbPath }, now: () => Date.now() }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
  catch { browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }); }
});

test.afterAll(async () => {
  await browser?.close();
  await closeServer();
});

async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

let circleCount = 0;
async function people(note: string) {
  circleCount += 1;
  const host = await call("POST", "/api/auth/start", undefined, { name: "Hana" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `Friends ${circleCount}` });
  const friend = await call("POST", "/api/auth/start", undefined, { name: "Finn", code: circle.inviteCode });
  const { plan } = await call("POST", "/api/plans", host.token, { note, time: "19:30" });
  return { host, friend, plan };
}

async function phone(token: string, { width = 360, height = 640, reducedMotion = "no-preference" as "reduce" | "no-preference" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, reducedMotion });
  await skipWhatsNew(context);
  // tsx keeps function names with a __name() helper that does not exist inside the page.
  await context.addInitScript("window.__name = (fn) => fn;");
  await context.addInitScript((value) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_token", value);
  }, token);
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context.newPage();
}

async function dismiss(page: Page) {
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
}

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}.png`) });
}

async function myReply(token: string, planId: number) {
  const { plans } = await call("GET", "/api/plans", token);
  const plan = plans.find((row: { id: number }) => row.id === planId);
  const me = await call("GET", "/api/me", token);
  return plan?.joined.find((person: { id: number }) => person.id === me.user.id)?.reply ?? null;
}

/** Same rule as inReply() in public/js/app.js. */
const IN_REPLIES = ["coming", "join", "in"];
const isIn = (reply: string | null) => reply !== null && IN_REPLIES.includes(reply);

/** Record every class the In toggle wears, across re-renders, so a one-frame pop is not missed. */
async function watchToggleClasses(page: Page) {
  await page.evaluate(() => {
    const seen = new Set<string>();
    (window as any).__toggleClasses = seen;
    const note = () => document.querySelectorAll(".in-toggle").forEach((node) => node.classList.forEach((name) => seen.add(name)));
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    note();
  });
}

/** Hold :active on the In toggle via DevTools, read its computed press style, then let go. */
async function pressedStyle(page: Page, selector: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  assert.ok(nodeId, `no node for ${selector}`);
  const read = () => page.evaluate((sel) => {
    const node = document.querySelector(sel) as HTMLElement;
    const style = getComputedStyle(node);
    return { transform: style.transform, filter: style.filter };
  }, selector);
  const resting = await read();
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active"] });
  // Let the 80ms transition land.
  await page.waitForTimeout(250);
  const pressed = await read();
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  await cdp.detach();
  return { resting, pressed };
}

test("I'm in toggles on with one tap and off with the next; the server keeps each state", { timeout: 120_000 }, async () => {
  const { friend, plan } = await people("Taco night");
  const page = await phone(friend.token);
  try {
    await page.goto(baseUrl);
    await dismiss(page);
    const card = page.locator(".card-plan", { hasText: "Taco night" });
    const toggle = card.locator(".in-toggle");
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    await watchToggleClasses(page);

    await toggle.tap();
    await card.locator(".in-toggle.on").waitFor();
    assert.match(await toggle.innerText(), /In ✓/);
    assert.ok(isIn(await myReply(friend.token, plan.id)), "server has the friend as in");
    await shot(page, "in-on");

    // The pop runs once and goes away on animationend.
    await page.waitForFunction(() => (window as any).__toggleClasses.has("pop-on"));
    await card.locator(".in-toggle:not(.pop-on)").waitFor();

    await card.locator(".in-toggle.on").tap();
    await card.locator(".in-toggle:not(.on)").waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.ok(!isIn(await myReply(friend.token, plan.id)), "server has the friend out again");
    await page.waitForFunction(() => (window as any).__toggleClasses.has("pop-off"));
    await card.locator(".in-toggle:not(.pop-off)").waitFor();

    // Still off after a reload: the state lives on the server, not in the page.
    await page.reload();
    await card.locator(".in-toggle:not(.on)").waitFor();

    // A normal press dips the button and dims it.
    const { resting, pressed } = await pressedStyle(page, ".card-plan .in-toggle");
    assert.equal(resting.transform, "none");
    assert.match(pressed.transform, /^matrix\(0\.96, 0, 0, 0\.96, 0, 0\)$/);
    assert.match(pressed.filter, /brightness\(0\.88\)/);
  } finally {
    await page.context().close();
  }
});

test("with reduced motion there is no pop and no press scale, only the colour change", { timeout: 120_000 }, async () => {
  const { friend, plan } = await people("Quiet walk");
  const page = await phone(friend.token, { reducedMotion: "reduce" });
  try {
    await page.goto(baseUrl);
    await dismiss(page);
    const card = page.locator(".card-plan", { hasText: "Quiet walk" });
    const toggle = card.locator(".in-toggle");
    await toggle.waitFor();
    await watchToggleClasses(page);
    const offColour = await toggle.evaluate((node) => getComputedStyle(node).backgroundColor);

    const { resting, pressed } = await pressedStyle(page, ".card-plan .in-toggle");
    assert.equal(resting.transform, "none");
    assert.equal(pressed.transform, "none");
    assert.match(pressed.filter, /brightness\(0\.88\)/, "press still darkens");

    await toggle.tap();
    await card.locator(".in-toggle.on").waitFor();
    assert.ok(isIn(await myReply(friend.token, plan.id)), "server has the friend as in");
    const on = await toggle.evaluate((node) => ({
      colour: getComputedStyle(node).backgroundColor,
      transform: getComputedStyle(node).transform,
      animations: node.getAnimations().map((animation) => (animation as CSSAnimation).animationName ?? "transition"),
      animationName: getComputedStyle(node).animationName,
    }));
    assert.notEqual(on.colour, offColour, "the fill still changes");
    assert.equal(on.colour, "rgb(255, 255, 255)");
    assert.equal(on.transform, "none");
    assert.deepEqual(on.animations.filter((name) => name.startsWith("in-pop")), []);
    assert.equal(on.animationName, "none");

    await card.locator(".in-toggle.on").tap();
    await card.locator(".in-toggle:not(.on)").waitFor();
    await page.waitForTimeout(400);
    const seen = await page.evaluate(() => [...(window as any).__toggleClasses]);
    assert.ok(!seen.includes("pop-on") && !seen.includes("pop-off"), `no pop class, saw ${seen.join(" ")}`);
    await shot(page, "reduced-off");
  } finally {
    await page.context().close();
  }
});

test("the pop moves nothing: In button, card and neighbours keep their layout boxes", { timeout: 180_000 }, async () => {
  for (const [width, height] of SIZES) {
    const { host, friend } = await people(`Rooftop ${width}`);
    await call("POST", "/api/plans", host.token, { note: `Brunch ${width}`, time: "11:00" });
    const page = await phone(friend.token, { width, height });
    try {
      await page.goto(baseUrl);
      await dismiss(page);
      const card = page.locator(".card-plan", { hasText: `Rooftop ${width}` });
      await card.locator(".in-toggle").waitFor();
      await page.locator(".card-plan", { hasText: `Brunch ${width}` }).waitFor();

      // Layout boxes ignore transforms, so these are exactly what a layout shift would change.
      await page.evaluate((label) => {
        const box = (node: Element | null) => {
          if (!(node instanceof HTMLElement)) return "missing";
          let top = 0;
          let left = 0;
          for (let at: HTMLElement | null = node; at; at = at.offsetParent as HTMLElement | null) {
            top += at.offsetTop;
            left += at.offsetLeft;
          }
          return `${left},${top},${node.offsetWidth}x${node.offsetHeight}`;
        };
        const frames: Array<{ pop: boolean; boxes: Record<string, string>; siblings: string }> = [];
        (window as any).__frames = frames;
        const sample = () => {
          const target = [...document.querySelectorAll(".card-plan")].find((node) => node.textContent?.includes(label)) ?? null;
          const toggle = target?.querySelector(".in-toggle") ?? null;
          const siblings = [...document.querySelectorAll(".card-plan")]
            .filter((node) => node !== target)
            .map((node) => box(node))
            .join("|");
          frames.push({
            pop: Boolean(toggle?.matches(".pop-on, .pop-off")),
            boxes: {
              toggle: box(toggle),
              card: box(target),
              chat: box(target?.querySelector(".chat-row") ?? null),
              more: box(target?.querySelector(".card-more") ?? null),
            },
            siblings,
          });
          if (frames.length < 600) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, `Rooftop ${width}`);

      await page.waitForFunction(() => (window as any).__frames.length > 2);
      const before = await page.evaluate(() => (window as any).__frames.at(-1));
      await card.locator(".in-toggle").tap();
      await card.locator(".in-toggle.on").waitFor();
      await page.waitForFunction(() => (window as any).__frames.some((frame: { pop: boolean }) => frame.pop));
      await card.locator(".in-toggle.on:not(.pop-on)").waitFor();
      await page.waitForTimeout(150);
      if (width === 360) await shot(page, "after-pop");
      const frames = await page.evaluate(() => (window as any).__frames as Array<{ pop: boolean; boxes: Record<string, string>; siblings: string }>);

      const popAt = frames.findIndex((frame) => frame.pop);
      assert.ok(popAt >= 0, "the pop ran");
      const during = frames.slice(popAt);
      const reference = during[0];
      for (const frame of during) {
        assert.deepEqual(frame.boxes, reference.boxes, `w${width}: layout moved during/after the pop`);
        assert.equal(frame.siblings, reference.siblings, `w${width}: a neighbour card moved`);
      }
      // The button keeps its size and place from before the tap to after the pop.
      assert.equal(reference.boxes.toggle.split(",")[0], before.boxes.toggle.split(",")[0], `w${width}: toggle x`);
      assert.equal(reference.boxes.toggle.split(",").at(-1), before.boxes.toggle.split(",").at(-1), `w${width}: toggle size`);
      assert.equal(reference.boxes.more, before.boxes.more, `w${width}: menu button moved`);
      assert.ok(!frames.at(-1)!.pop, "pop class is gone afterwards");
    } finally {
      await page.context().close();
    }
  }
});

test("a scroll gesture over cards scrolls the list and opens nothing", { timeout: 120_000 }, async () => {
  const { host, friend } = await people("Scroll test 0");
  for (let index = 1; index < 6; index += 1) await call("POST", "/api/plans", host.token, { note: `Scroll test ${index}`, time: "18:00" });
  const page = await phone(friend.token, { width: 360, height: 640 });
  try {
    await page.goto(baseUrl);
    await dismiss(page);
    await page.locator(".card-plan", { hasText: "Scroll test 5" }).waitFor();
    const startY = await page.evaluate(() => document.scrollingElement!.scrollTop);
    const cdp = await page.context().newCDPSession(page);
    const x = 180;
    // Start on a card body (tappable) and drag up.
    const box = await page.locator(".card-plan .card-body").first().boundingBox();
    const fromY = Math.min(560, Math.round((box?.y ?? 300) + (box?.height ?? 40) / 2));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
    for (let step = 1; step <= 12; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: fromY - step * 25 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await page.waitForTimeout(400);
    const endY = await page.evaluate(() => document.scrollingElement!.scrollTop);
    assert.ok(endY > startY, `list scrolled (${startY} -> ${endY})`);
    assert.equal(await page.getByRole("dialog", { name: "Details" }).count(), 0, "no details opened");
    assert.equal(await page.locator(".in-toggle.on").count(), 0, "no In toggled");
  } finally {
    await page.context().close();
  }
});
