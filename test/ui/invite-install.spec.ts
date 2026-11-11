import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { BrowserContext, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, useHangry } from "./harness.js";

/** Screenshots land in test/ui/screenshots/invite-install/ (git-ignored); INVITE_INSTALL_SHOT_DIR overrides. */
const SHOT_DIR = path.resolve(process.env.INVITE_INSTALL_SHOT_DIR || "test/ui/screenshots/invite-install");
/** Copies for the issue thread, when that folder exists on this box. */
const ISSUE_DIR = "/workspace/hangry-issues";

const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.0.0 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI = "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const TITLE = "Install Hangry as an app";
const STANDALONE = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = function (query) {
    if (/display-mode:\\s*standalone/.test(query)) {
      return { matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
    }
    return real(query);
  };
  Object.defineProperty(navigator, "standalone", { get() { return true; } });
})();`;

const hangry = useHangry();
const { call } = hangry;

type Person = { token: string; circle?: { id: string; inviteCode: string } };

let hosts = 0;
/** A fake host with a fresh circle, made through the real API. */
async function hostCircle(name = "Fake circle") {
  hosts += 1;
  const host: Person = await call("POST", "/api/auth/start", undefined, { name: `Host ${hosts}` });
  const { circle } = await call("POST", "/api/circles", host.token, { name });
  return { host, circle: circle as { id: string; inviteCode: string } };
}

type PhoneOptions = { userAgent?: string; token?: string; standalone?: boolean; mobile?: boolean };

async function phone(width: number, height: number, opts: PhoneOptions = {}): Promise<BrowserContext> {
  const mobile = opts.mobile ?? width < 900;
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: opts.userAgent ?? UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript(({ token }) => {
    if (token && !sessionStorage.getItem("seeded")) {
      localStorage.setItem("fn_token", token);
      sessionStorage.setItem("seeded", "1");
    }
  }, { token: opts.token ?? "" });
  // Headless Chrome has no switch for display-mode, so an installed app is faked through matchMedia and
  // navigator.standalone, the same two signals isInstalled() reads. A string, so tsx adds no __name helper.
  if (opts.standalone) await context.addInitScript(STANDALONE);
  return context;
}

async function shot(page: Page, name: string, issueName = "") {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, name);
  // The invite code on the Circle tab is masked, like the calendar specs mask the feed URL.
  await page.screenshot({ path: file, mask: [page.locator(".code-block")], maskColor: "#3a3a3c" });
  if (issueName && fs.existsSync(ISSUE_DIR)) fs.copyFileSync(file, path.join(ISSUE_DIR, issueName));
}

async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const sheet = document.querySelector(".join-install")?.getBoundingClientRect();
    return {
      scroll: doc.scrollWidth,
      client: doc.clientWidth,
      sheetLeft: sheet?.left ?? 0,
      sheetRight: sheet?.right ?? 0,
      sheetTop: sheet?.top ?? 0,
    };
  });
}

/** New account through the invite link: name, then the Join button on the welcome screen. */
async function joinAsNew(page: Page, code: string, name: string) {
  await page.goto(`${hangry.baseUrl}/join/${code}`);
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: /^Join / }).click();
  await page.locator("nav.tabbar").waitFor();
}

function joinSheet(page: Page) {
  return page.getByRole("dialog", { name: TITLE });
}

/** Nothing about installing after a short settle, so a late render would still be caught. */
async function noJoinSheet(page: Page, why: string) {
  await page.waitForTimeout(900);
  assert.equal(await page.locator(".join-install").count(), 0, why);
  assert.equal(await page.getByText(TITLE).count(), 0, why);
}

for (const [width, height] of SIZES) {
  test(`at ${width}: a new iPhone user who joins from an invite sees Share and Add to Home Screen, once`, { timeout: 60_000 }, async () => {
    const { circle } = await hostCircle();
    const context = await phone(width, height, { userAgent: IOS_SAFARI });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await joinAsNew(page, circle.inviteCode, "Fake Ivy");
    const sheet = joinSheet(page);
    await sheet.waitFor();
    assert.equal(await page.locator(".sheet").count(), 1, "one sheet, not the install step stacked on the usual reminder");
    const text = await sheet.innerText();
    assert.match(text, /notifications only work from there/);
    const steps = await sheet.locator(".guide-steps li").allInnerTexts();
    assert.equal(steps.length, 3);
    assert.match(steps[0], /Tap the Share button/);
    assert.match(steps[1], /Tap Add to Home Screen/);
    assert.match(steps[2], /Open Hangry from the icon/);
    assert.equal(await sheet.getByRole("button", { name: "Install app" }).count(), 0, "no fake install button on iPhone");
    const later = sheet.getByRole("button", { name: "Not now" });
    const box = await later.boundingBox();
    assert.ok(box && box.y + box.height <= height + 0.5, `Not now is on screen at ${width}`);
    assert.ok(box!.height >= 44, "Not now is a comfortable tap target");
    const fit = await overflow(page);
    assert.equal(fit.scroll, fit.client, `no horizontal scroll at ${width}`);
    assert.ok(fit.sheetLeft >= 0 && fit.sheetRight <= width + 0.5 && fit.sheetTop >= 0, `the sheet fits at ${width}`);
    assert.doesNotMatch(await page.locator("body").innerText(), new RegExp(circle.inviteCode), "no invite code on screen");
    await shot(page, `ios-w${width}.png`, width === 360 ? "87-invite-install-ios-360.png" : "");

    await later.click();
    await page.locator(".join-install").waitFor({ state: "detached" });
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".sheet").count(), 0, "Not now does not swap in another sheet");
    assert.equal(await page.evaluate(() => localStorage.getItem("fn_join_install_done")), "1");
    await page.reload();
    await page.locator("nav.tabbar").waitFor();
    await noJoinSheet(page, "the post-join step stays closed after a reload");
    assert.equal(await page.locator(".sheet").count(), 0, "no install nag on the next start either");
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test("a signed-in Android user opening an invite link is auto-joined and the Install button uses the browser prompt", { timeout: 60_000 }, async () => {
  const { circle } = await hostCircle("Fake dinner club");
  const me: Person = await call("POST", "/api/auth/start", undefined, { name: "Fake Remi" });
  await call("POST", "/api/circles", me.token, { name: "Fake home" });
  const context = await phone(360, 640, { token: me.token });
  await context.addInitScript(() => {
    localStorage.setItem("fn_install_later", String(Date.now()));
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${hangry.baseUrl}/join/${circle.inviteCode}`);
  await page.locator("nav.tabbar").waitFor();
  assert.equal(new URL(page.url()).pathname, "/", "the invite path is cleared after joining");
  const sheet = joinSheet(page);
  await sheet.waitFor();
  const steps = await sheet.locator(".guide-steps li").allInnerTexts();
  assert.match(steps.join(" "), /three-dot menu/);
  assert.match(steps.join(" "), /Install app or Add to Home screen/);
  assert.equal(await sheet.getByRole("button", { name: "Install app" }).count(), 0, "no Install button until Chrome offers its prompt");

  // A stand-in for Chrome's beforeinstallprompt, so the test can see the button call prompt().
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    (window as unknown as { prompted: number }).prompted = 0;
    event.prompt = async () => { (window as unknown as { prompted: number }).prompted += 1; };
    event.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(event);
  });
  const install = sheet.getByRole("button", { name: "Install app" });
  await install.waitFor();
  assert.equal(await sheet.locator(".guide-steps li").count(), 0, "with the prompt ready, one button replaces the menu steps");
  assert.ok(await sheet.getByRole("button", { name: "Not now" }).isVisible());
  const fit = await overflow(page);
  assert.equal(fit.scroll, fit.client);
  await shot(page, "android-prompt-w360.png", "87-invite-install-android-360.png");
  await install.click();
  await page.locator(".join-install").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => (window as unknown as { prompted: number }).prompted), 1, "Install app opened the browser prompt");
  assert.equal(await page.evaluate(() => localStorage.getItem("fn_installed")), "1");
  assert.deepEqual(errors, []);
  await context.close();
});

test("joining from the Circle tab shows the Android menu steps; the host who made a circle never sees them", { timeout: 60_000 }, async () => {
  const { circle } = await hostCircle("Fake climbing");
  const context = await phone(360, 640);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(hangry.baseUrl);
  await page.locator("#name").fill("Fake Noor");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#circle-name").fill("Fake own circle");
  await page.getByRole("button", { name: "Create circle" }).click();
  await page.locator("nav.tabbar").waitFor();
  await noJoinSheet(page, "creating a circle is not joining one");
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.count()) await later.click();

  await page.getByRole("button", { name: "Circle", exact: true }).click();
  await page.getByRole("button", { name: "Join with link" }).first().click();
  await page.locator("#invite-code").fill(circle.inviteCode);
  await page.getByRole("button", { name: "Join circle" }).click();
  const sheet = joinSheet(page);
  await sheet.waitFor();
  assert.equal(await page.locator(".sheet").count(), 1);
  const steps = await sheet.locator(".guide-steps li").allInnerTexts();
  assert.equal(steps.length, 3);
  assert.match(steps[0], /three-dot menu/);
  assert.match(steps[1], /Install app or Add to Home screen/);
  await shot(page, "android-menu-w360.png");

  // Escape closes it like any other sheet, and it is remembered.
  await page.keyboard.press("Escape");
  await page.locator(".join-install").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => localStorage.getItem("fn_join_install_done")), "1");
  const again = await hostCircle("Fake book club");
  await page.getByRole("button", { name: "Join with link" }).first().click();
  await page.locator("#invite-code").fill(again.circle.inviteCode);
  await page.getByRole("button", { name: "Join circle" }).click();
  await page.getByRole("button", { name: "Join circle" }).waitFor({ state: "detached" });
  await noJoinSheet(page, "a second join after Not now does not ask again");
  assert.deepEqual(errors, []);
  await context.close();
});

test("a join that is left open is not brought back on the next start", { timeout: 60_000 }, async () => {
  const { circle } = await hostCircle();
  const context = await phone(360, 640, { userAgent: IOS_SAFARI });
  await context.addInitScript(() => {
    localStorage.setItem("fn_install_later", String(Date.now()));
  });
  const page = await context.newPage();
  await joinAsNew(page, circle.inviteCode, "Fake Ola");
  await joinSheet(page).waitFor();
  await page.reload();
  await page.locator("nav.tabbar").waitFor();
  await noJoinSheet(page, "only right after a join, never on a plain start");
  await context.close();
});

test("iPhone Chrome is sent to Safari first, with a Copy link button", { timeout: 60_000 }, async () => {
  const { circle } = await hostCircle();
  const context = await phone(360, 640, { userAgent: IOS_CHROME });
  const page = await context.newPage();
  await joinAsNew(page, circle.inviteCode, "Fake Pia");
  const sheet = joinSheet(page);
  await sheet.waitFor();
  assert.match(await sheet.innerText(), /Open this page in Safari first/);
  assert.match((await sheet.locator(".guide-steps li").allInnerTexts()).join(" "), /Share, then Add to Home Screen/);
  await sheet.getByRole("button", { name: "Copy link" }).waitFor();
  await sheet.getByRole("button", { name: "Not now" }).waitFor();
  await context.close();
});

for (const [label, userAgent] of [["iPhone", IOS_SAFARI], ["Android", UA]] as const) {
  test(`already installed on ${label}: no install step after joining`, { timeout: 60_000 }, async () => {
    const { circle } = await hostCircle();
    const context = await phone(360, 640, { userAgent, standalone: true });
    const page = await context.newPage();
    await joinAsNew(page, circle.inviteCode, "Fake Uli");
    assert.equal(await page.evaluate(() => window.matchMedia("(display-mode: standalone)").matches), true);
    await noJoinSheet(page, "the home-screen app does not ask to install itself");
    await context.close();
  });
}

test("at 1280: an iPad gets the same centred sheet, a desktop browser stays quiet", { timeout: 60_000 }, async () => {
  const { circle } = await hostCircle();
  const ipad = await phone(1280, 800, { userAgent: IPAD_SAFARI, mobile: false });
  const page = await ipad.newPage();
  await joinAsNew(page, circle.inviteCode, "Fake Kai");
  const sheet = joinSheet(page);
  await sheet.waitFor();
  assert.match((await sheet.locator(".guide-steps li").allInnerTexts()).join(" "), /Add to Home Screen/);
  const fit = await overflow(page);
  assert.equal(fit.scroll, fit.client);
  assert.ok(Math.abs((fit.sheetLeft + fit.sheetRight) / 2 - 640) <= 1, "the sheet is centred");
  assert.ok(fit.sheetRight - fit.sheetLeft < 1280, "the sheet keeps the phone width");
  await shot(page, "ipad-w1280.png", "87-invite-install-1280.png");
  await ipad.close();

  const desktop = await phone(1280, 800, { userAgent: DESKTOP });
  const deskPage = await desktop.newPage();
  await joinAsNew(deskPage, circle.inviteCode, "Fake Lev");
  await noJoinSheet(deskPage, "a computer is not asked to install");
  await desktop.close();
});
