/**
 * Pure install-guide copy. The page passes in what it detected;
 * this file does not touch window, so the steps can be tested.
 */

export function readInstallSignals({
  userAgent = "",
  platform = "",
  maxTouchPoints = 0,
  standalone = false,
  notificationPermission = "unsupported",
} = {}) {
  const ios = /iphone|ipad|ipod/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  const android = /android/i.test(userAgent);
  const inApp = /Instagram|FBAN|FBAV|FB_IAB|WhatsApp|Line\/|MicroMessenger|Snapchat|Twitter/i.test(userAgent)
    || /; wv\)/.test(userAgent);
  const iosOtherBrowser = ios && /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(userAgent);
  const safari = ios && !inApp && !iosOtherBrowser && /Safari/i.test(userAgent);
  let kind = "other";
  if (ios) kind = "ios";
  else if (android) kind = "android";
  return {
    platform: kind,
    inApp,
    safari,
    canInstall: !android || androidCanInstall(userAgent),
    standalone: Boolean(standalone),
    permission: notificationPermission,
  };
}

function androidCanInstall(userAgent) {
  if (/Firefox|Fennec|Focus\/|Klar\//i.test(userAgent)) return false;
  if (/DuckDuckGo|UCBrowser|Opera Mini|MiuiBrowser/i.test(userAgent)) return false;
  if (/; wv\)/.test(userAgent)) return false;
  return /Chrome\/|Chromium\/|EdgA\/|Edg\/|SamsungBrowser|OPR\/|Brave|Vivaldi/i.test(userAgent);
}

export function installGuide(signals) {
  if (signals.platform === "ios") return iosGuide(signals);
  if (signals.platform === "android") return androidGuide(signals);
  return desktopGuide();
}

function iosGuide(signals) {
  const installed = signals.standalone;
  const allowed = signals.permission === "granted";
  const safari = signals.safari && !signals.inApp;
  if (installed && allowed) {
    return {
      platform: "ios",
      status: "on",
      headline: "Notifications on",
      lede: "Hangry can reach this iPhone. You'll get a push when a friend is free or joins you.",
      groups: [{
        label: null,
        steps: [],
        note: "If they stop arriving, open iPhone Settings → Notifications → Hangry and leave Allow Notifications on. This only works from the home-screen icon, on iOS 16.4 or newer.",
        reenable: [],
      }],
    };
  }
  if (signals.permission === "denied") {
    return {
      platform: "ios",
      status: "denied",
      headline: "Notifications are blocked",
      lede: "Hangry can't notify this iPhone until you allow it again.",
      groups: [{
        label: null,
        steps: [],
        note: "Notifications do not work in a Safari tab, or inside Instagram or WhatsApp. Open Hangry in Safari, add it to the Home Screen, then open it from that icon.",
        reenable: [
          "Open the iPhone Settings app.",
          "Go to Notifications → Hangry and turn Allow Notifications on.",
          "If Hangry is not in that list, add it to the Home Screen, open it from the icon, then tap Enable notifications and Allow.",
        ],
      }],
    };
  }
  const wrongBrowser = !safari;
  return {
    platform: "ios",
    status: wrongBrowser ? "wrong-browser" : "install",
    headline: wrongBrowser ? "Open Hangry in Safari" : "Get notifications on iPhone",
    lede: wrongBrowser
      ? "iPhone notifications need Safari, iOS 16.4 or newer, and the Home Screen app. They do not work in a Safari tab, or in Instagram or WhatsApp. Open this page in Safari first."
      : "Notifications need the Home Screen app on iOS 16.4 or newer. They do not work in a Safari tab, or inside Instagram or WhatsApp.",
    groups: [{
      label: null,
      steps: [
        step(
          "Open Hangry in Safari",
          "If you are in Instagram, WhatsApp, or another app, use that app's menu and choose Open in Safari.",
          safari,
        ),
        step(
          "Add to Home Screen",
          "In Safari, tap the Share button, then Add to Home Screen.",
          installed,
        ),
        step(
          "Open the home-screen icon",
          "Leave the Safari tab. Open Hangry from the icon you just added.",
          installed,
        ),
        step(
          "Tap Enable notifications",
          "In the home-screen app, open You or this guide and tap Enable notifications.",
          allowed,
        ),
        step(
          "Tap Allow",
          "Confirm the iPhone prompt. That permission applies to the Home Screen app.",
          allowed,
        ),
      ],
      note: "Requires iOS 16.4 or newer. A normal Safari tab cannot receive these pushes.",
      reenable: [],
    }],
  };
}

function androidGuide(signals) {
  const installed = signals.standalone;
  const allowed = signals.permission === "granted";
  if (signals.inApp) {
    return chromeInstead(
      "Instagram, WhatsApp, and other in-app browsers can't install Hangry or deliver its notifications. Open this page in Chrome first.",
    );
  }
  if (signals.canInstall === false) {
    return chromeInstead("For notifications, open Hangry in Chrome and tap Install app.");
  }
  if (installed && allowed) {
    return {
      platform: "android",
      status: "on",
      headline: "Notifications on",
      lede: "Hangry can reach this phone. You'll get a push when a friend is free or joins you.",
      groups: [{
        label: null,
        steps: [],
        note: "If a push never arrives, open Android Settings → Apps → Hangry → Notifications and turn them on, and set Hangry's battery use to Unrestricted.",
        reenable: [],
      }],
    };
  }
  if (signals.permission === "denied") {
    return {
      platform: "android",
      status: "denied",
      headline: "Notifications are blocked",
      lede: "Hangry can't notify this phone until you allow it again.",
      groups: [{
        label: null,
        steps: [],
        note: "Also check battery optimisation. Android can silence Hangry even after you tap Allow.",
        reenable: [
          "In Chrome, tap the lock icon in the address bar, then Permissions → Notifications → Allow. Or open the menu ⋮ → Settings → Site settings → Notifications.",
          "In Android Settings, open Apps → Hangry → Notifications and turn them on.",
          "In Apps → Hangry → Battery, choose Unrestricted.",
        ],
      }],
    };
  }
  return {
    platform: "android",
    status: "install",
    headline: "Get notifications on Android",
    lede: "Install Hangry from Chrome, open it from the home-screen icon, then allow notifications.",
    groups: [{
      label: null,
      steps: androidSteps(installed, allowed),
      note: androidNote(),
      reenable: [],
    }],
  };
}

function chromeInstead(lede) {
  return {
    platform: "android",
    status: "wrong-browser",
    headline: "Open Hangry in Chrome",
    lede,
    offerCopyLink: true,
    groups: [{
      label: null,
      steps: androidSteps(false, false),
      note: androidNote(),
      reenable: [],
    }],
  };
}

function androidSteps(installed, allowed) {
  return [
    step(
      "Install Hangry",
      "Tap the install prompt if Chrome shows one. Otherwise open the three-dot menu ⋮ and choose Install app or Add to Home screen.",
      installed,
    ),
    step(
      "Open the home-screen icon",
      "Open Hangry from that icon.",
      installed,
    ),
    step(
      "Tap Enable notifications",
      "In the app, open You or this guide and tap Enable notifications.",
      allowed,
    ),
    step(
      "Tap Allow",
      "Confirm Chrome's permission prompt.",
      allowed,
    ),
  ];
}

function androidNote() {
  return "If a push still doesn't arrive, open Android Settings → Apps → Hangry → Notifications and turn them on, set this site's notification permission to Allow, and set Battery to Unrestricted.";
}

function desktopGuide() {
  const ios = iosGuide({ platform: "ios", inApp: false, safari: true, standalone: false, permission: "default" });
  const android = androidGuide({
    platform: "android",
    inApp: false,
    safari: false,
    canInstall: true,
    standalone: false,
    permission: "default",
  });
  return {
    platform: "other",
    status: "install",
    headline: "Install on your phone",
    lede: "Hangry notifies phones. Open this page on an iPhone in Safari, or on Android in Chrome. A computer only shows alerts inside the app.",
    groups: [
      { label: "iPhone", steps: ios.groups[0].steps, note: ios.groups[0].note, reenable: [] },
      { label: "Android", steps: android.groups[0].steps, note: android.groups[0].note, reenable: [] },
    ],
  };
}

function step(title, detail, done) {
  return { title, detail, done: Boolean(done) };
}

/** What to show when this device is not fully subscribed. Null means it already is. */
export function pushReminder(signals, device = {}) {
  const permission = signals.permission;
  const active = permission === "granted" && Boolean(device.hasSubscription) && Boolean(device.serverKnows);
  if (active) return null;
  if (permission === "denied") {
    return {
      kind: "denied",
      title: "Notifications are blocked",
      lede: "Hangry can't notify this phone until you allow it in settings.",
      steps: deniedSteps(signals),
    };
  }
  if (!canSubscribeHere(signals)) {
    return {
      kind: "guide",
      title: "Turn on notifications",
      lede: guideLede(signals),
      steps: [],
    };
  }
  return {
    kind: "enable",
    title: "Turn on notifications",
    lede: "Hangry can only reach this phone after you allow notifications.",
    steps: [],
  };
}

export function pushTestMessage(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "0 devices subscribed, turn on notifications first";
  if (n === 1) return "Test sent to 1 device";
  return `Test sent to ${n} devices`;
}

function canSubscribeHere(signals) {
  if (signals.permission === "unsupported") return false;
  if (signals.platform === "ios") return Boolean(signals.standalone && signals.safari && !signals.inApp);
  if (signals.platform === "android") return signals.canInstall !== false && !signals.inApp;
  return true;
}

function deniedSteps(signals) {
  if (signals.platform === "ios") {
    return [
      "Open iPhone Settings → Notifications → Hangry and turn Allow Notifications on.",
      "If Hangry is not listed, add it to the Home Screen and open it from the icon.",
    ];
  }
  if (signals.platform === "android") {
    return [
      "Android Settings → Apps → Hangry → Notifications, and turn them on.",
      "Set Battery to Unrestricted.",
    ];
  }
  return ["Allow notifications for this site in the browser's site settings."];
}

function guideLede(signals) {
  if (signals.platform === "ios") {
    return "iPhone notifications need the Home Screen app. A Safari tab can't receive them.";
  }
  if (signals.platform === "android" && (signals.canInstall === false || signals.inApp)) {
    return "For notifications, open Hangry in Chrome and tap Install app.";
  }
  return "This browser can't receive Hangry notifications yet.";
}
