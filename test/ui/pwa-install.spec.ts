import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { BrowserContext, Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, openYouSection, useHangry } from "./harness.js";
import { testEmail } from "../http.js";
/** Screenshots land in test/ui/screenshots/pwa-install/ (git-ignored). */
const SHOT_DIR = path.resolve("test/ui/screenshots/pwa-install");
const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
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

let people = 0;
/** A fake person with a circle, made through the real API. */
async function person(): Promise<string> {
  people += 1;
  const me = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: `Fake Ada ${people}` });
  await call("POST", "/api/circles", me.token, { name: "Fake circle" });
  return me.token as string;
}

type PhoneOptions = {
  userAgent?: string;
  token?: string;
  standalone?: boolean;
  /** Skips the blocking notification sheet, like the other specs, so only the banner is in play. */
  later?: boolean;
};

async function phone(width: number, height: number, opts: PhoneOptions = {}): Promise<BrowserContext> {
  const context = await hangry.browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    userAgent: opts.userAgent ?? UA,
  });
  await skipWhatsNew(context);
  await context.addInitScript(({ token, later }) => {
    // Nothing else is written to storage on a reload, so a banner that comes back is not remembered anywhere.
    if (token) localStorage.setItem("fn_token", token);
    if (later) localStorage.setItem("fn_install_later", String(Date.now()));
  }, { token: opts.token ?? "", later: opts.later ?? true });
  if (opts.standalone) await context.addInitScript(STANDALONE);
  return context;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name), mask: [page.locator(".code-block")], maskColor: "#3a3a3c" });
}

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

/** A stand-in for Chrome's beforeinstallprompt; window.prompted counts calls to prompt(). */
async function fireInstallPrompt(page: Page, outcome = "dismissed") {
  await page.evaluate((result) => {
    const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    const w = window as unknown as { prompted?: number };
    w.prompted = w.prompted ?? 0;
    event.prompt = async () => { w.prompted = (w.prompted ?? 0) + 1; };
    event.userChoice = Promise.resolve({ outcome: result });
    window.dispatchEvent(event);
  }, outcome);
}

const prompted = (page: Page) => page.evaluate(() => (window as unknown as { prompted?: number }).prompted ?? 0);
/** The kit's install prompt (AppKit.installPrompt), mounted at the top of the page. */
const bar = (page: Page) => page.locator("#ak-install-prompt");
/** Where the kit remembers a close, in sessionStorage (this tab only). */
const DISMISS_KEY = "hangry-install-prompt-dismissed";

async function signedIn(page: Page) {
  await page.goto(hangry.baseUrl);
  await page.locator("nav.tabbar").waitFor();
}

/** The banner is a card in the page flow: no scrim, inside the viewport, clear of the tab bar, easy to tap. */
async function assertUnobtrusive(page: Page, width: number, height: number) {
  const box = await bar(page).boundingBox();
  const tabs = await page.locator("nav.tabbar").boundingBox();
  assert.ok(box && tabs);
  assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `the banner fits across ${width}`);
  assert.ok(box.height <= 180, `the banner stays compact, got ${box.height}`);
  assert.ok(box.y + box.height <= tabs.y, "the banner does not cover the tab bar");
  assert.ok(box.y + box.height < height / 2, "the banner sits near the top");
  assert.equal(await page.locator(".scrim").count(), 0, "no scrim behind the banner");
  assert.equal(await page.locator(".sheet").count(), 0, "the banner is not a sheet");
  assert.equal(await page.getByText("Install Spontaco as an app").count(), 0, "not the join-install sheet");
  const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  assert.equal(fit.scroll, fit.client, `no horizontal scroll at ${width}`);
  const targets = [bar(page).getByRole("button", { name: "Close install prompt" })];
  // Only the native-prompt variant has an Install button.
  if (await bar(page).getByRole("button", { name: "Install", exact: true }).count()) targets.push(bar(page).getByRole("button", { name: "Install", exact: true }));
  for (const target of targets) {
    const hit = await target.boundingBox();
    assert.ok(hit && hit.height >= 44 && hit.width >= 44, "comfortable tap targets");
  }
}

for (const [width, height] of SIZES) {
  test(`at ${width}: the install banner shows when not installed, closes for this page, and returns on reload`, { timeout: 60_000 }, async () => {
    const token = await person();
    const welcomeContext = await phone(width, height);
    const welcome = await welcomeContext.newPage();
    await welcome.goto(hangry.baseUrl);
    await welcome.locator("#name").waitFor();
    await welcome.waitForTimeout(500);
    assert.equal(await bar(welcome).count(), 0, "no install banner on the welcome screen");
    await welcomeContext.close();

    const context = await phone(width, height, { token });
    const page = await context.newPage();
    const errors = watch(page);
    await signedIn(page);
    await bar(page).waitFor();
    assert.equal(await bar(page).getAttribute("data-variant"), "generic", "no browser prompt yet: a hint, no button");
    assert.equal(await bar(page).getByRole("button", { name: "Install", exact: true }).count(), 0);
    await assertUnobtrusive(page, width, height);
    await shot(page, `banner-hint-w${width}.png`);

    // The browser offers its prompt: the banner gets a native Install button.
    await fireInstallPrompt(page);
    await bar(page).getByRole("button", { name: "Install", exact: true }).waitFor();
    assert.equal(await bar(page).getAttribute("data-variant"), "install");
    await assertUnobtrusive(page, width, height);
    await shot(page, `banner-install-w${width}.png`);

    await bar(page).getByRole("button", { name: "Close install prompt" }).click();
    await bar(page).waitFor({ state: "detached" });
    // A render from other activity must not bring it back during the same page.
    await page.locator(".tabbar").getByRole("button", { name: "Events", exact: true }).click();
    await page.locator(".tabbar").getByRole("button", { name: "Now", exact: true }).click();
    await page.waitForTimeout(500);
    assert.equal(await bar(page).count(), 0, "closed for this page");
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((key) => /install|banner/i.test(key)).sort().join()), "fn_install_later", "closing writes nothing to localStorage");
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), DISMISS_KEY), "1", "the kit remembers the close for this tab only");

    await page.reload();
    await page.locator("nav.tabbar").waitFor();
    await bar(page).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test("the setup screen and the notification sheet do not stack with the install banner", { timeout: 60_000 }, async () => {
  const fresh = await call("POST", "/api/auth/start", undefined, { email: testEmail(), name: "Fake Bea" });
  const setupContext = await phone(360, 640, { token: fresh.token });
  const setup = await setupContext.newPage();
  await setup.goto(hangry.baseUrl);
  await setup.locator("#circle-name").waitFor();
  await setup.waitForTimeout(500);
  assert.equal(await bar(setup).count(), 0, "no banner while the circle setup is showing");
  await setupContext.close();

  const token = await person();
  const context = await phone(360, 640, { token, later: false });
  const page = await context.newPage();
  const errors = watch(page);
  await page.goto(hangry.baseUrl);
  const sheet = page.getByRole("dialog", { name: "Get started" });
  await sheet.waitFor();
  assert.equal(await bar(page).count(), 0, "no banner behind the notification sheet");
  await sheet.getByRole("button", { name: "Not now" }).click();
  await sheet.waitFor({ state: "detached" });
  await bar(page).waitFor();
  assert.equal(await page.getByText("Add to home screen", { exact: true }).count(), 0, "install alone no longer opens the blocking sheet");
  assert.deepEqual(errors, []);
  await context.close();
});

test("the banner stays out of chat and the past list, which are full screens of their own", { timeout: 60_000 }, async () => {
  const token = await person();
  const context = await phone(360, 640, { token });
  const page = await context.newPage();
  const errors = watch(page);
  await signedIn(page);
  await bar(page).waitFor();
  await page.locator(".tabbar").getByRole("button", { name: /^Chat/ }).click();
  await page.locator(".chat-head, .chat-log").first().waitFor();
  await bar(page).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Back", exact: true }).first().click();
  await page.locator("nav.tabbar").waitFor();
  await bar(page).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("with the browser prompt ready, the Account row and the banner both call prompt()", { timeout: 60_000 }, async () => {
  const token = await person();
  const context = await phone(360, 640, { token });
  const page = await context.newPage();
  const errors = watch(page);
  await signedIn(page);
  await bar(page).waitFor();

  await fireInstallPrompt(page);
  await openYouSection(page, "Account");
  const row = page.locator("button.install-row");
  await row.waitFor();
  assert.equal(await row.isDisabled(), false);
  assert.match(await row.innerText(), /Install app/);
  await shot(page, "account-row-w360.png");
  await row.click();
  await page.waitForFunction(() => (window as unknown as { prompted?: number }).prompted === 1);
  assert.equal(await page.locator(".sheet").count(), 0, "the native prompt replaces the steps sheet");

  // The browser may offer the prompt again; the banner's Install does the same thing.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("heading", { name: "You", exact: true, level: 1 }).waitFor();
  await page.locator(".tabbar").getByRole("button", { name: "Now", exact: true }).click();
  await fireInstallPrompt(page, "accepted");
  await bar(page).getByRole("button", { name: "Install", exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { prompted?: number }).prompted === 2);
  assert.equal(await page.locator(".sheet").count(), 0);
  // Accepting installs it: the banner goes and the row reads Installed.
  await bar(page).waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => localStorage.getItem("fn_installed")), "1");
  await openYouSection(page, "Account");
  assert.equal(await page.locator("button.install-row").isDisabled(), true);
  assert.match(await page.locator("button.install-row").innerText(), /Installed/);
  assert.equal(await prompted(page), 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test("iPhone Safari has no prompt: the banner shows the Share steps and the row opens the steps sheet", { timeout: 60_000 }, async () => {
  const token = await person();
  const context = await phone(360, 640, { token, userAgent: IOS_SAFARI });
  const page = await context.newPage();
  const errors = watch(page);
  await signedIn(page);
  await bar(page).waitFor();

  assert.equal(await bar(page).getAttribute("data-variant"), "ios");
  assert.equal(await bar(page).getByRole("button", { name: "Install", exact: true }).count(), 0, "no fake install button without a prompt");
  const inline = await bar(page).locator(".ak-ip-steps li").allInnerTexts();
  assert.equal(inline.length, 2);
  assert.match(inline[0], /Tap Share/);
  assert.match(inline[1], /Add to Home Screen/);
  await assertUnobtrusive(page, 360, 640);
  await shot(page, "ios-banner-w360.png");

  const dialog = page.getByRole("dialog", { name: "Install Spontaco" });
  await openYouSection(page, "Account");
  await page.locator("button.install-row").click();
  await dialog.waitFor();
  assert.equal(await bar(page).count(), 0, "the banner steps aside while the steps are open");
  const rowSteps = (await dialog.locator(".guide-steps li").allInnerTexts()).join(" ").replace(/\s+/g, " ");
  assert.match(rowSteps, /Share button.*Add to Home Screen/);
  assert.equal(await dialog.getByRole("button", { name: "Install app" }).count(), 0);
  const box = await dialog.getByRole("button", { name: "Close" }).boundingBox();
  assert.ok(box && box.y + box.height <= 640 + 0.5 && box.height >= 44, "Close is on screen and easy to tap");
  await shot(page, "ios-steps-row-w360.png");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await bar(page).waitFor();
  assert.equal(await prompted(page), 0, "no prompt() was ever called");
  assert.deepEqual(errors, []);
  await context.close();
});

test("an Android browser without a prompt gets the menu steps from the Account row", { timeout: 60_000 }, async () => {
  const token = await person();
  const context = await phone(360, 640, { token });
  const page = await context.newPage();
  const errors = watch(page);
  await signedIn(page);
  await openYouSection(page, "Account");
  await page.locator("button.install-row").click();
  const dialog = page.getByRole("dialog", { name: "Install Spontaco" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Open the browser menu/);
  assert.match(await dialog.innerText(), /Install app or Add to Home screen/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("installed (standalone): no install banner, and the Account row reads Installed and is disabled", { timeout: 60_000 }, async () => {
  const token = await person();
  const context = await phone(360, 640, { token, standalone: true });
  const page = await context.newPage();
  const errors = watch(page);
  await signedIn(page);
  assert.equal(await page.evaluate(() => window.matchMedia("(display-mode: standalone)").matches), true);
  await page.waitForTimeout(900);
  assert.equal(await bar(page).count(), 0, "the installed app does not ask to install itself");
  await fireInstallPrompt(page);
  await page.waitForTimeout(300);
  assert.equal(await bar(page).count(), 0, "not even when the browser offers a prompt");

  await openYouSection(page, "Account");
  const row = page.locator("button.install-row");
  await row.waitFor();
  assert.equal(await row.isDisabled(), true);
  assert.match(await row.innerText(), /Installed/);
  await shot(page, "installed-w360.png");
  await row.click({ force: true }).catch(() => {});
  assert.equal(await page.locator(".sheet").count(), 0);
  assert.equal(await prompted(page), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("at 1280: the banner stays a compact card on the desktop layout", { timeout: 60_000 }, async () => {
  const token = await person();
  const context = await hangry.browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: UA });
  await skipWhatsNew(context);
  await context.addInitScript((value) => {
    localStorage.setItem("fn_token", value);
    localStorage.setItem("fn_install_later", String(Date.now()));
  }, token);
  const page = await context.newPage();
  const errors = watch(page);
  await signedIn(page);
  await bar(page).waitFor();
  const box = await bar(page).boundingBox();
  assert.ok(box && box.width <= 608 && box.height <= 180, "a capped card, not full width");
  assert.equal(await page.locator(".scrim").count(), 0);
  await shot(page, "banner-w1280.png");
  assert.deepEqual(errors, []);
  await context.close();
});
