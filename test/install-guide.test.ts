import assert from "node:assert/strict";
import test from "node:test";
import { installGuide, readInstallSignals } from "../public/install-guide.js";

const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IOS_INSTAGRAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0.0";
const IOS_WHATSAPP = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/2.24.0";
const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.0.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const ANDROID_FIREFOX = "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0";
const ANDROID_DUCK = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile DuckDuckGo/5 Safari/537.36";
const ANDROID_SAMSUNG = "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36";
const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36";

function guideFor(userAgent: string, extra: Record<string, unknown> = {}) {
  return installGuide(readInstallSignals({ userAgent, notificationPermission: "default", ...extra }));
}

function flat(guide: ReturnType<typeof installGuide>): string {
  return [
    guide.headline,
    guide.lede,
    ...guide.groups.flatMap((group) => [
      group.label ?? "",
      group.note,
      ...group.reenable,
      ...group.steps.flatMap((step) => [step.title, step.detail]),
    ]),
  ].join("\n");
}

test("iPhone Safari is told to add Hangry to the Home Screen before allowing notifications", () => {
  const guide = guideFor(IOS_SAFARI);
  const text = flat(guide);
  assert.equal(guide.platform, "ios");
  assert.equal(guide.status, "install");
  assert.match(text, /Share button, then Add to Home Screen/);
  assert.match(text, /Open the home-screen icon/);
  assert.match(text, /Enable notifications/);
  assert.match(text, /Tap Allow/);
  assert.match(text, /do not work in a Safari tab/);
  assert.match(text, /Instagram or WhatsApp/);
  assert.match(text, /iOS 16\.4/);
  assert.equal(guide.groups[0].steps[0].done, true);
  assert.equal(guide.groups[0].steps[1].done, false);
});

test("iPhone in-app browsers are sent to Safari first", () => {
  for (const userAgent of [IOS_INSTAGRAM, IOS_WHATSAPP, IOS_CHROME]) {
    const guide = guideFor(userAgent);
    assert.equal(guide.status, "wrong-browser");
    const text = flat(guide);
    assert.match(text, /Open this page in Safari first/);
    assert.match(text, /Instagram or WhatsApp|Instagram, WhatsApp/);
    assert.equal(guide.groups[0].steps[0].done, false);
  }
});

test("an installed iPhone with permission granted shows Notifications on", () => {
  const guide = guideFor(IOS_SAFARI, { standalone: true, notificationPermission: "granted" });
  assert.equal(guide.status, "on");
  assert.equal(guide.headline, "Notifications on");
});

test("a denied iPhone is shown the Settings path", () => {
  const guide = guideFor(IOS_SAFARI, { standalone: true, notificationPermission: "denied" });
  assert.equal(guide.status, "denied");
  const text = flat(guide);
  assert.match(text, /Settings/);
  assert.match(text, /Notifications → Hangry/);
  assert.match(text, /Allow Notifications/);
});

test("Android Chrome gets the install prompt and the battery hint", () => {
  const guide = guideFor(ANDROID_CHROME);
  const text = flat(guide);
  assert.equal(guide.platform, "android");
  assert.equal(guide.status, "install");
  assert.match(text, /three-dot menu ⋮/);
  assert.match(text, /Install app or Add to Home screen/);
  assert.match(text, /Enable notifications/);
  assert.match(text, /Tap Allow/);
  assert.match(text, /notification permission/);
  assert.match(text, /Unrestricted/);
  assert.match(text, /Battery/);
});

test("Android Firefox and other non-installable browsers are sent to Chrome", () => {
  for (const userAgent of [ANDROID_FIREFOX, ANDROID_DUCK]) {
    const guide = guideFor(userAgent);
    assert.equal(guide.status, "wrong-browser");
    assert.equal(guide.offerCopyLink, true);
    assert.match(flat(guide), /For notifications, open Hangry in Chrome and tap Install app/);
  }
  const shortcut = guideFor(ANDROID_FIREFOX, { standalone: true, notificationPermission: "granted" });
  assert.equal(shortcut.status, "wrong-browser");
  assert.equal(guideFor(ANDROID_SAMSUNG).status, "install");
});

test("Android in-app browsers are sent to Chrome", () => {
  const guide = guideFor(ANDROID_WEBVIEW);
  assert.equal(guide.status, "wrong-browser");
  assert.match(flat(guide), /Open this page in Chrome/);
});

test("an installed Android phone with permission granted shows Notifications on", () => {
  const guide = guideFor(ANDROID_CHROME, { standalone: true, notificationPermission: "granted" });
  assert.equal(guide.status, "on");
  assert.equal(guide.headline, "Notifications on");
  assert.match(flat(guide), /battery use to Unrestricted/);
});

test("a denied Android phone is shown site permission and battery steps", () => {
  const guide = guideFor(ANDROID_CHROME, { notificationPermission: "denied" });
  assert.equal(guide.status, "denied");
  const text = flat(guide);
  assert.match(text, /Site settings → Notifications/);
  assert.match(text, /Apps → Hangry → Notifications/);
  assert.match(text, /Battery, choose Unrestricted/);
});

test("a desktop browser shows both phone guides", () => {
  const guide = guideFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
  assert.equal(guide.platform, "other");
  assert.deepEqual(guide.groups.map((group) => group.label), ["iPhone", "Android"]);
  assert.match(flat(guide), /Add to Home Screen/);
  assert.match(flat(guide), /Install app or Add to Home screen/);
});
