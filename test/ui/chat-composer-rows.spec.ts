import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA, useHangry, waitForEventChat } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/chat-composer-rows");
const hangry = useHangry({ tz: "UTC", env: { GIPHY_API_KEY: "test-giphy-key" } });
const WIDTH = 390;
const HEIGHT = 844;

type Boxes = { inner: number; input: DOMRect; compose: DOMRect; buttons: Record<string, DOMRect | null> };

/** The composer's inner width, the input box and the action buttons, in page pixels. */
async function measure(page: Page): Promise<Boxes> {
  return page.evaluate(() => {
    const compose = document.querySelector(".chat-compose") as HTMLElement;
    const style = getComputedStyle(compose);
    const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null;
    return {
      inner: compose.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      input: rect("#chat-input"),
      compose: compose.getBoundingClientRect().toJSON(),
      buttons: { send: rect(".chat-send"), gif: rect(".chat-gif-btn"), photo: rect(".chat-photo-btn"), poll: rect(".chat-poll-btn") },
    } as Boxes;
  });
}

/** Asserts the input is full width and above the action row, and the row is Send on the right, the rest on the left. */
function assertRows(label: string, boxes: Boxes, poll: boolean) {
  const { input, buttons } = boxes;
  assert.ok(input.width >= boxes.inner * 0.9, `${label}: input is ${input.width}px of ${boxes.inner}px`);
  assert.ok(buttons.gif && buttons.photo && buttons.send, `${label}: GIF, photo and Send are there`);
  assert.equal(buttons.poll !== null, poll, `${label}: the poll button ${poll ? "is" : "is not"} there`);
  for (const [name, box] of Object.entries(buttons)) {
    if (!box) continue;
    assert.ok(input.bottom <= box.top, `${label}: input bottom ${input.bottom} is above ${name} top ${box.top}`);
    assert.ok(box.height >= 44, `${label}: ${name} is ${box.height}px tall`);
    assert.ok(box.left >= 0 && box.right <= WIDTH, `${label}: ${name} fits the screen`);
  }
  assert.ok(buttons.gif!.left < buttons.photo!.left, `${label}: GIF comes before photo`);
  if (buttons.poll) assert.ok(buttons.photo!.left < buttons.poll.left, `${label}: photo comes before poll`);
  assert.ok((buttons.poll ?? buttons.photo!).right <= buttons.send!.left, `${label}: Send is right of the other buttons`);
  assert.ok(Math.abs(buttons.send!.right - input.right) <= 1, `${label}: Send lines up with the input's right edge`);
  assert.ok(boxes.compose.height <= 48 + 44 + 6 + 16 + 40, `${label}: composer stays compact (${boxes.compose.height}px)`);
}

/** Types several lines, checks the input grew and stayed full width, then sends with Send. */
async function growAndSend(page: Page, label: string, shot: (name: string) => Promise<unknown>) {
  const input = page.locator("#chat-input");
  const before = await measure(page);
  await input.fill("line one\nline two\nline three\nline four");
  const grown = await measure(page);
  assert.ok(grown.input.height > before.input.height + 40, `${label}: input grows (${before.input.height} to ${grown.input.height})`);
  assert.ok(grown.input.width >= grown.inner * 0.9, `${label}: grown input stays full width`);
  assert.ok(grown.input.bottom <= grown.buttons.send!.top, `${label}: grown input still sits above Send`);
  await input.fill(Array.from({ length: 12 }, (_, n) => `row ${n}`).join("\n"));
  const capped = await measure(page);
  assert.ok(capped.input.height <= 140, `${label}: input stops growing (${capped.input.height}px)`);
  assert.ok(await input.evaluate((node) => node.scrollHeight > node.clientHeight), `${label}: it scrolls past the cap`);
  await shot(`${label}-grown`);
  await input.fill("line one\nline two\nline three\nline four");
  await page.locator(".chat-send").tap();
  await page.locator(".chat-msg p", { hasText: "line four" }).waitFor();
  await page.waitForFunction(() => (document.getElementById("chat-input") as HTMLTextAreaElement).value === "");
  assert.equal((await measure(page)).input.height, before.input.height, `${label}: input shrinks back after Send`);
  await shot(`${label}-sent`);
}

/** The Send button and the other buttons must not take focus from the input when tapped. */
async function keepsKeyboard(page: Page, label: string) {
  await page.locator("#chat-input").focus();
  const kept = await page.evaluate(() => {
    const events = [".chat-photo-btn", ".chat-gif-btn", ".chat-poll-btn"].flatMap((selector) => {
      const button = document.querySelector(selector);
      if (!button) return [];
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      return [event.defaultPrevented];
    });
    return { events, active: document.activeElement?.id };
  });
  assert.ok(kept.events.length >= 2 && kept.events.every(Boolean), `${label}: tapping a button keeps the keyboard up`);
  assert.equal(kept.active, "chat-input", `${label}: the input keeps focus`);
}

async function phone(token: string, colorScheme: "dark" | "light"): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
    colorScheme,
    serviceWorkers: "block",
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
    localStorage.setItem("fn_installed", "1");
  }, token);
  return context.newPage();
}

async function seed() {
  const alex = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Alex" });
  const { circle } = await hangry.call("POST", "/api/circles", alex.token, { name: "Testers" });
  const bea = await hangry.call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Bea", code: circle.inviteCode });
  hangry.confirmEmails();
  const { social } = await hangry.call("POST", "/api/socials", alex.token, { note: "Dinner" });
  await hangry.call("POST", `/api/socials/${social.id}/reply`, bea.token, { reply: "in" });
  await hangry.call("POST", `/api/socials/${social.id}/chat`, bea.token, { text: "Who is bringing the snacks?" });
  await hangry.call("POST", "/api/circles/chat", bea.token, { text: "Anyone around tonight?" });
  return { alex, social };
}

const shotTo = (page: Page) => async (name: string) => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
};

for (const scheme of ["dark", "light"] as const) {
  test(`event chat composer is two rows at ${WIDTH}px, ${scheme}`, { timeout: 120_000 }, async () => {
    const { alex, social } = await seed();
    const page = await phone(alex.token, scheme);
    try {
      await page.goto(`${hangry.baseUrl}/?chat=social:${social.id}`);
      await waitForEventChat(page, "Dinner");
      await page.getByRole("button", { name: "Choose a GIF" }).waitFor();
      const shot = shotTo(page);
      assertRows(`event ${scheme}`, await measure(page), true);
      await keepsKeyboard(page, `event ${scheme}`);
      await shot(`event-${scheme}`);
      await growAndSend(page, `event-${scheme}`, shot);
    } finally {
      await page.context().close();
    }
  });
}

test(`circle chat composer is two rows at ${WIDTH}px without a poll button`, { timeout: 120_000 }, async () => {
  const { alex } = await seed();
  const page = await phone(alex.token, "dark");
  try {
    await page.goto(`${hangry.baseUrl}/?chat=circle`);
    await page.getByText("Anyone around tonight").waitFor();
    await page.getByRole("button", { name: "Choose a GIF" }).waitFor();
    const shot = shotTo(page);
    assertRows("circle", await measure(page), false);
    await keepsKeyboard(page, "circle");
    await shot("circle-dark");
    await growAndSend(page, "circle", shot);
  } finally {
    await page.context().close();
  }
});

test("a mention list sits above the full width input, Escape closes it and Enter picks from it", { timeout: 120_000 }, async () => {
  const { alex, social } = await seed();
  const page = await phone(alex.token, "dark");
  try {
    await page.goto(`${hangry.baseUrl}/?chat=social:${social.id}`);
    await waitForEventChat(page, "Dinner");
    await page.getByRole("button", { name: "Choose a GIF" }).waitFor();
    const input = page.locator("#chat-input");
    await input.click();
    await input.pressSequentially("hi @Be");
    const option = page.locator(".mention-option", { hasText: "Bea" });
    await option.waitFor();
    const list = (await page.locator(".mention-list").boundingBox())!;
    const field = (await input.boundingBox())!;
    assert.ok(list.y + list.height <= field.y + 4, "the mention list sits above the input");
    await shotTo(page)("mentions");
    await input.press("Escape");
    await page.locator(".mention-list").waitFor({ state: "detached" });
    assert.ok(await page.locator(".chat-screen").isVisible(), "Escape closed only the list");
    await input.fill("");
    await input.pressSequentially("hi @Be");
    await option.waitFor();
    await input.press("Enter");
    assert.equal(await input.inputValue(), "hi @Bea ", "Enter picks the mention instead of sending");
  } finally {
    await page.context().close();
  }
});
