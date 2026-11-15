import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA as CHROME_UA, useHangry } from "./harness.js";

// Fake people and messages only. Screenshots go to test/ui/screenshots (gitignored).
const shotsDir = path.resolve("test/ui/screenshots/chat-alignment", process.env.CHAT_SHOTS_TAG || "after");
const hangry = useHangry({ tz: "UTC" });

const LONG_NAME = "Maximiliane Wolkenschieb"; // 24, the longest name allowed
const LONG_TEXT = "Shall we meet at the little ramen place by the station first and then walk over together? I can bring the umbrella.";
const UNBROKEN = "https://example.test/" + "a".repeat(90);
const LAYOUTS = [...SIZES, [1280, 800]] as const;

test("circle and plan chat rows share one left edge, one bar column and one timestamp edge", { timeout: 240_000 }, async () => {
  const alex = await post("/api/auth/start", { name: "Alex" });
  const circle = await post("/api/circles", { name: "Testers" }, alex.token);
  const bea = await post("/api/auth/start", { name: "Bea", code: circle.circle.inviteCode });
  const max = await post("/api/auth/start", { name: LONG_NAME, code: circle.circle.inviteCode });
  await post("/api/circles/chat", { text: "Hi" }, alex.token);
  await post("/api/circles/chat", { text: "Hallo" }, bea.token);
  await post("/api/circles/chat", { text: "nice 😄" }, alex.token);
  await post("/api/circles/chat", { text: LONG_TEXT }, max.token);
  await post("/api/circles/chat", { text: UNBROKEN }, alex.token);
  await post("/api/circles/chat", { text: "line one\nline two" }, bea.token);
  await post("/api/circles/chat", { text: "und funktionieren die Notifications? 😄" }, alex.token);
  const plan = await post("/api/socials", { note: "Ramen" }, alex.token);
  await post(`/api/socials/${plan.social.id}/reply`, { reply: "in" }, bea.token);
  await post(`/api/socials/${plan.social.id}/reply`, { reply: "in" }, max.token);
  await post(`/api/socials/${plan.social.id}/chat`, { text: "Running 5 min late" }, bea.token);
  await post(`/api/socials/${plan.social.id}/chat`, { text: "No rush" }, alex.token);
  await post(`/api/socials/${plan.social.id}/chat`, { text: LONG_TEXT }, max.token);

  const page = await openAs(alex.token);
  try {
    await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
    await page.getByText("und funktionieren").waitFor();
    await checkAll(page, "circle", 7);

    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Now", exact: true }).click();
    await page.locator("article .chat-row").first().click();
    await page.locator(".chat-msg", { hasText: "No rush" }).waitFor();
    await checkAll(page, "plan", 3);
  } finally {
    await page.context().close();
  }
});

async function checkAll(page: Page, name: string, count: number) {
  fs.mkdirSync(shotsDir, { recursive: true });
  for (const [width, height] of LAYOUTS) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shotsDir, `${name}-${width}.png`) });
    if (process.env.CHAT_SHOTS_TAG === "before") continue;
    const box = await measure(page);
    const label = `${name} @${width}`;
    assert.equal(box.rows.length, count, label);
    assert.ok(box.rows.some((row) => row.mine) && box.rows.some((row) => !row.mine), `${label}: own and other rows`);
    const first = box.rows[0];
    for (const row of box.rows) {
      const where = `${label} ${row.mine ? "own" : "other"} "${row.text.slice(0, 20)}"`;
      assert.equal(row.textLeft, first.textLeft, `${where}: text starts on the shared edge`);
      assert.equal(row.nameLeft, first.textLeft, `${where}: name starts on the shared edge`);
      assert.equal(row.deleteLeft, first.textLeft, `${where}: Delete starts on the shared edge`);
      assert.equal(row.barLeft, first.barLeft, `${where}: bar in the shared column`);
      assert.ok(row.barRight < row.textLeft, `${where}: bar sits left of the text`);
      assert.ok(row.barLeft >= box.logLeft, `${where}: bar stays inside the log`);
      assert.equal(row.timeRight, first.timeRight, `${where}: timestamps share a right edge`);
      assert.ok(row.timeRight <= box.logRight, `${where}: timestamp inside the log`);
      assert.ok(row.nameRight <= row.timeLeft, `${where}: name never runs into the time`);
      assert.equal(row.headerHeight, first.headerHeight, `${where}: header stays one line`);
      assert.ok(row.textRight <= box.logRight, `${where}: text wraps inside the log`);
    }
    assert.equal(box.backLeft, first.textLeft, `${label}: Back lines up with message text`);
    assert.equal(box.inputLeft, first.textLeft, `${label}: composer lines up with message text`);
    assert.equal(box.sendRight, first.timeRight, `${label}: Send lines up with timestamps`);
    assert.equal(box.muteRight, first.timeRight, `${label}: Mute lines up with timestamps`);
    assert.equal(box.inputHeight, box.sendHeight, `${label}: composer input and Send are the same height`);
    assert.equal(box.inputTop, box.sendTop, `${label}: composer input and Send share a top edge`);
    assert.ok(box.scrollWidth <= box.clientWidth, `${label}: no sideways scroll`);
    const long = box.rows.find((row) => row.text === LONG_TEXT);
    assert.ok(long && long.textLines > 1, `${label}: long text wraps`);
    const longName = box.rows.find((row) => row.nameFull === LONG_NAME);
    assert.ok(longName, `${label}: long name row`);
    assert.equal(longName.nameOverflow, "ellipsis nowrap", `${label}: a too-long name gets cut, not wrapped`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

function measure(page: Page) {
  return page.evaluate(() => {
    const log = document.querySelector(".chat-log")!;
    const logBox = log.getBoundingClientRect();
    const style = getComputedStyle(log);
    const rows = [...document.querySelectorAll(".chat-msg")].map((row) => {
      const rowBox = row.getBoundingClientRect();
      const bar = getComputedStyle(row, "::before");
      const barLeft = rowBox.left + parseFloat(bar.left || "0");
      const name = row.querySelector("strong") as HTMLElement;
      const text = row.querySelector("p")!;
      const lineHeight = parseFloat(getComputedStyle(text).lineHeight) || 20;
      return {
        mine: row.classList.contains("mine"),
        text: text.textContent || "",
        nameFull: name.textContent || "",
        nameOverflow: `${getComputedStyle(name).textOverflow} ${getComputedStyle(name).whiteSpace}`,
        textLeft: Math.round(text.getBoundingClientRect().left),
        textRight: Math.round(text.getBoundingClientRect().right),
        textLines: Math.round(text.getBoundingClientRect().height / lineHeight),
        nameLeft: Math.round(name.getBoundingClientRect().left),
        nameRight: Math.round(name.getBoundingClientRect().right),
        timeLeft: Math.round(row.querySelector("time")!.getBoundingClientRect().left),
        timeRight: Math.round(row.querySelector("time")!.getBoundingClientRect().right),
        headerHeight: Math.round(row.querySelector("header")!.getBoundingClientRect().height),
        deleteLeft: Math.round(row.querySelector(".text-btn")!.getBoundingClientRect().left),
        barLeft: Math.round(barLeft),
        barRight: Math.round(barLeft + parseFloat(bar.width || "0")),
      };
    });
    const back = document.querySelector(".chat-back")!.getBoundingClientRect();
    const mute = document.querySelector(".chat-head .text-btn:last-child")!.getBoundingClientRect();
    const input = document.querySelector("#chat-input")!.getBoundingClientRect();
    const send = document.querySelector(".chat-send")!.getBoundingClientRect();
    return {
      rows,
      logLeft: Math.round(logBox.left),
      logRight: Math.round(logBox.right - parseFloat(style.paddingRight)),
      scrollWidth: log.scrollWidth,
      clientWidth: log.clientWidth,
      backLeft: Math.round(back.left),
      muteRight: Math.round(mute.right),
      inputLeft: Math.round(input.left),
      inputTop: Math.round(input.top),
      inputHeight: Math.round(input.height),
      sendRight: Math.round(send.right),
      sendTop: Math.round(send.top),
      sendHeight: Math.round(send.height),
    };
  });
}

async function openAs(token: string): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: CHROME_UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => localStorage.setItem("fn_token", value), token);
  const page = await context.newPage();
  await page.goto(hangry.baseUrl);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.locator(".tabbar").waitFor();
  return page;
}

async function post(pathname: string, body: unknown, token?: string) {
  const response = await fetch(`${hangry.baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, `${pathname} ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
