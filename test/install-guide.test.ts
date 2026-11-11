import assert from "node:assert/strict";
import test from "node:test";
import { installGuide, installPrompt, joinInstallStep, installReminderDue, needsInstallForPush, pushReminder, pushTestMessage, readInstallSignals } from "../public/install-guide.js";

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

test("Android Firefox gets its own install steps and is not sent to Chrome", () => {
  const signals = readInstallSignals({ userAgent: ANDROID_FIREFOX, notificationPermission: "default" });
  assert.equal(signals.browser, "firefox");
  assert.equal(signals.canInstall, true);
  const guide = installGuide(signals);
  const text = flat(guide);
  assert.equal(guide.status, "install");
  assert.equal(guide.offerCopyLink, undefined);
  assert.match(text, /Open the menu ⋮, tap Install/);
  assert.match(text, /Add to Home screen/);
  assert.match(text, /confirm/i);
  assert.doesNotMatch(text, /open Hangry in Chrome/i);
  assert.doesNotMatch(text, /Copy link/);
  const fennec = guideFor("Mozilla/5.0 (Android 14; Mobile; rv:68.0) Gecko/68.0 Fennec/68.0");
  assert.equal(fennec.status, "install");
  assert.match(flat(fennec), /tap Install/);
  const installed = guideFor(ANDROID_FIREFOX, { standalone: true, notificationPermission: "granted" });
  assert.equal(installed.status, "on");
  const denied = guideFor(ANDROID_FIREFOX, { notificationPermission: "denied" });
  assert.equal(denied.status, "denied");
  assert.match(flat(denied), /In Firefox/);
  assert.doesNotMatch(flat(denied), /In Chrome/);
});

test("browsers that cannot install are still sent to Chrome", () => {
  const duck = guideFor(ANDROID_DUCK);
  assert.equal(duck.status, "wrong-browser");
  assert.equal(duck.offerCopyLink, true);
  assert.match(flat(duck), /For notifications, open Hangry in Chrome and tap Install app/);
  const focus = guideFor("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Focus/126.0 Chrome/126.0.0.0 Mobile Safari/537.36");
  assert.equal(focus.status, "wrong-browser");
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

test("a signed-in phone is reminded until this device is subscribed", () => {
  const desktop = readInstallSignals({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    notificationPermission: "default",
  });
  const ask = pushReminder(desktop, { hasSubscription: false, serverKnows: false });
  assert.equal(ask?.kind, "enable");
  assert.equal(ask?.title, "Turn on notifications");

  const granted = readInstallSignals({
    userAgent: ANDROID_CHROME,
    notificationPermission: "granted",
    standalone: true,
  });
  assert.equal(pushReminder(granted, { hasSubscription: true, serverKnows: true }), null);
  assert.equal(pushReminder(granted, { hasSubscription: true, serverKnows: false })?.kind, "enable");
  assert.equal(pushReminder(granted, { hasSubscription: false, serverKnows: false })?.kind, "enable");

  const iosDenied = pushReminder(readInstallSignals({
    userAgent: IOS_SAFARI,
    notificationPermission: "denied",
    standalone: true,
  }));
  assert.equal(iosDenied?.kind, "denied");
  assert.match(iosDenied?.steps.join(" ") ?? "", /iPhone Settings → Notifications → Hangry/);

  const androidDenied = pushReminder(readInstallSignals({
    userAgent: ANDROID_CHROME,
    notificationPermission: "denied",
  }));
  assert.equal(androidDenied?.kind, "denied");
  assert.match(androidDenied?.steps.join(" ") ?? "", /Apps → Hangry → Notifications/);
  assert.match(androidDenied?.steps.join(" ") ?? "", /Unrestricted/);

  const iosTab = pushReminder(readInstallSignals({
    userAgent: IOS_SAFARI,
    notificationPermission: "default",
    standalone: false,
  }));
  assert.equal(iosTab?.kind, "guide");
  assert.match(iosTab?.lede ?? "", /Home Screen app/);

  const firefox = pushReminder(readInstallSignals({
    userAgent: ANDROID_FIREFOX,
    notificationPermission: "default",
  }));
  assert.equal(firefox?.kind, "enable");
  assert.doesNotMatch(firefox?.lede ?? "", /Chrome/);
  const duckReminder = pushReminder(readInstallSignals({
    userAgent: ANDROID_DUCK,
    notificationPermission: "default",
  }));
  assert.equal(duckReminder?.kind, "guide");
  assert.match(duckReminder?.lede ?? "", /open Hangry in Chrome and tap Install app/);

  assert.equal(pushTestMessage(0), "0 devices subscribed, turn on notifications first");
  assert.equal(pushTestMessage(1), "Test sent to 1 device");
  assert.equal(pushTestMessage(2), "Test sent to 2 devices");
});

test("install reminders depend on the browser and how long ago Not now was", () => {
  const ios = readInstallSignals({ userAgent: IOS_SAFARI, notificationPermission: "default" });
  const iosSheet = installPrompt(ios);
  assert.equal(iosSheet.kind, "ios");
  assert.match(iosSheet.steps.join(" "), /Share button/);
  assert.match(iosSheet.steps.join(" "), /Add to Home Screen/);
  assert.equal(iosSheet.offerInstall, false);
  assert.equal(needsInstallForPush(ios), true);
  assert.equal(needsInstallForPush(readInstallSignals({ userAgent: IOS_SAFARI, standalone: true })), false);

  const chrome = readInstallSignals({ userAgent: ANDROID_CHROME, notificationPermission: "default" });
  assert.equal(installPrompt(chrome, { canPrompt: true }).offerInstall, true);
  assert.equal(installPrompt(chrome, { canPrompt: true }).kind, "native");
  assert.equal(needsInstallForPush(chrome), false);

  const firefox = installPrompt(readInstallSignals({ userAgent: ANDROID_FIREFOX, notificationPermission: "default" }));
  assert.equal(firefox.kind, "firefox");
  assert.equal(firefox.copyLink, false);
  assert.equal(firefox.quiet, undefined);
  assert.match(firefox.steps.join(" "), /Open the menu ⋮/);
  assert.match(firefox.steps.join(" "), /Tap Install/);
  assert.match(firefox.steps.join(" "), /Add to Home screen/);
  assert.doesNotMatch(firefox.lede, /Chrome/);
  assert.equal(needsInstallForPush(readInstallSignals({ userAgent: ANDROID_FIREFOX })), false);
  const duckSheet = installPrompt(readInstallSignals({ userAgent: ANDROID_DUCK }));
  assert.equal(duckSheet.copyLink, true);
  assert.match(duckSheet.lede, /open Hangry in Chrome and tap Install app/);
  const desktop = installPrompt(readInstallSignals({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    notificationPermission: "default",
  }));
  assert.equal(desktop.kind, "desktop");
  assert.equal(desktop.quiet, true);

  const now = Date.parse("2026-11-03T00:00:00Z");
  assert.equal(installReminderDue(null, now), true);
  assert.equal(installReminderDue(String(now - 1000), now), false);
  assert.equal(installReminderDue(String(now - 3 * 24 * 60 * 60 * 1000), now), true);
});

test("a desktop browser shows both phone guides", () => {
  const guide = guideFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
  assert.equal(guide.platform, "other");
  assert.deepEqual(guide.groups.map((group) => group.label), ["iPhone", "Android"]);
  assert.match(flat(guide), /Add to Home Screen/);
  assert.match(flat(guide), /Install app or Add to Home screen/);
});

test("the post-join install step uses the same steps per browser and skips installed or desktop", () => {
  const signals = (userAgent: string, extra: Record<string, unknown> = {}) => readInstallSignals({ userAgent, notificationPermission: "default", ...extra });

  const ios = joinInstallStep(signals(IOS_SAFARI));
  assert.equal(ios?.title, "Install Hangry as an app");
  assert.equal(ios?.kind, "ios");
  assert.deepEqual(ios?.steps, installPrompt(signals(IOS_SAFARI)).steps);
  assert.match(ios?.steps.join(" ") ?? "", /Share button.*Add to Home Screen/);
  assert.match(ios?.lede ?? "", /notifications only work from there/);
  assert.equal(ios?.offerInstall, false);

  for (const userAgent of [IOS_CHROME, IOS_INSTAGRAM]) {
    const other = joinInstallStep(signals(userAgent));
    assert.equal(other?.kind, "ios-other");
    assert.match(other?.lede ?? "", /Open this page in Safari first/);
    assert.match(other?.steps.join(" ") ?? "", /Share, then Add to Home Screen/);
    assert.equal(other?.copyLink, true);
  }

  const prompted = joinInstallStep(signals(ANDROID_CHROME), { canPrompt: true });
  assert.equal(prompted?.kind, "native");
  assert.equal(prompted?.offerInstall, true);
  assert.deepEqual(prompted?.steps, []);
  const menu = joinInstallStep(signals(ANDROID_CHROME));
  assert.equal(menu?.offerInstall, false);
  assert.match(menu?.steps.join(" ") ?? "", /three-dot menu ⋮/);
  assert.match(menu?.steps.join(" ") ?? "", /Install app or Add to Home screen/);

  assert.equal(joinInstallStep(signals(ANDROID_FIREFOX))?.kind, "firefox");
  for (const userAgent of [ANDROID_DUCK, ANDROID_WEBVIEW]) {
    const off = joinInstallStep(signals(userAgent));
    assert.equal(off?.kind, "unsupported");
    assert.match(off?.lede ?? "", /Open this page in Chrome/);
    assert.equal(off?.copyLink, true);
  }

  assert.equal(joinInstallStep(signals(IOS_SAFARI, { standalone: true })), null);
  assert.equal(joinInstallStep(signals(ANDROID_CHROME, { standalone: true }), { canPrompt: true }), null);
  assert.equal(joinInstallStep(signals("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")), null);
  for (const step of [ios, menu, prompted]) {
    for (const line of [step?.title ?? "", step?.lede ?? "", ...(step?.steps ?? [])]) assert.ok(!line.includes("\u2014"), line);
  }
});
