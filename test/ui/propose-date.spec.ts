import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Page } from "playwright-core";
import { addDays, isoDate } from "../../src/time.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

const TZ = "Europe/Berlin";
/** Gitignored screenshots, read by a human before the UI is called done. */
const SHOT_DIR = fileURLToPath(new URL("./screenshots/propose-date/", import.meta.url));

const hangry = useHangry({ tz: TZ });
const { call } = hangry;

async function phone(token: string, width: number, height: number) {
  const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
  await skipWhatsNew(context);
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
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`) });
}

async function setup(note: string, width: number) {
  const host = await call("POST", "/api/auth/start", undefined, { name: `Hana ${width}` });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `Crew ${note}` });
  const member = await call("POST", "/api/auth/start", undefined, { name: `Finn ${width}`, code: circle.inviteCode });
  const made = (await call("POST", "/api/plans", host.token, { note, time: "19:30" })).plan;
  return { host, member, made };
}

async function planOf(token: string, id: string) {
  return (await call("GET", "/api/plans", token)).plans.find((row: { id: string }) => row.id === id);
}

for (const [width, height] of SIZES) {
  test(`at ${width}: a member proposes a date, the host accepts, and the plan moves`, { timeout: 120_000 }, async () => {
    const note = `Board games ${width}`;
    const { host, member, made } = await setup(note, width);
    const target = addDays(isoDate(Date.now(), TZ), 3);

    const memberPage = await phone(member.token, width, height);
    try {
      await memberPage.goto(hangry.baseUrl);
      await dismiss(memberPage);
      const memberCard = memberPage.locator(".card-plan", { hasText: note });
      await memberCard.getByRole("button", { name: /^More for / }).click();
      await memberPage.getByRole("menuitem", { name: "Propose new date" }).waitFor();
      await shot(memberPage, "card-menu");
      await memberPage.keyboard.press("Escape");
      await memberPage.getByRole("menuitem", { name: "Propose new date" }).waitFor({ state: "detached" });
      await memberCard.locator(".card-body").click();
      await memberPage.locator(".sheet").getByRole("button", { name: "Propose new date" }).waitFor();
      await shot(memberPage, "detail-sheet");
      await memberPage.locator(".sheet").getByRole("button", { name: "Propose new date" }).click();
      await memberPage.locator("#propose-date").fill(target);
      await memberPage.locator("#propose-note").fill("Friday works better");
      await shot(memberPage, "propose-sheet");
      await memberPage.locator(".sheet").getByRole("button", { name: "Send proposal" }).click();
      await memberPage.locator(".sheet").waitFor({ state: "detached" });
    } finally {
      await memberPage.context().close();
    }
    assert.equal((await planOf(host.token, made.id)).proposals.length, 1);

    const hostPage = await phone(host.token, width, height);
    try {
      await hostPage.goto(hangry.baseUrl);
      await dismiss(hostPage);
      const card = hostPage.locator(".card-plan", { hasText: note });
      await card.getByText("1 new date proposed").click();
      const sheet = hostPage.locator(".sheet");
      await sheet.getByText("Proposed dates").waitFor();
      await sheet.getByText(/Finn \d+ proposed/).waitFor();
      await sheet.getByText("Friday works better").waitFor();
      assert.equal(await sheet.getByRole("button", { name: "Propose new date" }).count(), 0, "the host never proposes on their own plan");
      await shot(hostPage, "host-proposal");
      await sheet.getByRole("button", { name: "Accept" }).click();
      await sheet.getByText("Proposed dates").waitFor({ state: "detached" });
      assert.equal(await sheet.getByText(/Finn \d+ proposed/).count(), 0);
      await shot(hostPage, "host-accepted");
    } finally {
      await hostPage.context().close();
    }

    const moved = await planOf(host.token, made.id);
    assert.equal(moved.forDate, target);
    assert.equal(moved.proposals.length, 0);

    const again = await phone(member.token, width, height);
    try {
      await again.goto(hangry.baseUrl);
      await dismiss(again);
      await again.locator(".card-plan", { hasText: note }).locator(".card-body").click();
      await again.locator(".sheet .sheet-head").getByText(moved.whenLabel).waitFor();
      await shot(again, "member-after-accept");
    } finally {
      await again.context().close();
    }
  });

  test(`at ${width}: the host dismisses and the date stays`, { timeout: 120_000 }, async () => {
    const note = `Walk ${width}`;
    const { host, member, made } = await setup(note, width);
    const target = addDays(isoDate(Date.now(), TZ), 3);
    await call("POST", `/api/plans/${made.id}/proposals`, member.token, { date: target });

    const hostPage = await phone(host.token, width, height);
    try {
      await hostPage.goto(hangry.baseUrl);
      await dismiss(hostPage);
      await hostPage.locator(".card-plan", { hasText: note }).getByText("1 new date proposed").click();
      const sheet = hostPage.locator(".sheet");
      await sheet.getByRole("button", { name: "Dismiss" }).waitFor();
      await shot(hostPage, "dismiss-before");
      await sheet.getByRole("button", { name: "Dismiss" }).click();
      await sheet.getByText("Proposed dates").waitFor({ state: "detached" });
      assert.equal(await sheet.getByRole("button", { name: "Propose new date" }).count(), 0);
      await shot(hostPage, "dismiss-after");
    } finally {
      await hostPage.context().close();
    }

    const kept = await planOf(host.token, made.id);
    assert.equal(kept.forDate, made.forDate);
    assert.equal(kept.proposals.length, 0);

    const hostMenu = await phone(host.token, width, height);
    try {
      await hostMenu.goto(hangry.baseUrl);
      await dismiss(hostMenu);
      await hostMenu.locator(".card-plan", { hasText: note }).getByRole("button", { name: /^More for / }).click();
      await hostMenu.getByRole("menuitem", { name: "Edit", exact: true }).waitFor();
      assert.equal(await hostMenu.getByRole("menuitem", { name: "Propose new date" }).count(), 0);
      await shot(hostMenu, "host-card-menu");
    } finally {
      await hostMenu.context().close();
    }
  });
}
