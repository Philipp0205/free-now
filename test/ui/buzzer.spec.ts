import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "@playwright/test";
import type { BrowserContext, Page } from "playwright-core";
import { UA as CHROME_UA, useHangry } from "./harness.js";

const hangry = useHangry();
const SHOTS = new URL("./screenshots/buzzer/", import.meta.url);
const ANIMATIONS = ["shockwave", "slam", "flood", "bell"] as const;

async function open(reducedMotion?: "reduce") {
  const context = await hangry.browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  // Count the animation frames the buzzer asks for, to prove nothing keeps running afterwards.
  await context.addInitScript(`
    window.__buzzFrames = 0;
    (function () {
      var raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function (cb) {
        // The buzzer frame is the only rAF callback that clears a canvas. (A constant name would not survive minifying.)
        if (String(cb).indexOf("clearRect") >= 0) window.__buzzFrames += 1;
        return raf(cb);
      };
    })();
  `);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || String(error)));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  await page.goto(hangry.baseUrl);
  return { context, page, errors };
}

const play = (page: Page, animation: string, name = "Alex") =>
  page.evaluate(`(async () => {
    const m = await import("/js/buzzer.js");
    window.__ended = 0;
    return m.playBuzzer({ name: ${JSON.stringify(name)}, animation: ${JSON.stringify(animation)}, onEnd: () => { window.__ended += 1; } });
  })()`) as Promise<boolean>;

const counter = (page: Page, key: "__ended" | "__buzzFrames") => page.evaluate(`window.${key}`) as Promise<number>;

/** Alpha and colour of the canvas pixel at a fraction of its size. */
const pixel = (page: Page, fx: number, fy: number) =>
  page.evaluate(([x, y]) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".buzzer canvas")!;
    const data = canvas.getContext("2d")!.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  }, [fx, fy] as const);

async function nonTransparentPixels(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".buzzer canvas")!;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
    return { count, total: canvas.width * canvas.height };
  });
}

test("each animation draws, blocks, dismisses on tap and cleans up", { timeout: 120_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { context, page, errors } = await open();
  try {
    for (const animation of ANIMATIONS) {
      assert.equal(await play(page, animation), true, `${animation} starts`);
      const overlay = page.locator(".buzzer");
      await overlay.waitFor();
      assert.equal(await overlay.getAttribute("role"), "status");
      assert.equal(await overlay.getAttribute("aria-live"), "assertive");
      assert.equal(await overlay.locator(".buzzer-sr").textContent(), "Alex is free now");
      const css = await overlay.evaluate((el) => {
        const s = getComputedStyle(el);
        return { position: s.position, z: Number(s.zIndex), touch: s.touchAction, w: el.clientWidth, h: el.clientHeight };
      });
      assert.deepEqual([css.position, css.touch, css.w, css.h], ["fixed", "manipulation", 390, 844]);
      assert.ok(css.z >= 9999);

      await page.waitForTimeout(1100);
      const seen = await nonTransparentPixels(page);
      assert.ok(seen.count > seen.total * 0.2, `${animation}: ${seen.count} of ${seen.total} pixels painted`);
      const [, , , alpha] = await pixel(page, 0.5, 0.42);
      assert.ok(alpha > 0, `${animation}: centre pixel is not transparent`);
      assert.equal(await play(page, animation), false, "a second overlay is refused");
      assert.equal(await page.locator(".buzzer").count(), 1);
      await page.screenshot({ path: new URL(`${animation}.png`, SHOTS).pathname });

      // The overlay takes the tap: the page below gets nothing.
      await page.touchscreen.tap(195, 700);
      await page.locator(".buzzer").waitFor({ state: "detached", timeout: 2000 });
      assert.equal(await counter(page, "__ended"), 1);
      await page.waitForTimeout(100);
      const before = await counter(page, "__buzzFrames");
      await page.waitForTimeout(250);
      assert.equal(await counter(page, "__buzzFrames"), before, "no frames after a tap dismiss");
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("each animation ends by itself and leaves nothing behind", { timeout: 120_000 }, async () => {
  const { context, page, errors } = await open();
  try {
    for (const animation of ANIMATIONS) {
      assert.equal(await play(page, animation, "Marius"), true);
      await page.waitForTimeout(3600);
      assert.equal(await page.locator(".buzzer").count(), 0, `${animation} removed itself`);
      assert.equal(await counter(page, "__ended"), 1);
      const before = await counter(page, "__buzzFrames");
      assert.ok(before > 30, `${animation} ran ${before} frames`);
      await page.waitForTimeout(250);
      assert.equal(await counter(page, "__buzzFrames"), before, "no frames after the end");
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("Escape dismisses, and a long name still fits on a small screen", { timeout: 60_000 }, async () => {
  const { context, page, errors } = await open();
  try {
    const long = "Bartholomew Maximilian Featherstonehaugh";
    for (const animation of ANIMATIONS) {
      assert.equal(await play(page, animation, long), true);
      await page.waitForTimeout(1300);
      assert.equal(await page.locator(".buzzer-sr").textContent(), "Bartholomew Maximilian F is free now");
      await page.screenshot({ path: new URL(`long-${animation}.png`, SHOTS).pathname });
      await page.keyboard.press("Escape");
      await page.locator(".buzzer").waitFor({ state: "detached", timeout: 2000 });
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("reduced motion shows a still overlay with the name as text", { timeout: 60_000 }, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { context, page, errors } = await open();
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await play(page, "shockwave", "<b>Alex</b>"), true);
    const overlay = page.locator(".buzzer.reduced");
    await overlay.waitFor();
    assert.equal(await overlay.locator("canvas").count(), 0);
    await page.waitForTimeout(900);
    assert.equal(await overlay.locator(".buzzer-name").textContent(), "<b>Alex</b>");
    assert.equal(await overlay.locator("b").count(), 0, "the name is text, not HTML");
    assert.equal(await overlay.locator(".buzzer-sub").textContent(), "is free now");
    assert.equal(await overlay.evaluate((el) => Number(getComputedStyle(el).opacity)), 1);
    assert.equal(await play(page, "slam"), false);
    await page.screenshot({ path: new URL("reduced.png", SHOTS).pathname });
    await page.touchscreen.tap(195, 400);
    await page.locator(".buzzer").waitFor({ state: "detached", timeout: 2000 });

    assert.equal(await play(page, "bell"), true);
    await page.waitForTimeout(2200);
    assert.equal(await page.locator(".buzzer").count(), 0, "the still overlay ends by itself");
    assert.equal(await counter(page, "__ended"), 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
