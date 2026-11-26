import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Locator, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, dismissPaymentReminder, useHangry, waitForEventChat } from "./harness.js";
import { testEmail } from "../http.js";

// Fake people only. Screenshots go to test/ui/screenshots (gitignored).
const SHOT_DIR = path.resolve("test/ui/screenshots/maybe-rsvp");
const hangry = useHangry({ tz: "UTC" });
const call = hangry.call;

function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

/** Amanda hosts, Philipp and Bea are friends in her circle. */
async function circle() {
  const host = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Amanda" });
  const { circle } = await call("POST", "/api/circles", host.token, { name: "Amanda & friends" });
  const join = (name: string) => call("POST", "/api/auth/start", undefined, { email: testEmail(), name, code: circle.inviteCode });
  return { host, philipp: await join("Philipp"), bea: await join("Bea") };
}

async function openAs(token: string, width: number, height: number, mobile = true, path = ""): Promise<Page> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    colorScheme: "dark",
    ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA } : { deviceScaleFactor: 1 }),
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_installed", "1");
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}${path}`);
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await dismissPaymentReminder(page);
  return page;
}

const faces = (card: Locator) =>
  card.locator(".avatars > .avatar").evaluateAll((nodes) => nodes.map((node) => (node.textContent || "").trim()));

/** The sheet's lists as plain text, so a test can say who sits where. */
async function lists(details: Locator) {
  const text = (selector: string) => details.locator(selector).evaluateAll((nodes) => nodes.map((node) => (node.textContent || "").trim()));
  return {
    inLines: await text(".sheet-scroll > .list:not(.cant-list):not(.maybe-list) .reply-line"),
    maybeLines: await text(".sheet-scroll > .maybe-list .reply-line"),
    titles: await text(".members-title"),
  };
}

async function fitsSheet(page: Page, details: Locator) {
  const row = details.locator(".sheet-scroll .card-cta").first();
  const box = await row.boundingBox();
  assert.ok(box, "the In, Maybe and Can't row has a box");
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `the row fits: ${box.x}+${box.width} in ${width}`);
  for (const name of ["I'm in", "Maybe", "Can't"]) {
    const button = await details.getByRole("button", { name: new RegExp(`^${name}`) }).first().boundingBox();
    assert.ok(button && button.width >= 80 && button.height >= 44, `${name} is a real tap target (${button?.width}x${button?.height})`);
  }
}

test("a friend taps Maybe on the event sheet, moves to I'm in, and takes it back", { timeout: 300_000 }, async () => {
  const { host, philipp } = await circle();
  const { plan } = await call("POST", "/api/plans", host.token, { note: "Sushi night", time: "19:00" });
  const errors: string[] = [];

  for (const [width, height] of SIZES) {
    const tag = `w${width}`;
    const page = await openAs(philipp.token, width, height);
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
      await card.locator(".in-toggle").waitFor();
      await card.getByRole("button", { name: "Open details" }).click();
      const details = page.getByRole("dialog", { name: "Details" });
      await details.waitFor();
      const maybe = details.locator(".maybe-toggle");
      assert.equal(await maybe.count(), 1, `${tag}: one Maybe button on the sheet`);
      assert.equal(await maybe.getAttribute("aria-pressed"), "false");
      await fitsSheet(page, details);
      await shot(page, `sheet-before-${tag}`);

      await maybe.click();
      await details.locator(".maybe-toggle.on").waitFor();
      assert.equal(await maybe.getAttribute("aria-pressed"), "true");
      assert.match(await maybe.innerText(), /Maybe ✓/);
      await details.locator(".maybe-list .reply-line", { hasText: "You're maybe" }).waitFor();
      const asMaybe = await lists(details);
      assert.deepEqual(asMaybe.inLines, ["Amanda · host"], `${tag}: maybe is not in the in list`);
      assert.deepEqual(asMaybe.maybeLines, ["You're maybe"]);
      assert.deepEqual(asMaybe.titles, ["Who's in", "Maybe"]);
      assert.equal(await details.locator(".in-toggle").getAttribute("aria-pressed"), "false", `${tag}: still not In`);
      await page.waitForTimeout(400);
      await shot(page, `sheet-maybe-${tag}`);
      const saved = await call("GET", "/api/plans", philipp.token);
      assert.equal(saved.plans[0].joined[0].reply, "maybe");

      // Maybe is not In: the card's faces stay on the host.
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "detached" });
      assert.deepEqual(await faces(card), ["A"], `${tag}: maybe is not a face`);
      await card.locator(".who-row", { hasText: "You're maybe" }).waitFor();

      // From Maybe to I'm in: leaves the Maybe list.
      await card.getByRole("button", { name: "Open details" }).click();
      await details.waitFor();
      await details.locator(".in-toggle").click();
      await details.locator(".in-toggle.on").waitFor();
      await details.locator(".maybe-list").waitFor({ state: "detached" });
      const asIn = await lists(details);
      assert.deepEqual(asIn.inLines, ["Amanda · host", "You're in"]);
      assert.equal(await details.locator(".maybe-toggle").getAttribute("aria-pressed"), "false");
      await shot(page, `sheet-in-${tag}`);

      // Back to Maybe, then tap Maybe again to take it back.
      await details.locator(".maybe-toggle").click();
      await details.locator(".maybe-toggle.on").waitFor();
      await details.locator(".maybe-toggle.on").click();
      await details.locator(".maybe-list").waitFor({ state: "detached" });
      assert.deepEqual((await lists(details)).inLines, ["Amanda · host"]);
      const after = await call("GET", "/api/plans", philipp.token);
      assert.equal(after.plans[0].joined.length, 0, `${tag}: no reply left`);
    } finally {
      await page.context().close();
    }
  }
  assert.deepEqual(errors, []);
});

test("the host has no Maybe button, and sees who is maybe", { timeout: 120_000 }, async () => {
  const { host, philipp } = await circle();
  const { plan } = await call("POST", "/api/plans", host.token, { note: "Board games", time: "20:00" });
  await call("POST", `/api/plans/${plan.id}/reply`, philipp.token, { reply: "maybe" });

  const page = await openAs(host.token, 360, 640);
  try {
    const card = page.locator(`.card-plan[data-plan="${plan.id}"]`);
    await card.locator(".who-row", { hasText: "Philipp is maybe" }).waitFor();
    assert.deepEqual(await faces(card), ["A"], "the host's card counts nobody else in");
    await card.getByRole("button", { name: "Open details" }).click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.waitFor();
    assert.equal(await details.locator(".maybe-toggle").count(), 0, "a host cannot be maybe");
    assert.deepEqual((await lists(details)).maybeLines, ["Philipp is maybe"]);
    assert.equal(await details.getByRole("button", { name: /Remove Philipp/ }).count(), 0, "no Remove on a maybe row");
    await shot(page, "sheet-host-360");
  } finally {
    await page.context().close();
  }
});

test("a compact row counts maybe on its own, and the sheet it opens has the Maybe button", { timeout: 300_000 }, async () => {
  const { host, philipp, bea } = await circle();
  const { plan } = await call("POST", "/api/plans", host.token, { note: "Pizza night", time: "19:00" });
  await call("POST", `/api/plans/${plan.id}/reply`, philipp.token, { reply: "in" });
  await call("POST", `/api/plans/${plan.id}/reply`, bea.token, { reply: "maybe" });

  for (const [width, height] of SIZES) {
    const tag = `w${width}`;
    const page = await openAs(host.token, width, height);
    try {
      await page.getByRole("group", { name: "Event list" }).getByRole("button", { name: "Compact" }).click();
      const row = page.locator(".compact-row", { hasText: "Pizza night" });
      await row.waitFor();
      await page.mouse.wheel(0, 600);
      await row.evaluate((node) => node.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      assert.equal((await row.locator(".compact-maybe").innerText()).trim(), "1 maybe");
      assert.equal(await row.locator(".compact-who .avatar").count(), 2, `${tag}: Amanda and Philipp, not Bea`);
      const box = await row.boundingBox();
      assert.ok(box && box.height <= 56, `${tag}: still one line (${box?.height}px)`);
      const viewport = await page.evaluate(() => document.documentElement.clientWidth);
      assert.ok(box.x + box.width <= viewport + 1, `${tag}: the row fits`);
      const overflow = await row.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
      assert.equal(overflow, false, `${tag}: nothing spills out of the row`);
      await shot(page, `compact-row-${tag}`);
    } finally {
      await page.context().close();
    }
  }

  const page = await openAs(bea.token, 320, 568);
  try {
    await page.getByRole("group", { name: "Event list" }).getByRole("button", { name: "Compact" }).click();
    await page.locator(".compact-row", { hasText: "Pizza night" }).click();
    const details = page.getByRole("dialog", { name: "Details" });
    await details.waitFor();
    assert.equal(await details.locator(".maybe-toggle.on").count(), 1, "Bea's own Maybe shows as on");
    assert.equal(await details.locator(".chat-row").count(), 1, "the chat row is still there");
    await fitsSheet(page, details);
    await shot(page, "compact-sheet-w320");
  } finally {
    await page.context().close();
  }
});

test("the maybe line in the event chat takes a reaction, with no reply", { timeout: 150_000 }, async () => {
  const { host, philipp } = await circle();
  const { social } = await call("POST", "/api/socials", host.token, { note: "Dinner" });
  await call("POST", `/api/socials/${social.id}/reply`, philipp.token, { reply: "maybe" });

  const page = await openAs(host.token, 1280, 800, false, `/?chat=social:${social.id}`);
  try {
    await waitForEventChat(page, "Dinner");
    const line = page.locator(".chat-sys-row", { hasText: "Philipp is maybe" });
    await line.waitFor();
    await line.hover();
    await line.getByRole("button", { name: "React", exact: true }).click();
    await line.locator(".react-bar").waitFor();
    assert.equal(await line.locator(".react-bar .react-reply").count(), 0, "no Reply on a system line");
    await line.getByRole("button", { name: "React 👍" }).click();
    const pill = line.locator('.react-pill[data-emoji="👍"]');
    await pill.waitFor();
    assert.equal(await pill.getAttribute("aria-pressed"), "true");
    await shot(page, "chat-maybe-reacted");
  } finally {
    await page.context().close();
  }
});
