import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/emoji-rain");
const hangry = useHangry({ tz: "UTC" });

const RAIN = "[data-emoji-rain]";
/** The rain lasts about 3.5s, and the other person sees it on the next 3s poll. */
const SEEN_MS = 15_000;

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
}

async function openApp(token: string, width: number, height: number, reducedMotion: "reduce" | "no-preference") {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA, reducedMotion });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  await page.locator(".tabbar").waitFor();
  return page;
}

async function openCircleChat(token: string, width: number, height: number, reducedMotion: "reduce" | "no-preference") {
  const page = await openApp(token, width, height, reducedMotion);
  await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
  await page.locator(".chat-screen").waitFor();
  await page.locator(".chat-msg", { hasText: "Hi all" }).waitFor();
  return page;
}

async function say(page: Page, text: string) {
  await page.locator("#chat-input").fill(text);
  await page.locator(".chat-send").tap();
}

async function setup() {
  const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
  const { circle } = await post("/api/circles", { name: "Friends" }, alex.token);
  const bea = await post("/api/auth/start", { email: testEmail(), name: "Bea", code: circle.inviteCode });
  hangry.confirmEmails();
  await post("/api/circles/chat", { text: "Hi all" }, bea.token);
  return { alex, bea };
}

const drops = (page: Page) => page.locator(`${RAIN} .emoji-rain-drop`);

for (const [width, height] of SIZES) {
  test(`taco and /makeitrain rain on both open chats at ${width}x${height}`, { timeout: 170_000 }, async () => {
    const { alex, bea } = await setup();
    const a = await openCircleChat(alex.token, width, height, "no-preference");
    const b = await openCircleChat(bea.token, width, height, "no-preference");
    const errors: string[] = [];
    for (const page of [a, b]) page.on("pageerror", (error) => errors.push(error.message));
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      // Opening a chat with older messages rains nothing.
      await a.waitForTimeout(500);
      assert.equal(await a.locator(RAIN).count(), 0, "no rain for the history on open");

      // "taco" rains tacos on the sender at once and on the other open chat.
      await say(a, "who wants a taco");
      await a.locator(RAIN).waitFor();
      assert.equal(await a.locator(RAIN).getAttribute("data-emoji-rain"), "🌮");
      assert.equal(await drops(a).count(), 200);
      assert.equal(await drops(a).first().textContent(), "🌮");
      await a.screenshot({ path: path.join(shotsDir, `taco-sender-${width}x${height}.png`) });
      const style = await a.locator(RAIN).evaluate((node) => {
        const box = node.getBoundingClientRect();
        return { events: getComputedStyle(node).pointerEvents, w: box.width, h: box.height, hit: document.elementFromPoint(innerWidth / 2, innerHeight - 30)?.closest("[data-emoji-rain]") !== null };
      });
      assert.equal(style.events, "none");
      assert.ok(style.w >= width && style.h >= height, "it covers the screen");
      assert.equal(style.hit, false, "a tap goes through the rain");
      // The chat still works under the rain: the composer takes focus and text.
      await a.locator("#chat-input").tap();
      await a.locator("#chat-input").pressSequentially("still here");
      assert.equal(await a.locator("#chat-input").inputValue(), "still here");
      await b.locator(RAIN).waitFor({ timeout: SEEN_MS });
      assert.equal(await b.locator(RAIN).getAttribute("data-emoji-rain"), "🌮");
      await b.screenshot({ path: path.join(shotsDir, `taco-friend-${width}x${height}.png`) });
      // It cleans up after itself.
      await a.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
      await b.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
      assert.equal(await a.locator(".emoji-rain-drop").count(), 0);
      await a.locator("#chat-input").fill("");

      // The same message does not rain again on the next polls.
      await a.waitForTimeout(3500);
      assert.equal(await a.locator(RAIN).count() + (await b.locator(RAIN).count()), 0, "no replay on a poll");

      // A word that only contains taco is just a message.
      await say(a, "tacotruck outside");
      await b.locator(".chat-msg", { hasText: "tacotruck outside" }).waitFor({ timeout: SEEN_MS });
      await b.waitForTimeout(500);
      assert.equal(await a.locator(RAIN).count() + (await b.locator(RAIN).count()), 0, "tacotruck does not rain");

      // /makeitrain with an emoji rains that emoji, and the message stays as written.
      await say(a, "/makeitrain 🥚");
      await a.locator(RAIN).waitFor();
      assert.equal(await a.locator(RAIN).getAttribute("data-emoji-rain"), "🥚");
      assert.equal(await drops(a).first().textContent(), "🥚");
      await a.locator(".chat-msg", { hasText: "/makeitrain 🥚" }).waitFor();
      await b.locator(RAIN).waitFor({ timeout: SEEN_MS });
      assert.equal(await b.locator(RAIN).getAttribute("data-emoji-rain"), "🥚");
      await a.screenshot({ path: path.join(shotsDir, `eggs-sender-${width}x${height}.png`) });
      await a.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
      await b.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });

      // A flag stays whole.
      await say(a, "/makeitrain 🇩🇪🇫🇷");
      await a.locator(RAIN).waitFor();
      assert.equal(await a.locator(RAIN).getAttribute("data-emoji-rain"), "🇩🇪");
      await a.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
      await b.locator(".chat-msg", { hasText: "/makeitrain 🇩🇪🇫🇷" }).waitFor({ timeout: SEEN_MS });
      await b.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });

      // No emoji: tacos, and the text stays.
      await say(a, "/makeitrain");
      await a.locator(RAIN).waitFor();
      assert.equal(await a.locator(RAIN).getAttribute("data-emoji-rain"), "🌮");
      await a.locator(".chat-msg", { hasText: "/makeitrain" }).last().waitFor();
      await a.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
      await b.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });

      // Reopening the chat later does not replay old messages.
      await b.reload();
      await b.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
      await b.locator(".chat-msg", { hasText: "/makeitrain 🥚" }).waitFor();
      await b.waitForTimeout(3500);
      assert.equal(await b.locator(RAIN).count(), 0, "history never rains on a reload");

      assert.deepEqual(errors, [], "no page errors");
    } finally {
      await a.context().close();
      await b.context().close();
    }
  });
}

/**
 * The rain under reduced motion is really falling: the overlay is drawn, there are drops (fewer than 200, none spinning),
 * their fall animation runs, some are on screen, and they move between two samples.
 */
async function assertFalling(page: Page, label: string) {
  const look = () =>
    page.locator(RAIN).evaluate((layer) => {
      const list = [...layer.querySelectorAll<HTMLElement>(".emoji-rain-drop")];
      const box = layer.getBoundingClientRect();
      const onScreen = list.filter((drop) => {
        const r = drop.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      });
      const style = getComputedStyle(layer);
      const animations = list.flatMap((drop) => drop.getAnimations());
      return {
        display: style.display,
        visibility: style.visibility,
        covers: box.width >= innerWidth && box.height >= innerHeight,
        drops: list.length,
        spins: [...new Set(list.map((drop) => drop.style.getPropertyValue("--spin")))],
        animated: animations.length,
        names: [...new Set(animations.map((a) => (a as CSSAnimation).animationName))],
        running: animations.filter((a) => a.playState === "running").length,
        onScreen: onScreen.length,
        tops: onScreen.slice(0, 5).map((drop) => Math.round(drop.getBoundingClientRect().top)),
        opacity: onScreen.length ? getComputedStyle(onScreen[0]).opacity : "0",
      };
    });
  await page.waitForTimeout(1000);
  const first = await look();
  assert.notEqual(first.display, "none", `${label}: the overlay is drawn`);
  assert.equal(first.visibility, "visible", label);
  assert.ok(first.covers, `${label}: it covers the screen`);
  assert.ok(first.drops > 0 && first.drops < 200, `${label}: a lighter rain, got ${first.drops} drops`);
  assert.deepEqual(first.spins, ["0deg"], `${label}: no spin`);
  assert.equal(first.animated, first.drops, `${label}: every drop has an animation`);
  assert.deepEqual(first.names, ["emoji-rain-fall"], label);
  assert.ok(first.running > 0, `${label}: the fall animation is running`);
  assert.ok(first.onScreen > 0, `${label}: drops are on screen`);
  assert.equal(first.opacity, "1", `${label}: drops are visible`);
  await page.waitForTimeout(300);
  const second = await look();
  assert.ok(second.onScreen > 0, `${label}: still falling`);
  assert.notDeepEqual(second.tops, first.tops, `${label}: the drops moved, it is not a static pile`);
}

test("reduce motion still rains, lighter and without spin, on taco and /makeitrain", { timeout: 120_000 }, async () => {
  const { alex, bea } = await setup();
  const a = await openCircleChat(alex.token, 360, 640, "reduce");
  const b = await openCircleChat(bea.token, 360, 640, "reduce");
  const errors: string[] = [];
  for (const page of [a, b]) page.on("pageerror", (error) => errors.push(error.message));
  try {
    fs.mkdirSync(shotsDir, { recursive: true });
    assert.equal(await a.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true, "reduced motion is on");
    await say(a, "taco time");
    await a.locator(RAIN).waitFor();
    assert.equal(await a.locator(RAIN).getAttribute("data-emoji-rain"), "🌮");
    assert.equal(await drops(a).first().textContent(), "🌮");
    await assertFalling(a, "taco on the sender");
    await a.screenshot({ path: path.join(shotsDir, "reduced-taco-sender-360x640.png") });
    await b.locator(RAIN).waitFor({ timeout: SEEN_MS });
    await assertFalling(b, "taco on the friend");
    await b.screenshot({ path: path.join(shotsDir, "reduced-taco-friend-360x640.png") });
    // It cleans up after itself.
    await a.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
    await b.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
    assert.equal(await a.locator(".emoji-rain-drop").count(), 0, "no drops left behind");

    await say(a, "/makeitrain 🥚");
    await a.locator(RAIN).waitFor();
    assert.equal(await a.locator(RAIN).getAttribute("data-emoji-rain"), "🥚");
    assert.equal(await drops(a).first().textContent(), "🥚");
    await assertFalling(a, "/makeitrain on the sender");
    await a.screenshot({ path: path.join(shotsDir, "reduced-eggs-sender-360x640.png") });
    await b.locator(RAIN).waitFor({ timeout: SEEN_MS });
    assert.equal(await b.locator(RAIN).getAttribute("data-emoji-rain"), "🥚");
    await a.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
    await b.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await a.context().close();
    await b.context().close();
  }
});

const CHAT_TAB = (page: Page) => page.locator(".tabbar").getByRole("button", { name: /^Chat/ });

/* The taco hurricane: three taco messages within a minute play one bigger rain. */

const HURRICANE = '[data-emoji-rain-kind="hurricane"]';
const NORMAL = '[data-emoji-rain-kind="rain"]';

/** What the hurricane layer looks like right now. */
function lookAtHurricane(page: Page) {
  return page.locator(HURRICANE).evaluate((layer) => {
    const list = [...layer.querySelectorAll<HTMLElement>(".emoji-rain-drop")];
    const onScreen = list.filter((drop) => {
      const r = drop.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    });
    const drops = list.flatMap((drop) => drop.getAnimations());
    const own = layer.getAnimations().filter((a) => (a as CSSAnimation).animationName === "emoji-rain-shake");
    const box = layer.getBoundingClientRect();
    return {
      display: getComputedStyle(layer).display,
      events: getComputedStyle(layer).pointerEvents,
      covers: box.width >= innerWidth && box.height >= innerHeight,
      emoji: layer.getAttribute("data-emoji-rain"),
      drops: list.length,
      spins: [...new Set(list.map((drop) => drop.style.getPropertyValue("--spin")))],
      names: [...new Set(drops.map((a) => (a as CSSAnimation).animationName))],
      running: drops.filter((a) => a.playState === "running").length,
      shaking: own.filter((a) => a.playState === "running").length,
      onScreen: onScreen.length,
      tops: onScreen.slice(0, 5).map((drop) => Math.round(drop.getBoundingClientRect().top)),
      lefts: onScreen.slice(0, 5).map((drop) => Math.round(drop.getBoundingClientRect().left)),
    };
  });
}

/** Waits until every rain layer, normal or hurricane, is gone. */
async function allGone(page: Page) {
  await page.waitForFunction(() => document.querySelectorAll("[data-emoji-rain]").length === 0, undefined, { timeout: SEEN_MS + 5000 });
}

async function sayAndWait(page: Page, text: string) {
  const before = await page.locator(".chat-msg", { hasText: text }).count();
  await say(page, text);
  await page.locator(".chat-msg", { hasText: text }).nth(before).waitFor();
}

for (const [width, height] of SIZES) {
  test(`one taco rains normally, three tacos in a minute start the hurricane at ${width}x${height}`, { timeout: 170_000 }, async () => {
    const { alex, bea } = await setup();
    const a = await openCircleChat(alex.token, width, height, "no-preference");
    const b = await openCircleChat(bea.token, width, height, "no-preference");
    const errors: string[] = [];
    for (const page of [a, b]) page.on("pageerror", (error) => errors.push(error.message));
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      // One taco: the normal rain only, as before.
      await say(a, "taco number one");
      await a.locator(NORMAL).waitFor();
      assert.equal(await a.locator(HURRICANE).count(), 0, "one taco is not a hurricane");
      assert.equal(await a.locator(NORMAL).getAttribute("data-emoji-rain"), "🌮");
      assert.equal(await a.locator(`${NORMAL} .emoji-rain-drop`).count(), 200);
      const fall = await a.locator(`${NORMAL} .emoji-rain-drop`).evaluateAll((list) => [...new Set(list.flatMap((drop) => drop.getAnimations().map((x) => (x as CSSAnimation).animationName)))]);
      assert.deepEqual(fall, ["emoji-rain-fall"]);

      // The second taco is still a normal rain.
      await sayAndWait(a, "second taco");
      await a.waitForTimeout(300);
      assert.equal(await a.locator(HURRICANE).count(), 0, "two tacos are not a hurricane");

      // The third one, inside the minute, is the hurricane, once.
      await sayAndWait(a, "third taco!");
      await a.locator(HURRICANE).waitFor();
      assert.equal(await a.locator(HURRICANE).count(), 1, "one hurricane");
      await a.waitForTimeout(1500);
      const first = await lookAtHurricane(a);
      assert.equal(first.emoji, "🌮");
      assert.ok(first.drops > 200, `more tacos than the usual 200, got ${first.drops}`);
      assert.equal(first.events, "none");
      assert.ok(first.covers, "it covers the screen");
      assert.deepEqual(first.names, ["emoji-rain-hurricane"]);
      assert.ok(first.running > 0, "the hurricane motion is running");
      assert.ok(first.shaking > 0, "the screen shake is running");
      assert.ok(first.onScreen > 0, "tacos are on screen");
      assert.ok(first.spins.some((spin) => spin !== "0deg"), "the tacos spin");
      await a.screenshot({ path: path.join(shotsDir, `hurricane-sender-${width}x${height}.png`) });
      await a.waitForTimeout(300);
      const second = await lookAtHurricane(a);
      assert.notDeepEqual([second.tops, second.lefts], [first.tops, first.lefts], "the tacos move");
      // The chat is usable under it.
      const hit = await a.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight - 30)?.closest("[data-emoji-rain]") !== null);
      assert.equal(hit, false, "a tap goes through the hurricane");
      await a.locator("#chat-input").tap();
      await a.locator("#chat-input").pressSequentially("still here");
      assert.equal(await a.locator("#chat-input").inputValue(), "still here");
      await a.locator("#chat-input").fill("");

      // The friend sees a hurricane too, once.
      await b.locator(HURRICANE).waitFor({ timeout: SEEN_MS });
      await b.waitForTimeout(1500);
      assert.ok((await lookAtHurricane(b)).drops > 200);
      await b.screenshot({ path: path.join(shotsDir, `hurricane-friend-${width}x${height}.png`) });

      // It cleans up after itself, and a poll does not replay it.
      await allGone(a);
      await allGone(b);
      assert.equal(await a.locator(".emoji-rain-drop").count(), 0);
      await a.waitForTimeout(3500);
      assert.equal(await a.locator(HURRICANE).count() + (await b.locator(HURRICANE).count()), 0, "no replay on a poll");

      // A fourth taco in the same burst is a normal rain, not a second hurricane.
      await sayAndWait(a, "fourth taco");
      await a.locator(NORMAL).waitFor();
      await a.waitForTimeout(500);
      assert.equal(await a.locator(HURRICANE).count(), 0, "no second hurricane in the same burst");
      assert.deepEqual(errors, [], "no page errors");
    } finally {
      await a.context().close();
      await b.context().close();
    }
  });
}

test("reduce motion still plays a gentle taco hurricane: fewer tacos, no spin, no shake, but falling", { timeout: 120_000 }, async () => {
  const { alex } = await setup();
  const a = await openCircleChat(alex.token, 360, 640, "reduce");
  const errors: string[] = [];
  a.on("pageerror", (error) => errors.push(error.message));
  try {
    fs.mkdirSync(shotsDir, { recursive: true });
    assert.equal(await a.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true, "reduced motion is on");
    await say(a, "taco one");
    await a.locator(NORMAL).waitFor();
    assert.equal(await a.locator(`${NORMAL} .emoji-rain-drop`).count(), 40, "a normal rain is still the v130 rain");
    await sayAndWait(a, "taco two");
    await sayAndWait(a, "taco three");
    await a.locator(HURRICANE).waitFor();
    await a.waitForTimeout(1200);
    const first = await lookAtHurricane(a);
    assert.notEqual(first.display, "none", "the overlay is drawn");
    assert.ok(first.covers);
    assert.ok(first.drops > 40 && first.drops < 200, `a gentle hurricane, got ${first.drops} tacos`);
    assert.deepEqual(first.spins, ["0deg"], "no spin");
    assert.equal(first.shaking, 0, "no shake");
    assert.deepEqual(first.names, ["emoji-rain-hurricane"]);
    assert.ok(first.running > 0, "the animation is running");
    assert.ok(first.onScreen > 0, "tacos are on screen");
    assert.equal(await a.locator(`${HURRICANE}.emoji-rain-shake`).count(), 0);
    await a.screenshot({ path: path.join(shotsDir, "reduced-hurricane-360x640.png") });
    await a.waitForTimeout(300);
    const second = await lookAtHurricane(a);
    assert.ok(second.onScreen > 0, "still falling");
    assert.notDeepEqual(second.tops, first.tops, "the tacos moved, it is not a static pile");
    await allGone(a);
    assert.equal(await a.locator(".emoji-rain-drop").count(), 0, "it cleans up");
    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await a.context().close();
  }
});

test("a burst of tacos missed while the chat was closed plays one hurricane when it is opened", { timeout: 120_000 }, async () => {
  const { alex, bea } = await setup();
  const b = await openApp(bea.token, 360, 640, "no-preference");
  const errors: string[] = [];
  b.on("pageerror", (error) => errors.push(error.message));
  try {
    fs.mkdirSync(shotsDir, { recursive: true });
    await post("/api/circles/chat", { text: "taco one" }, alex.token);
    await post("/api/circles/chat", { text: "two tacos" }, alex.token);
    await post("/api/circles/chat", { text: "taco three" }, alex.token);
    await b.waitForTimeout(500);
    assert.equal(await b.locator("[data-emoji-rain]").count(), 0, "nothing rains while the chat is closed");
    await CHAT_TAB(b).click();
    await b.locator(".chat-msg", { hasText: "taco three" }).waitFor();
    await b.locator(HURRICANE).waitFor();
    assert.equal(await b.locator("[data-emoji-rain]").count(), 1, "one overlay, a hurricane and no normal rain");
    assert.ok((await lookAtHurricane(b)).drops > 200);
    await b.waitForTimeout(1500);
    await b.screenshot({ path: path.join(shotsDir, "missed-hurricane-360x640.png") });
    await allGone(b);
    // Out and back in, and a reload: it does not play again.
    await b.locator(".chat-screen").getByRole("button", { name: "Back" }).click();
    await b.locator(".tabbar").waitFor();
    await CHAT_TAB(b).click();
    await b.locator(".chat-msg", { hasText: "taco three" }).waitFor();
    await b.waitForTimeout(3500);
    assert.equal(await b.locator("[data-emoji-rain]").count(), 0, "no replay when the chat is opened again");
    await b.reload();
    await CHAT_TAB(b).click();
    await b.locator(".chat-msg", { hasText: "taco three" }).waitFor();
    await b.waitForTimeout(3500);
    assert.equal(await b.locator("[data-emoji-rain]").count(), 0, "no replay after a reload");
    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await b.context().close();
  }
});

test("a recent rain missed while the chat was closed plays once when it is opened", { timeout: 170_000 }, async () => {
  const { alex, bea } = await setup();
  // Bea is in the app but not in the chat. Alex sends two triggers meanwhile.
  const b = await openApp(bea.token, 360, 640, "no-preference");
  try {
    fs.mkdirSync(shotsDir, { recursive: true });
    await post("/api/circles/chat", { text: "anyone for a taco" }, alex.token);
    await post("/api/circles/chat", { text: "/makeitrain 🥚" }, alex.token);
    await post("/api/circles/chat", { text: "see you there" }, alex.token);
    await b.waitForTimeout(500);
    assert.equal(await b.locator(RAIN).count(), 0, "nothing rains while the chat is closed");

    await CHAT_TAB(b).click();
    await b.locator(".chat-msg", { hasText: "see you there" }).waitFor();
    await b.locator(RAIN).waitFor();
    // Several missed rains play as one, from the newest trigger.
    assert.equal(await b.locator(RAIN).count(), 1, "one overlay");
    assert.equal(await b.locator(RAIN).getAttribute("data-emoji-rain"), "🥚");
    assert.equal(await drops(b).count(), 200);
    await b.waitForTimeout(1200);
    await b.screenshot({ path: path.join(shotsDir, "missed-rain-360x640.png") });
    await b.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
    await b.waitForTimeout(1500);
    assert.equal(await b.locator(RAIN).count(), 0, "it does not play a second time or queue another");

    // Out and back in on the same browser: already played, so nothing.
    await b.locator(".chat-screen").getByRole("button", { name: "Back" }).click();
    await b.locator(".tabbar").waitFor();
    await CHAT_TAB(b).click();
    await b.locator(".chat-msg", { hasText: "see you there" }).waitFor();
    await b.waitForTimeout(3500);
    assert.equal(await b.locator(RAIN).count(), 0, "no replay when the chat is opened again");

    // A reload keeps localStorage, so it still does not replay.
    await b.reload();
    await CHAT_TAB(b).click();
    await b.locator(".chat-msg", { hasText: "see you there" }).waitFor();
    await b.waitForTimeout(3500);
    assert.equal(await b.locator(RAIN).count(), 0, "no replay after a reload");
    const stored = await b.evaluate(() => JSON.parse(localStorage.getItem("fn_rain_played") || "{}"));
    assert.equal(Object.keys(stored).length, 2, "both triggers are remembered");
  } finally {
    await b.context().close();
  }
});

test("a rain older than the catch-up window does not play when the chat is opened", { timeout: 120_000 }, async () => {
  const { alex, bea } = await setup();
  const b = await openApp(bea.token, 360, 640, "no-preference");
  try {
    await post("/api/circles/chat", { text: "old taco from yesterday" }, alex.token);
    await post("/api/circles/chat", { text: "just a message" }, alex.token);
    // Age the message past the one hour window in the db, instead of changing the window.
    const aged = hangry.db.prepare("UPDATE messages SET created_at = ? WHERE body = ?").run(Date.now() - 61 * 60 * 1000, "old taco from yesterday");
    assert.equal(Number(aged.changes), 1);

    await CHAT_TAB(b).click();
    await b.locator(".chat-msg", { hasText: "old taco from yesterday" }).waitFor();
    await b.locator(".chat-msg", { hasText: "just a message" }).waitFor();
    await b.waitForTimeout(3500);
    assert.equal(await b.locator(RAIN).count(), 0, "an old rain stays quiet");
    assert.equal(await b.evaluate(() => localStorage.getItem("fn_rain_played")), null, "and is not recorded");
  } finally {
    await b.context().close();
  }
});

test("reduce motion still plays a recent missed rain when the chat is opened", { timeout: 120_000 }, async () => {
  const { alex, bea } = await setup();
  const b = await openApp(bea.token, 360, 640, "reduce");
  const errors: string[] = [];
  b.on("pageerror", (error) => errors.push(error.message));
  try {
    fs.mkdirSync(shotsDir, { recursive: true });
    await post("/api/circles/chat", { text: "taco night", }, alex.token);
    await b.waitForTimeout(500);
    assert.equal(await b.locator(RAIN).count(), 0, "nothing rains while the chat is closed");
    await CHAT_TAB(b).click();
    await b.locator(".chat-msg", { hasText: "taco night" }).waitFor();
    await b.locator(RAIN).waitFor();
    assert.equal(await b.locator(RAIN).count(), 1, "one overlay");
    assert.equal(await b.locator(RAIN).getAttribute("data-emoji-rain"), "🌮");
    await assertFalling(b, "missed rain");
    await b.screenshot({ path: path.join(shotsDir, "reduced-missed-rain-360x640.png") });
    await b.locator(RAIN).waitFor({ state: "detached", timeout: SEEN_MS });
    assert.equal(await b.locator(".emoji-rain-drop").count(), 0, "it cleans up");
    await b.waitForTimeout(1500);
    assert.equal(await b.locator(RAIN).count(), 0, "it does not play a second time");
    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await b.context().close();
  }
});
