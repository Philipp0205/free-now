import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { skipWhatsNew } from "./whats-new-seen.js";
import { SIZES, UA, openYouSection, useHangry } from "./harness.js";

const SHOT_DIR = path.resolve("test/ui/screenshots/agent-api");
const hangry = useHangry();

for (const [width, height] of SIZES) {
  test(`the You tab makes, lists and revokes assistant tokens at ${width}x${height}`, { timeout: 90_000 }, async () => {
    const context = await hangry.browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: UA });
    await skipWhatsNew(context);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: hangry.baseUrl });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.stack || String(error)));
    try {
      await signIn(page, "Marius");
      await openYou(page);
      const panel = page.getByRole("region", { name: "Assistant tokens" });
      await panel.scrollIntoViewIfNeeded();
      assert.equal(await panel.getByRole("heading", { name: "Assistant tokens" }).isVisible(), true);
      const copy = await panel.innerText();
      assert.match(copy, /act as you/);
      assert.match(copy, /read your circles, set your status, create plans and say you are in/);
      assert.match(copy, /Friends see those actions as you/);
      assert.match(copy, /revoke a token at any time and it stops working at once/);
      assert.match(copy, /shown only once/);
      assert.match(copy, /No tokens yet/);
      assert.equal(await panel.getByLabel("Token name").getAttribute("placeholder"), "Grok Bot");
      await shot(page, "empty");

      await panel.getByLabel("Token name").fill("Grok Bot");
      await panel.getByRole("button", { name: "Create token" }).click();
      const secret = panel.locator(".agent-token-secret");
      await secret.waitFor();
      await secret.scrollIntoViewIfNeeded();
      const plain = (await secret.innerText()).trim();
      assert.match(plain, /^hng_/);
      await fitsWidth(page, ".agent-tokens .agent-token-secret");
      await fitsWidth(page, ".agent-tokens");
      assert.match(await panel.innerText(), /will not be shown again/);
      await shot(page, "created-with-secret");

      await panel.getByRole("button", { name: "Copy", exact: true }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), plain);
      const me = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${plain}` } });
      assert.equal(me.status, 200);

      // Leaving the You tab forgets the secret. The list keeps the name and short prefix.
      await page.locator(".tabbar").getByRole("button", { name: "Now", exact: true }).click();
      await openYou(page);
      assert.equal(await panel.locator(".agent-token-secret").count(), 0);
      const row = panel.locator(".agent-token-row");
      assert.equal(await row.count(), 1);
      const rowText = await row.innerText();
      assert.match(rowText, /Grok Bot/);
      assert.ok(rowText.includes(`${plain.slice(0, 8)}…`), "prefix is shown");
      assert.ok(!(await page.content()).includes(plain), "the full token is gone from the page");
      await row.scrollIntoViewIfNeeded();
      await fitsWidth(page, ".agent-token-row");
      await shot(page, "listed");

      await row.getByRole("button", { name: "Revoke Grok Bot" }).click();
      const sheet = page.getByRole("dialog", { name: "Revoke Grok Bot?" });
      await sheet.waitFor();
      await sheet.getByRole("button", { name: "Revoke", exact: true }).click();
      await panel.locator(".agent-token-row").waitFor({ state: "detached" });
      assert.match(await panel.innerText(), /No tokens yet/);
      await panel.scrollIntoViewIfNeeded();
      await shot(page, "after-revoke");
      const after = await fetch(`${hangry.baseUrl}/api/me`, { headers: { authorization: `Bearer ${plain}` } });
      assert.equal(after.status, 401);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

async function fitsWidth(page: Page, selector: string) {
  const width = page.viewportSize()!.width;
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box && box.x >= -0.5 && box.x + box.width <= width + 0.5, `${selector} fits at ${width}: ${JSON.stringify(box)}`);
}

async function openYou(page: Page) {
  await openYouSection(page, "Assistants");
  await page.getByRole("region", { name: "Assistant tokens" }).waitFor();
  await page.getByRole("region", { name: "Assistant tokens" }).getByLabel("Token name").waitFor();
}

/** The token is a secret: it is masked in every screenshot. */
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({
    path: path.join(SHOT_DIR, `${name}-${size.width}x${size.height}.png`),
    mask: [page.locator(".agent-token-secret")],
    maskColor: "#3a3a3c",
  });
}

async function signIn(page: Page, name: string) {
  await page.goto(hangry.baseUrl);
  await page.locator("#name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  const later = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await later.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await page.locator("#circle-name").fill("friends");
  await page.getByRole("button", { name: "Create circle" }).click();
  const again = page.locator(".sheet button.btn.ghost", { hasText: "Not now" });
  if (await again.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await again.click();
  await page.getByRole("button", { name: "Let friends know you're free now" }).waitFor();
}
