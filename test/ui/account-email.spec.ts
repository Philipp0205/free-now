import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import type { Page } from "playwright-core";
import { insertUser } from "../../src/db.js";
import { sha256 } from "../../src/lib/auth.js";
import { humanCode } from "../../src/social/code.js";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, testEmail, useHangry } from "./harness.js";

/** Gitignored. Every address and code here is fake, and the recovery code is masked anyway. */
const SHOT_DIR = path.resolve(process.env.ACCOUNT_EMAIL_SHOT_DIR || "test/ui/screenshots/account-email");

const hangry = useHangry();

async function phone(width: number, height: number, token?: string) {
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
    if (value) localStorage.setItem("fn_token", value);
  }, token ?? "");
  await context.route("https://*.tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
  return context;
}

async function shot(page: Page, name: string, width: number, mask: ReturnType<Page["locator"]>[] = []) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForFunction(() => document.getAnimations().every((item) => item.playState !== "running" || item.effect?.getComputedTiming().iterations === Infinity));
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${width}.png`), mask });
}

async function noSideScroll(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 1, `page scrolls sideways by ${wide}px`);
}

/** The newest mailed link of this kind to this address, as a path with its #t= fragment. */
async function mailedLink(to: string, kind: "verify" | "recover"): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const mails = hangry.mail.filter((message) => message.to === to && message.text.includes(`/${kind}#t=`));
    const last = mails[mails.length - 1];
    if (last) {
      const match = new RegExp(`(/${kind}#t=[A-Za-z0-9_-]+)`).exec(last.text);
      assert.ok(match);
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no ${kind} mail to ${to}`);
}

/** An account from before email was required: no email, and its recovery code is its Flic secret. */
function legacySession(): { token: string; name: string } {
  const token = `legacy-session-${humanCode()}-padding`;
  const name = `Fake Old ${humanCode().slice(0, 4)}`;
  insertUser(hangry.db, { id: `legacy-${humanCode()}`, name, token_hash: sha256(token), buzz_token: humanCode(), created_at: 1 });
  return { token, name };
}

for (const [width, height] of SIZES) {
  test(`at ${width}: signing up asks for an email, shows the recovery code once, and the link confirms it`, { timeout: 90_000 }, async () => {
    const email = testEmail();
    const context = await phone(width, height);
    const page = await context.newPage();
    try {
      await page.goto(hangry.baseUrl);
      await page.locator("#name").waitFor();
      const field = page.locator("#email");
      assert.equal(await field.getAttribute("type"), "email");
      assert.equal(await field.getAttribute("autocomplete"), "email");
      await noSideScroll(page);
      await shot(page, "signup-form", width);

      // A malformed address is refused with a plain message, and nothing is created. The browser's own
      // check lets "x@localhost" through (no dot in the domain), so this one reaches the server.
      await page.locator("#name").fill("Fake Ada");
      await page.locator("#email").fill("ada@localhost");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByText("valid email").first().waitFor();
      await shot(page, "signup-bad-email", width);

      await page.locator("#email").fill(email);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.locator("#circle-name").waitFor();

      const card = page.locator(".notice", { hasText: "Save your recovery code" });
      await card.waitFor();
      const code = (await card.locator(".code-block").innerText()).trim();
      assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const banner = page.locator(".notice", { hasText: "Confirm your email" });
      await banner.waitFor();
      assert.ok((await banner.innerText()).includes(email), "the banner names the address");
      for (const button of [card.getByRole("button", { name: "Copy" }), card.getByRole("button", { name: "I saved it" }), banner.getByRole("button", { name: "Resend" })]) {
        const box = await button.boundingBox();
        assert.ok(box && box.height >= 36, "notice buttons are tappable");
      }
      await noSideScroll(page);
      await shot(page, "signup-notices", width, [card.locator(".code-block")]);

      // The code is shown once: dismissing it removes it for good.
      await card.getByRole("button", { name: "I saved it" }).click();
      await card.waitFor({ state: "detached" });

      // The mailed link opens a page that changes nothing until the button is tapped.
      const link = await mailedLink(email, "verify");
      const other = await phone(width, height);
      const linkPage = await other.newPage();
      await linkPage.goto(`${hangry.baseUrl}${link}`);
      await linkPage.getByRole("heading", { name: "Confirm your email" }).waitFor();
      assert.equal(new URL(linkPage.url()).hash, "", "the token is stripped from the address bar");
      await shot(linkPage, "verify-link", width);
      await linkPage.getByRole("button", { name: "Confirm email" }).click();
      await linkPage.getByRole("heading", { name: "Email confirmed." }).waitFor();
      await shot(linkPage, "verify-done", width);

      // The same link a second time is not valid. A fresh page, because /verify#t=... on the page that already
      // stripped its fragment would be a same-document navigation and never reload.
      await linkPage.close();
      const again = await other.newPage();
      await again.goto(`${hangry.baseUrl}${link}`);
      await again.getByRole("button", { name: "Confirm email" }).click();
      await again.getByRole("heading", { name: "Link not valid" }).waitFor();
      await shot(again, "verify-reused", width);
      await other.close();

      // Back on the first phone the banner is gone after the next refresh.
      await page.reload();
      await page.locator("#circle-name").waitFor();
      assert.equal(await page.locator(".notice", { hasText: "Confirm your email" }).count(), 0);
      assert.equal(await page.locator(".notice", { hasText: "Save your recovery code" }).count(), 0, "the code was not kept");
    } finally {
      await context.close();
    }
  });
}

for (const [width, height] of SIZES) {
  test(`at ${width}: an old account without an email sees only the email screen until it adds one`, { timeout: 60_000 }, async () => {
    const old = legacySession();
    const context = await phone(width, height, old.token);
    const page = await context.newPage();
    const requests: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 403) requests.push(new URL(response.url()).pathname);
    });
    try {
      await page.goto(hangry.baseUrl);
      await page.getByRole("heading", { name: "Add your email" }).waitFor();
      assert.equal(await page.locator("nav.tabbar").count(), 0, "no app behind the gate");
      assert.deepEqual(requests, [], "the app does not hammer the API while gated");
      await noSideScroll(page);
      await shot(page, "gate", width);

      await page.locator("#gate-email").fill("nope@localhost");
      await page.getByRole("button", { name: "Save email" }).click();
      await page.getByText("valid email").first().waitFor();
      await shot(page, "gate-bad-email", width);

      const email = testEmail();
      await page.locator("#gate-email").fill(email);
      await page.getByRole("button", { name: "Save email" }).click();
      await page.locator("#circle-name").waitFor();
      await page.locator(".notice", { hasText: "Confirm your email" }).waitFor();
      assert.equal(await page.locator(".notice", { hasText: "Save your recovery code" }).count(), 0, "no new code was made, the old one still works");
      await shot(page, "gate-saved", width);
      await mailedLink(email, "verify");
    } finally {
      await context.close();
    }
  });
}

test("a lost recovery code comes back by email and the old code stops working", { timeout: 90_000 }, async () => {
  const [width, height] = SIZES[1];
  const email = testEmail();
  const ada = await hangry.call("POST", "/api/auth/start", undefined, { name: "Fake Ada", email });
  await hangry.call("POST", "/api/auth/verify", undefined, { token: (await mailedLink(email, "verify")).split("#t=")[1] });

  const context = await phone(width, height);
  const page = await context.newPage();
  try {
    await page.goto(hangry.baseUrl);
    await page.getByRole("button", { name: "I have a recovery code" }).click();
    await page.getByRole("button", { name: "I lost my code" }).click();
    await page.locator("#lost-email").fill(email);
    await shot(page, "lost-code-form", width);
    await page.getByRole("button", { name: "Email me a link" }).click();
    await page.getByText("If that address belongs to an account").waitFor();
    await shot(page, "lost-code-sent", width);

    // An address nobody has gets the very same answer.
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "I lost my code" }).click();
    await page.locator("#lost-email").fill(testEmail());
    await page.getByRole("button", { name: "Email me a link" }).click();
    await page.getByText("If that address belongs to an account").waitFor();

    const link = await mailedLink(email, "recover");
    await page.goto(`${hangry.baseUrl}${link}`);
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    await shot(page, "recover-link", width);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("heading", { name: "You're signed in." }).waitFor();
    await page.getByRole("button", { name: "Open Spontaco" }).click();
    await page.locator("#circle-name").waitFor();

    const card = page.locator(".notice", { hasText: "Save your recovery code" });
    await card.waitFor();
    const fresh = (await card.locator(".code-block").innerText()).trim();
    assert.match(fresh, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.notEqual(fresh, ada.recoveryCode, "a new code, not the lost one");
    await shot(page, "recover-signed-in", width, [card.locator(".code-block")]);

    const old = await fetch(`${hangry.baseUrl}/api/auth/recover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ada.recoveryCode }),
    });
    assert.equal(old.status, 401, "the lost code no longer signs in");
    const again = await fetch(`${hangry.baseUrl}/api/auth/recover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: fresh }),
    });
    assert.equal(again.status, 200);
  } finally {
    await context.close();
  }
});
