import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { BrowserContext, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

/** Screenshots land in test/ui/screenshots/invite-existing-account/ (git-ignored). */
const SHOT_DIR = path.resolve(process.env.INVITE_EXISTING_SHOT_DIR || "test/ui/screenshots/invite-existing-account");

const hangry = useHangry();
const { call } = hangry;

function userCount(): number {
  return Number((hangry.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number | bigint }).n);
}

let seq = 0;
/** Fake host with a circle, plus a fake guest who already has an account. Made through the real API. */
async function scene() {
  seq += 1;
  const host = await call("POST", "/api/auth/start", undefined, { name: `Host ${seq}` });
  const { circle } = await call("POST", "/api/circles", host.token, { name: `Fake circle ${seq}` });
  const guest = await call("POST", "/api/auth/start", undefined, { name: `Guest ${seq}` });
  return { host, circle: circle as { id: string; name: string; inviteCode: string }, guest };
}

async function phone(width: number, height: number, token = ""): Promise<BrowserContext> {
  const mobile = width < 900;
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    ...(mobile ? { userAgent: UA } : {}),
  });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_install_later", String(Date.now()));
    if (value && !sessionStorage.getItem("seeded")) {
      localStorage.setItem("fn_token", value);
      sessionStorage.setItem("seeded", "1");
    }
  }, token);
  return context;
}

/** The recovery code is a secret even when fake: it is masked in every shot. */
async function shot(page: Page, name: string, width: number, height: number) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SHOT_DIR, `${name}-${width}x${height}.png`),
    mask: [page.locator("#recover-code")],
    maskColor: "#3a3a3c",
  });
}

async function noOverflow(page: Page, label: string) {
  const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  assert.equal(fit.scroll, fit.client, `no horizontal scroll: ${label}`);
}

async function meOf(page: Page) {
  const token = await page.evaluate(() => localStorage.getItem("fn_token"));
  assert.ok(token, "the browser holds a token");
  return call("GET", "/api/me", token!);
}

for (const [width, height] of SIZES) {
  test(`at ${width}: an existing account signs in from the invite and joins the circle`, { timeout: 90_000 }, async () => {
    const { circle, guest } = await scene();
    const before = userCount();
    const context = await phone(width, height);
    const page = await context.newPage();
    await page.goto(`${hangry.baseUrl}/join/${circle.inviteCode}`);
    await page.locator(".lede", { hasText: `Join ${circle.name}` }).waitFor();

    const existing = page.getByRole("button", { name: "I already have an account" });
    await existing.waitFor();
    assert.match((await existing.getAttribute("class")) ?? "", /\bsecondary\b/, "obvious secondary button, not ghost");
    assert.equal(await page.getByRole("button", { name: "I have a recovery code" }).count(), 0);
    const join = await page.getByRole("button", { name: `Join ${circle.name}` }).boundingBox();
    const alt = await existing.boundingBox();
    assert.ok(join && alt && alt.y > join.y && alt.y < join.y + join.height + 80, "sits right under the join button");
    await noOverflow(page, "invite welcome");
    await shot(page, "invite-welcome", width, height);

    await existing.click();
    await page.locator("#recover-code").waitFor();
    await page.getByText("Find it in You, Show recovery code, on the phone where you are signed in.").waitFor();
    await page.getByRole("button", { name: `Sign in and join ${circle.name}` }).waitFor();
    await page.getByRole("button", { name: "Back" }).waitFor();
    await noOverflow(page, "recover sheet");
    await page.locator("#recover-code").fill(guest.buzzToken);
    await shot(page, "invite-recover", width, height);

    await page.getByRole("button", { name: `Sign in and join ${circle.name}` }).click();
    await page.locator("nav.tabbar").waitFor();
    await page.waitForTimeout(800);
    assert.equal(new URL(page.url()).pathname, "/", "invite path is cleared, even after the sheet steps Back");
    assert.equal(await page.locator("#name").count(), 0, "not the welcome screen");
    await shot(page, "invite-joined", width, height);

    const me = await meOf(page);
    assert.equal(me.user.id, guest.user.id, "same account");
    assert.equal(me.circle.id, circle.id);
    assert.ok(me.circle.members.some((member: { id: string }) => member.id === guest.user.id), "in the member list");
    assert.equal(userCount(), before, "no new user was created");
    await context.close();
  });
}

test("Back from the recover sheet returns to the invite", { timeout: 60_000 }, async () => {
  const { circle } = await scene();
  const context = await phone(360, 640);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/join/${circle.inviteCode}`);
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await page.locator("#name").waitFor();
  await page.getByRole("button", { name: "I already have an account" }).waitFor();
  await context.close();
});

test("a wrong recovery code on an invite shows the error and stays on the sheet", { timeout: 60_000 }, async () => {
  const { circle } = await scene();
  const before = userCount();
  const context = await phone(360, 640);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/join/${circle.inviteCode}`);
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator("#recover-code").fill("AAAA-BBBB-CCCC");
  await page.getByRole("button", { name: `Sign in and join ${circle.name}` }).click();
  await page.getByText("That code didn't work. Check it and try again.").waitFor();
  assert.equal(await page.locator("#recover-code").count(), 1);
  assert.equal(userCount(), before);
  await context.close();
});

test("a brand-new name on the same invite still creates a fresh account and joins", { timeout: 60_000 }, async () => {
  const { circle } = await scene();
  const before = userCount();
  const context = await phone(360, 640);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/join/${circle.inviteCode}`);
  await page.locator("#name").fill("Fake Newcomer");
  await page.getByRole("button", { name: `Join ${circle.name}` }).click();
  await page.locator("nav.tabbar").waitFor();
  const me = await meOf(page);
  assert.equal(me.user.name, "Fake Newcomer");
  assert.equal(me.circle.id, circle.id);
  assert.equal(userCount(), before + 1, "one new user");
  await context.close();
});

test("a browser that already holds the account joins directly, with no welcome screen", { timeout: 60_000 }, async () => {
  const { circle, guest } = await scene();
  const before = userCount();
  const context = await phone(360, 640, guest.token);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/join/${circle.inviteCode}`);
  await page.locator("nav.tabbar").waitFor();
  assert.equal(await page.getByRole("button", { name: "I already have an account" }).count(), 0);
  const me = await meOf(page);
  assert.equal(me.user.id, guest.user.id);
  assert.equal(me.circle.id, circle.id);
  assert.ok(me.circle.members.some((member: { id: string }) => member.id === guest.user.id));
  assert.equal(userCount(), before);
  await context.close();
});

test("an expired or invalid invite keeps the plain recovery code button", { timeout: 60_000 }, async () => {
  const context = await phone(360, 640);
  const page = await context.newPage();
  await page.goto(`${hangry.baseUrl}/join/ZZZZZZZZ`);
  await page.getByText("This invite isn't valid. Ask for a new link.").waitFor();
  await page.getByRole("button", { name: "I have a recovery code" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "I already have an account" }).count(), 0);
  await context.close();
});
