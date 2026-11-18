import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { UA as CHROME_UA, openYouSection, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
const shotsDir = path.resolve("test/ui/screenshots");

const hangry = useHangry({ tz: "UTC" });

test("own messages carry the avatar color and a friend keeps one color in every chat", { timeout: 120_000 }, async () => {
  const alex = await post("/api/auth/start", { email: testEmail(), name: "Alex" });
  const circle = await post("/api/circles", { name: "friends" }, alex.token);
  const bea = await post("/api/auth/start", { email: testEmail(), name: "Bea", code: circle.circle.inviteCode });
  const cam = await post("/api/auth/start", { email: testEmail(), name: "Cam", code: circle.circle.inviteCode });
  await post("/api/circles/chat", { text: "Anyone hungry?" }, bea.token);
  await post("/api/circles/chat", { text: "Always. Ramen at 7?" }, alex.token);
  await post("/api/circles/chat", { text: "I'm in, see you there" }, cam.token);
  await post("/api/circles/chat", { text: "Booking a table for three" }, alex.token);
  const social = await post("/api/socials", { note: "Ramen" }, alex.token);
  await post(`/api/socials/${social.social.id}/reply`, { reply: "in" }, bea.token);
  await post(`/api/socials/${social.social.id}/chat`, { text: "Running 5 min late" }, bea.token);
  await post(`/api/socials/${social.social.id}/chat`, { text: "No rush" }, alex.token);

  const page = await openAs(alex.token);
  try {
    const avatar = await page.locator(".card-now .avatars .avatar").first().evaluate((node) => getComputedStyle(node).backgroundColor);
    await openYouSection(page, "Profile");
    const profile = await page.locator(".avatar.lg").evaluate((node) => getComputedStyle(node).backgroundColor);
    assert.equal(profile, avatar, "card and profile avatar agree");
    await page.getByRole("button", { name: "Circle", exact: true }).click();
    const member = await page.locator(".member-row").filter({ hasText: "Bea" }).locator(".avatar").evaluate((node) => getComputedStyle(node).backgroundColor);

    await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
    await page.getByText("Booking a table for three").waitFor();
    const circleChat = await readChat(page);
    const own = circleChat.filter((row) => row.mine);
    assert.equal(own.length, 2);
    for (const row of own) {
      assert.equal(row.bar, avatar, `own bar ${JSON.stringify(row)}`);
      assert.equal(row.name, avatar, "own name in own color");
      assert.equal(row.textLeft, row.rowLeft, "own text stays flush, the bar sits in the gutter");
      assert.ok(row.barLeft < row.rowLeft && row.barLeft >= row.logLeft, `bar inside the log gutter ${JSON.stringify(row)}`);
    }
    for (const row of circleChat) {
      assert.equal(row.textLeft, own[0].textLeft, `every message starts on the same edge ${JSON.stringify(row)}`);
      assert.equal(row.barLeft, own[0].barLeft, `every bar sits in the same gutter ${JSON.stringify(row)}`);
    }
    const beaCircle = circleChat.find((row) => row.text === "Anyone hungry?");
    const camCircle = circleChat.find((row) => row.text === "I'm in, see you there");
    assert.ok(beaCircle && camCircle);
    assert.equal(beaCircle.bar, member, "bar matches Bea's avatar");
    assert.notEqual(beaCircle.bar, camCircle.bar);
    assert.notEqual(beaCircle.bar, avatar);
    assert.notEqual(camCircle.bar, avatar);
    await shoot(page, "circle");

    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Now", exact: true }).click();
    await page.locator("article .chat-row").first().click();
    await page.locator(".chat-msg", { hasText: "No rush" }).waitFor();
    const eventChat = await readChat(page);
    assert.equal(eventChat.find((row) => row.text === "Running 5 min late")?.bar, beaCircle.bar, "Bea is the same in both chats");
    assert.equal(eventChat.find((row) => row.text === "No rush")?.bar, avatar);
    await shoot(page, "event");
  } finally {
    await page.context().close();
  }

  const beaPage = await openAs(bea.token);
  try {
    await beaPage.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
    await beaPage.getByText("Booking a table for three").waitFor();
    const fromBea = await readChat(beaPage);
    const alexRow = fromBea.find((row) => row.text === "Booking a table for three");
    const beaOwn = fromBea.find((row) => row.text === "Anyone hungry?");
    assert.ok(alexRow && beaOwn?.mine);
    const alexView = await get("/api/circles/chat", alex.token);
    const beaHex = alexView.chat.messages.find((message: { name: string }) => message.name === "Bea").color;
    assert.equal(beaOwn.data, beaHex, "Bea sees her own bar in the color others see");
  } finally {
    await beaPage.context().close();
  }
});

type ChatRow = { text: string; mine: boolean; data: string | null; bar: string; name: string; textLeft: number; rowLeft: number; barLeft: number; logLeft: number };

function readChat(page: Page): Promise<ChatRow[]> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll(".chat-msg")] as HTMLElement[];
    const logLeft = document.querySelector(".chat-log")?.getBoundingClientRect().left ?? 0;
    return rows.map((row) => {
      const mine = row.classList.contains("mine");
      const bar = getComputedStyle(row, "::before").backgroundColor;
      return {
        text: row.querySelector("p")?.textContent || "",
        mine,
        data: row.getAttribute("data-color"),
        bar,
        name: getComputedStyle(row.querySelector("strong")!).color,
        textLeft: Math.round(row.querySelector("p")?.getBoundingClientRect().left ?? 0),
        rowLeft: Math.round(row.getBoundingClientRect().left),
        barLeft: Math.round(row.getBoundingClientRect().left + parseFloat(getComputedStyle(row, "::before").left || "0")),
        logLeft: Math.round(logLeft),
      };
    });
  });
}

async function shoot(page: Page, name: string) {
  fs.mkdirSync(shotsDir, { recursive: true });
  for (const width of [320, 360, 412]) {
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 640 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(100);
      // A light OS setting renders the same dark look.
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(0, 0, 0)", `${scheme} body stays dark`);
      await page.screenshot({ path: path.join(shotsDir, `chat-colors-${name}-${width}-${scheme}.png`) });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
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

async function get(pathname: string, token: string) {
  const response = await fetch(`${hangry.baseUrl}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return response.json();
}
