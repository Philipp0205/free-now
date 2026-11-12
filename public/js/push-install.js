import { pushTitle, nextPushDetail } from "./push-sheet.js";
import { activeStatus, statusLabel } from "./status.js";
import { readInstallSignals, installGuide, pushTestMessage, installReminderDue, installPrompt, joinInstallStep } from "./install-guide.js";
import { INSTALLED_KEY, INSTALL_LATER_KEY, JOIN_INSTALL_KEY, PUSH_OFF_KEY, state } from "./state.js";
import { api, refresh } from "./session.js";
import { render } from "./render.js";
import { avatar } from "./avatars.js";
import { base64UrlToUint8, copyText, el, run, scheduleErrorClear } from "./lib.js";
import { closeSheet } from "./sheets.js";

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installEvent = event;
  render();
});

window.addEventListener("appinstalled", () => {
  localStorage.setItem(INSTALLED_KEY, "1");
  state.installEvent = null;
  state.installSheet = false;
  state.joinInstall = false;
  void considerReminders();
});

export function notificationStatusLabel() {
  if ("Notification" in window && Notification.permission === "denied") return "Blocked";
  if (state.pushOn) return "On";
  return "Off";
}

export function openNotifications() {
  if ("Notification" in window && Notification.permission === "denied") {
    openInstallGuide();
    return;
  }
  state.sheet = "notifications";
  render();
}

export function notificationsSheet() {
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-label": "Notifications" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Notifications" }),
        el("p", {
          class: "help",
          text: state.pushOn
            ? "Notifications are on for this phone."
            : "Allow notifications so a friend can reach this phone.",
        }),
      ]),
      state.pushOn
        ? el("button", {
            class: "btn secondary",
            type: "button",
            text: state.pushBusy ? "Waiting…" : "Turn off notifications",
            disabled: state.pushBusy,
            onclick: () => { void onDisablePush(); },
          })
        : el("button", {
            class: "btn",
            type: "button",
            text: state.pushBusy ? "Waiting…" : "Turn on notifications",
            disabled: state.pushBusy,
            onclick: () => { void onEnablePush(); },
          }),
    ]),
  ]);
}

export function deliveryLine(kind, item) {
  const push = item.push;
  if (!push || !push.total) return null;
  return el("button", {
    class: "text-btn push-line",
    type: "button",
    text: `Delivered to ${push.delivered} of ${push.total}`,
    onclick: () => openPushSheet(kind, item),
  });
}

function openPushSheet(kind, item) {
  state.pushDetail = { kind, id: item.id, title: pushTitle(kind, item), push: item.push };
  state.sheet = "push";
  render();
}

/** Point the open push sheet at fresh poll data. True when it changed and needs a render. */
export function syncPushDetail() {
  if (state.sheet !== "push") return false;
  const next = nextPushDetail(state.pushDetail, state.socials, state.plans);
  if (!next) return false;
  state.pushDetail = next;
  return true;
}

function pushStatusText(person) {
  if (person.status === "delivered") return "Delivered";
  if (person.status === "sent") return "Sent, not confirmed";
  if (person.status === "failed") return person.httpStatus ? `Failed · ${person.httpStatus}` : "Failed";
  if (person.status === "not_sent") return "Notifications on · not sent for this event";
  if (person.status === "not_installed") return "Not installed";
  return "Notifications off";
}

export function pushSheet() {
  const detail = state.pushDetail;
  if (!detail?.push) return el("div");
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-label": "Push delivery" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Push" }),
        el("p", {
          class: "help",
          text: `${detail.title} · Delivered to ${detail.push.delivered} of ${detail.push.total}`,
        }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("div", { class: "list" }, detail.push.people.map((person) => {
          // Here status is the delivery state; Away / Busy comes as userStatus.
          const away = activeStatus(person.userStatus);
          return el("div", { class: "row" }, [
            avatar({ ...person, status: away }, 40),
            el("div", { class: "grow" }, [
              el("h3", { text: person.name }),
              el("p", { text: [pushStatusText(person), away ? statusLabel(away.type) : ""].filter(Boolean).join(" · ") }),
            ]),
          ]);
        })),
      ]),
    ]),
  ]);
}

function currentSignals() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
    || window.navigator.standalone === true;
  const notificationPermission = "Notification" in window ? Notification.permission : "unsupported";
  return readInstallSignals({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    standalone,
    notificationPermission,
  });
}

function currentGuide() {
  return installGuide(currentSignals());
}

export function openInstallGuide() {
  state.installOpen = true;
  state.error = "";
  render();
}

function closeInstallGuide() {
  state.installOpen = false;
  render();
}

export function installGuideView() {
  const guide = currentGuide();
  const signals = currentSignals();
  const actions = [];
  if (state.installEvent && !signals.standalone) {
    actions.push(el("button", { class: "btn", type: "button", text: "Install app", onclick: onInstall }));
  }
  if (canEnableNotifications(signals, guide)) {
    actions.push(el("button", {
      class: "btn",
      type: "button",
      text: state.pushBusy ? "Waiting…" : "Enable notifications",
      disabled: state.pushBusy,
      onclick: onEnablePush,
    }));
  }
  if (guide.offerCopyLink) {
    actions.unshift(el("button", {
      class: "btn",
      type: "button",
      text: "Copy link",
      onclick: () => copyText(location.href, "Link copied. Open it in Chrome."),
    }));
  }
  actions.push(el("button", { class: "btn ghost", type: "button", text: "Close", onclick: closeInstallGuide }));
  return el("div", { class: "guide-scrim" }, [
    el("section", { class: "guide", role: "dialog", "aria-modal": "true", "aria-labelledby": "install-title" }, [
      el("div", { class: "guide-head sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", {
          id: "install-title",
          text: guide.status === "on" || guide.status === "denied" ? "Notifications" : guide.headline,
        }),
      ]),
      guide.status === "on" ? el("p", { class: "status-on", text: "Notifications on" }) : null,
      guide.status === "denied" ? el("p", { class: "status-off", text: "Notifications blocked" }) : null,
      el("p", { class: "lede", text: guide.lede }),
      ...guide.groups.map((group) => el("section", { class: "guide-group" }, [
        group.label ? el("h3", { text: group.label }) : null,
        group.steps.length
          ? el("ol", { class: "guide-steps" }, group.steps.map((item, index) => el("li", { class: item.done ? "done" : "" }, [
              el("span", { class: "n", text: item.done ? "✓" : String(index + 1) }),
              el("div", {}, [
                el("strong", { text: item.title }),
                el("p", { text: item.detail }),
              ]),
            ])))
          : null,
        group.reenable.length
          ? el("ol", { class: "guide-reenable" }, group.reenable.map((line) => el("li", { text: line })))
          : null,
        group.note ? el("p", { class: "guide-note", text: group.note }) : null,
      ])),
      el("div", { class: "stack" }, actions),
    ]),
  ]);
}

function canEnableNotifications(signals, guide) {
  if (!state.meta?.vapidPublicKey) return false;
  if (guide.status === "on" || guide.status === "denied" || guide.status === "wrong-browser") return false;
  if (signals.permission !== "default") return false;
  if (signals.platform === "ios") return signals.standalone && signals.safari;
  if (signals.platform === "android") return !signals.inApp;
  return false;
}

async function onEnablePush() {
  if (!state.meta?.vapidPublicKey) {
    state.error = "Push needs VAPID keys";
    render();
    scheduleErrorClear();
    return;
  }
  state.pushBusy = true;
  render();
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted");
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8(state.meta.vapidPublicKey),
    });
    const json = subscription.toJSON();
    await api("/api/push/subscribe", {
      method: "POST",
      body: { endpoint: json.endpoint, keys: json.keys },
    });
    localStorage.removeItem(PUSH_OFF_KEY);
    state.pushOn = true;
    state.error = "Notifications are on";
    state.pushReminder = null;
  } catch (error) {
    state.error = error.message || "Could not enable notifications";
  } finally {
    state.pushBusy = false;
    render();
    scheduleErrorClear();
  }
  void considerReminders();
}

async function onDisablePush() {
  state.pushBusy = true;
  render();
  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        // Server first, so no more pushes go out even if the device step fails.
        await api("/api/push/subscribe", { method: "DELETE", body: { endpoint: subscription.endpoint } });
        await subscription.unsubscribe();
      }
    }
    localStorage.setItem(PUSH_OFF_KEY, "1");
    state.pushOn = false;
    state.pushReminder = null;
    state.onboarding = false;
    state.error = "Notifications are off";
  } catch (error) {
    state.error = error.message || "Could not turn off notifications";
  } finally {
    state.pushBusy = false;
    render();
    scheduleErrorClear();
  }
}

function pushTurnedOff() {
  return localStorage.getItem(PUSH_OFF_KEY) === "1";
}

export async function onTestPush() {
  await run(async () => {
    const result = await api("/api/push/test", { method: "POST", body: {} });
    await refresh({ initial: true });
    state.error = pushTestMessage(result?.subscriptions);
  });
}

function openedInstalledApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

export function reportDisplay() {
  if (!state.token || state.displayReported) return;
  state.displayReported = true;
  api("/api/me/display", { method: "POST", body: { standalone: openedInstalledApp() } }).catch(() => {
    state.displayReported = false;
  });
}

function isInstalled() {
  if (localStorage.getItem(INSTALLED_KEY) === "1") return true;
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
    || window.navigator.standalone === true;
}

function installDue() {
  return installReminderDue(localStorage.getItem(INSTALL_LATER_KEY), Date.now());
}

async function devicePushOn() {
  if (!state.meta?.vapidPublicKey) return false;
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  const endpoint = await localSubscriptionEndpoint();
  if (!endpoint) return false;
  try {
    const status = await api("/api/push/status", { method: "POST", body: { endpoint } });
    return Boolean(status?.known);
  } catch {
    return false;
  }
}

export async function considerReminders() {
  if (!state.token || !state.me || !state.me.circle) {
    state.onboarding = false;
    state.pushOn = false;
    state.installSheet = false;
    state.pushReminder = null;
    render();
    return;
  }
  state.pushOn = await devicePushOn();
  if (state.joinInstall) {
    // The install step after a join goes first; the usual reminder waits until it is closed.
    state.onboarding = false;
    render();
    return;
  }
  const prompt = installPrompt(currentSignals(), { canPrompt: Boolean(state.installEvent) });
  const due = reminderDue();
  const denied = "Notification" in window && Notification.permission === "denied";
  const wantInstall = due && !isInstalled() && installDue() && !prompt.quiet && !denied;
  const wantPush = due && !state.pushOn && !denied && !pushTurnedOff();
  const wantDenied = due && denied;
  state.onboarding = wantInstall || wantPush || wantDenied;
  state.installSheet = false;
  state.pushReminder = null;
  render();
}

function reminderDue() {
  const at = Number(localStorage.getItem(INSTALL_LATER_KEY) || 0);
  if (!at) return true;
  return Date.now() - at >= 3 * 24 * 60 * 60 * 1000;
}

function reenableSteps() {
  const firefox = /firefox|fennec/i.test(navigator.userAgent);
  if (firefox) {
    return [
      "Open the Firefox menu",
      "Settings → Site permissions → Notifications",
      "Allow Hangry",
    ];
  }
  return [
    "Open the Chrome menu",
    "Settings → Site settings → Notifications",
    "Allow Hangry",
  ];
}

function dismissOnboarding() {
  state.pushSnooze = true;
  localStorage.setItem(INSTALL_LATER_KEY, String(Date.now()));
  state.onboarding = false;
  render();
}

export function onboardingSheet() {
  const prompt = installPrompt(currentSignals(), { canPrompt: Boolean(state.installEvent) });
  const denied = "Notification" in window && Notification.permission === "denied";
  const showInstall = !denied && !isInstalled() && !prompt.quiet;
  const showPush = !denied && !state.pushOn && !pushTurnedOff();
  const actions = [];
  if (showPush) {
    actions.push(el("button", {
      class: "btn",
      type: "button",
      text: state.pushBusy ? "Waiting…" : "Turn on notifications",
      disabled: state.pushBusy,
      onclick: () => { void onEnablePush(); },
    }));
  }
  if (showInstall && prompt.offerInstall) {
    actions.push(el("button", { class: "btn secondary", type: "button", text: "Add to home screen", onclick: () => { void onInstall(); } }));
  }
  actions.push(el("button", { class: "btn ghost", type: "button", text: "Not now", onclick: dismissOnboarding }));
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Not now", onclick: dismissOnboarding }),
    el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Get started" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: denied ? "Notifications are blocked" : showPush ? "Turn on notifications" : "Add to home screen" }),
        el("p", {
          class: "help",
          text: denied
            ? "Hangry can't ask again until notifications are allowed in the browser."
            : showPush
              ? "So a friend can reach this phone. Adding Hangry to your home screen keeps it one tap away."
              : "Add Hangry to your home screen so it stays one tap away.",
        }),
      ]),
      denied
        ? el("ol", { class: "guide-reenable" }, reenableSteps().map((line) => el("li", { text: line })))
        : showInstall && prompt.steps.length
          ? el("ol", { class: "guide-reenable" }, prompt.steps.map((line) => el("li", { text: line })))
          : null,
      el("div", { class: "stack" }, actions),
    ]),
  ]);
}

function localSubscriptionEndpoint() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return Promise.resolve("");
  const ready = navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription());
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
  return Promise.race([ready, timeout]).then((subscription) => subscription?.endpoint || "").catch(() => "");
}

export async function onInstall() {
  if (!state.installEvent) return;
  state.installEvent.prompt();
  const choice = await state.installEvent.userChoice;
  state.installEvent = null;
  if (choice?.outcome === "accepted") {
    localStorage.setItem(INSTALLED_KEY, "1");
    state.installSheet = false;
    if (state.joinInstall) {
      localStorage.setItem(JOIN_INSTALL_KEY, "1");
      state.joinInstall = false;
    }
  }
  render();
  void considerReminders();
}

function joinInstallSignals() {
  return joinInstallStep(currentSignals(), { canPrompt: Boolean(state.installEvent) });
}

/** Just joined a circle from an invite: offer the install step once, unless this phone has it or said Not now. */
export function noteInviteJoin() {
  if (localStorage.getItem(JOIN_INSTALL_KEY) === "1" || isInstalled()) return;
  if (!joinInstallSignals()) return;
  state.joinInstall = true;
  state.onboarding = false;
}

export function dismissJoinInstall() {
  localStorage.setItem(JOIN_INSTALL_KEY, "1");
  state.joinInstall = false;
  // Same as Not now on the usual sheet: nothing else pops up now, and that reminder comes back softly after three days.
  state.pushSnooze = true;
  localStorage.setItem(INSTALL_LATER_KEY, String(Date.now()));
  render();
  void considerReminders();
}

export function joinInstallSheet() {
  const step = joinInstallSignals();
  if (!step) return null;
  const actions = [];
  if (step.offerInstall) {
    actions.push(el("button", { class: "btn", type: "button", text: "Install app", onclick: () => { void onInstall(); } }));
  }
  if (step.copyLink) {
    const where = step.kind === "ios-other" ? "Safari" : "Chrome";
    actions.push(el("button", {
      class: step.offerInstall ? "btn secondary" : "btn",
      type: "button",
      text: "Copy link",
      onclick: () => copyText(location.origin + "/", `Link copied. Open it in ${where}.`),
    }));
  }
  actions.push(el("button", { class: "btn ghost", type: "button", text: "Not now", onclick: dismissJoinInstall }));
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Not now", onclick: dismissJoinInstall }),
    el("div", { class: "sheet join-install", role: "dialog", "aria-modal": "true", "aria-labelledby": "join-install-title" }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { id: "join-install-title", text: step.title }),
        el("p", { class: "help", text: step.lede }),
      ]),
      step.steps.length
        ? el("ol", { class: "guide-steps" }, step.steps.map((line, index) => el("li", {}, [
            el("span", { class: "n", text: String(index + 1) }),
            el("strong", { text: line }),
          ])))
        : null,
      el("div", { class: "stack" }, actions),
    ]),
  ]);
}
