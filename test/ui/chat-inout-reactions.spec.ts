import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA as CHROME_UA, useHangry, waitForEventChat } from "./harness.js";
import { testEmail } from "../http.js";
// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-inout-reactions");
const hangry = useHangry({ tz: "UTC" });
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

type Layout = { name: string; width: number; height: number; touch: boolean };
const LAYOUTS: Layout[] = [
  ...SIZES.map(([width, height]) => ({ name: `${width}`, width, height, touch: true })),
  { name: "desktop", width: 1280, height: 800, touch: false },
];

for (const layout of LAYOUTS) {
  test(`react to an in line, and a second person sees it and reacts too at ${layout.name}`, { timeout: 150_000 }, async () => {
    const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
    const circle = await post("/api/circles", { name: "Testers" }, alex.token);
    const ada = await post("/api/auth/start", { email: testEmail(), name: "Ada", code: circle.circle.inviteCode });
    const social = (await post("/api/socials", { note: "Dinner" }, alex.token)).social;
    await post(`/api/socials/${social.id}/reply`, { reply: "in" }, ada.token);
    fs.mkdirSync(shotsDir, { recursive: true });
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shotsDir, `${name}-${layout.name}.png`) });

    const first = await openEventChat(alex.token, social.id, layout);
    try {
      const line = first.locator(".chat-sys-row", { hasText: "Ada is in" });
      await line.waitFor();
      assert.equal(await line.locator(".react-pill").count(), 0);
      await shot(first, "line-plain");
      await openBar(first, layout, line);
      assert.equal(await line.locator(".react-bar .react-pick").count(), 6, "the same quick six");
      assert.equal(await line.locator(".react-bar .react-reply").count(), 0, "no Reply on a system line");
      await shot(first, "bar-open");
      await choose(first, layout, line.getByRole("button", { name: "React 👍" }));
      const pill = line.locator('.react-pill[data-emoji="👍"]');
      await pill.waitFor();
      assert.equal(await pill.getAttribute("aria-pressed"), "true");
      assert.equal(await pill.getAttribute("title"), "Alex");
      assert.equal(await first.locator(".chat-msg").count(), 0, "the line is still a line, not a bubble");
      await shot(first, "reacted");
    } finally {
      await first.context().close();
    }

    const second = await openEventChat(ada.token, social.id, layout);
    try {
      const line = second.locator(".chat-sys-row", { hasText: "Ada is in" });
      const theirs = line.locator('.react-pill[data-emoji="👍"]');
      await theirs.waitFor();
      assert.equal(await theirs.getAttribute("aria-pressed"), "false", "Alex's reaction is not Ada's");
      assert.equal(await theirs.getAttribute("title"), "Alex");
      await shot(second, "seen-by-second");

      await openBar(second, layout, line);
      await choose(second, layout, line.getByRole("button", { name: "React ❤️" }));
      const mine = line.locator('.react-pill[data-emoji="❤️"]');
      await mine.waitFor();
      assert.equal(await mine.getAttribute("aria-pressed"), "true");
      // Change it: take the heart back and add the fire.
      await choose(second, layout, mine);
      await mine.waitFor({ state: "detached" });
      await openBar(second, layout, line);
      await choose(second, layout, line.getByRole("button", { name: "React 🔥" }));
      await line.locator('.react-pill[data-emoji="🔥"]').waitFor();
      await shot(second, "second-changed");
      const sizes = await second.evaluate(() => ({ scroll: document.querySelector(".chat-log")!.scrollWidth, client: document.querySelector(".chat-log")!.clientWidth }));
      assert.ok(sizes.scroll <= sizes.client, "no sideways scroll");
    } finally {
      await second.context().close();
    }

    const stored = (await hangry.call("GET", `/api/socials/${social.id}/chat`, alex.token)).chat.messages.find((item: { text: string }) => item.text === "Ada is in");
    assert.deepEqual(stored.reactions.map((item: { emoji: string; mine: boolean; names: string[] }) => [item.emoji, item.mine, item.names.join()]), [["👍", true, "Alex"], ["🔥", false, "Ada"]]);
  });
}

/** Opens the reaction bar on a line: the smile with a mouse, a long-press on a phone. */
async function openBar(page: Page, layout: Layout, line: ReturnType<Page["locator"]>) {
  if (layout.touch) await longPress(page, line.locator(".chat-system span"));
  else {
    await line.hover();
    await line.getByRole("button", { name: "React", exact: true }).click();
  }
  await line.locator(".react-bar").waitFor();
}

/** A tap or click; a phone waits first so the long-press that just fired does not eat it. */
async function choose(page: Page, layout: Layout, target: ReturnType<Page["locator"]>) {
  await page.waitForTimeout(layout.touch ? 750 : 0);
  if (layout.touch) await target.tap();
  else await target.click();
}

async function longPress(page: Page, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  assert.ok(box, "the line is on screen");
  const point = { x: Math.round(box.x + 10), y: Math.round(box.y + box.height / 2) };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(600);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function openEventChat(token: string, socialId: string, layout: Layout): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width: layout.width, height: layout.height },
    isMobile: layout.touch,
    hasTouch: layout.touch,
    userAgent: layout.touch ? CHROME_UA : DESKTOP_UA,
    colorScheme: "dark",
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => localStorage.setItem("fn_token", value), token);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/?chat=social:${socialId}`);
  // The install prompt sheet can cover the chat on a cold start; close it with Not now.
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await waitForEventChat(page, "Dinner");
  return page;
}

async function post(pathname: string, body: unknown, token?: string) {
  return hangry.call("POST", pathname, token, body);
}
