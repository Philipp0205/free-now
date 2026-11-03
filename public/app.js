import { installGuide, installPrompt, installReminderDue, needsInstallForPush, pushReminder, pushTestMessage, readInstallSignals } from "./install-guide.js";

const TOKEN_KEY = "fn_token";
const INSTALLED_KEY = "fn_installed";
const INSTALL_LATER_KEY = "fn_install_later";
const BACKGROUNDS = ["/backgrounds/dusk.png", "/backgrounds/dinner.png", "/backgrounds/walk.png", "/backgrounds/roof.png"];
const COLORS = ["#ff375f", "#ff9f0a", "#30d158", "#64d2ff", "#bf5af2", "#ff6482", "#ac8e68", "#5e5ce6"];

const state = {
  booting: true,
  token: localStorage.getItem(TOKEN_KEY),
  meta: null,
  me: null,
  socials: [],
  plans: [],
  notifications: [],
  tab: "home",
  sheet: null,
  noteDraft: "",
  nameDraft: "",
  circleDraft: "friends",
  codeDraft: "",
  pendingCode: "",
  error: "",
  banner: null,
  bannerTimer: 0,
  iosHintOpen: false,
  confirm: null,
  latestNotifId: null,
  bootstrappedNotifs: false,
  focusSheet: false,
  installEvent: null,
  installOpen: false,
  pushBusy: false,
  pushReminder: null,
  pushSnooze: false,
  installSheet: false,
  installPillHidden: false,
};

const joinPath = location.pathname.match(/^\/join\/([A-Za-z0-9]+)/);
if (joinPath) state.pendingCode = joinPath[1].toUpperCase();
state.codeDraft = state.pendingCode;

const ICONS = {
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4.2 10.6 12 4l7.8 6.6V20a1 1 0 0 1-1 1h-4.6v-6.2H9.8V21H5.2a1 1 0 0 1-1-1z"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.8"/><path d="m14.8 9.2-1.3 4.3-4.3 1.3 1.3-4.3z" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="5" stroke="currentColor" stroke-width="1.8"/><path d="M12 8.2v7.6M8.2 12h7.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.2 16.5h11.6l-1.1-1.6a6.8 6.8 0 0 1-1-3.5V9.6a3.7 3.7 0 0 0-7.4 0v1.8c0 1.3-.3 2.5-1 3.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 17.2a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  person: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8.2" r="3.1" stroke="currentColor" stroke-width="1.8"/><path d="M5.6 19.2c.8-2.8 3.2-4.2 6.4-4.2s5.6 1.4 6.4 4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installEvent = event;
  render();
});

window.addEventListener("appinstalled", () => {
  localStorage.setItem(INSTALLED_KEY, "1");
  state.installEvent = null;
  state.installSheet = false;
  void considerReminders();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

boot();
setInterval(() => {
  if (!document.hidden) refresh().catch(() => {});
}, 3000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh().catch(() => {});
});

async function boot() {
  try {
    state.meta = await api("/api/meta", { token: null });
    if (state.token) {
      try {
        state.me = await api("/api/me");
      } catch (error) {
        if (error.status !== 401) throw error;
        clearSession();
      }
    }
  } catch (error) {
    state.error = error.message || "Could not reach Hangry";
  } finally {
    state.booting = false;
    render();
    refresh({ initial: true }).catch(() => {});
    void considerReminders();
  }
}

async function refresh({ initial = false } = {}) {
  if (!state.token || !state.me?.circle) return;
  const [socials, plans, notifications, me] = await Promise.all([
    api("/api/socials"),
    api("/api/plans"),
    api("/api/notifications"),
    api("/api/me"),
  ]);
  state.socials = socials.socials;
  state.plans = plans.plans;
  state.notifications = notifications.notifications;
  state.me = me;
  const newest = state.notifications[0];
  if (!state.bootstrappedNotifs) {
    state.latestNotifId = newest?.id ?? null;
    state.bootstrappedNotifs = true;
  } else if (newest && newest.id !== state.latestNotifId) {
    state.banner = newest;
    state.latestNotifId = newest.id;
    clearTimeout(state.bannerTimer);
    state.bannerTimer = setTimeout(() => {
      state.banner = null;
      state.signature = "";
      render();
    }, 6500);
  }
  const signature = JSON.stringify({
    socials: state.socials,
    plans: state.plans,
    notifications: state.notifications.map((note) => [note.id, note.readAt]),
    members: state.me?.circle?.members ?? null,
    banner: state.banner?.id ?? null,
  });
  if (signature === state.signature) return;
  state.signature = signature;
  if (state.sheet || state.installOpen || isTyping()) return;
  const y = document.scrollingElement?.scrollTop ?? 0;
  render();
  if (!initial && document.scrollingElement) document.scrollingElement.scrollTop = y;
}

function isTyping() {
  const tag = document.activeElement?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

async function api(path, options = {}) {
  const token = options.token === undefined ? state.token : options.token;
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.me = null;
  state.socials = [];
  state.plans = [];
  state.notifications = [];
  state.bootstrappedNotifs = false;
}

function render() {
  const activeId = state.focusSheet ? null : document.activeElement?.id || null;
  const caret = document.activeElement?.selectionStart ?? null;
  const y = document.scrollingElement?.scrollTop ?? 0;
  document.getElementById("app").replaceChildren(view());
  if (state.focusSheet) {
    state.focusSheet = false;
    document.getElementById("sheet-note")?.focus();
  } else if (activeId) {
    const node = document.getElementById(activeId);
    if (node) {
      node.focus();
      if (caret != null && node.setSelectionRange) {
        try {
          node.setSelectionRange(caret, caret);
        } catch {
          /* number inputs and buttons */
        }
      }
    }
  }
  if (!state.sheet && document.scrollingElement) document.scrollingElement.scrollTop = y;
}

function view() {
  const root = el("div", {});
  if (state.booting) {
    root.append(el("div", { class: "boot" }, [el("button", { class: "orb", "aria-label": "Loading", disabled: true })]));
    return root;
  }
  if (!state.token || !state.me) {
    root.append(welcome());
  } else if (!state.me.circle) {
    root.append(setup());
  } else {
    root.append(shell());
  }
  if (state.installOpen) root.append(installGuideView());
  if (state.installSheet && !state.sheet && !state.confirm && !state.installOpen) {
    root.append(installSheetView());
  } else if (state.pushReminder && !state.pushSnooze && !state.sheet && !state.confirm && !state.installOpen) {
    root.append(pushReminderSheet());
  }
  if (state.banner) root.append(banner(state.banner));
  if (state.confirm) root.append(confirmSheet());
  if (state.error) root.append(el("div", { class: "toast", role: "status", text: state.error }));
  return root;
}

function welcome() {
  const recovering = state.sheet === "recover";
  return el("section", { class: "gate" }, [
    el("div", { class: "hero" }, [
      el("button", { class: "orb small", type: "button", "aria-hidden": "true", tabindex: "-1" }),
      el("h1", { class: "wordmark", text: "Hangry" }),
      el("p", { class: "lede", text: "A private circle. Tap when you're free." }),
    ]),
    recovering
      ? el("form", { class: "stack", onsubmit: onRecover }, [
          field("Recovery code", "recover-code", state.codeDraft, (value) => {
            state.codeDraft = value;
          }),
          el("button", { class: "btn", type: "submit", text: "Sign back in" }),
          el("button", {
            class: "btn ghost",
            type: "button",
            text: "Back",
            onclick: () => {
              state.sheet = null;
              state.error = "";
              render();
            },
          }),
        ])
      : el("form", { class: "stack", onsubmit: onStart }, [
          field("Your name", "name", state.nameDraft, (value) => {
            state.nameDraft = value;
          }, { placeholder: "Alex", maxlength: "24", autocomplete: "nickname" }),
          el("button", { class: "btn", type: "submit", text: "Continue" }),
          el("button", {
            class: "btn ghost",
            type: "button",
            text: "I have a recovery code",
            onclick: () => {
              state.sheet = "recover";
              state.codeDraft = "";
              state.error = "";
              render();
            },
          }),
          el("button", {
            class: "btn ghost",
            type: "button",
            text: "Install for notifications",
            onclick: openInstallGuide,
          }),
        ]),
  ]);
}

function setup() {
  return el("section", { class: "gate" }, [
    el("div", { class: "hero" }, [
      el("h1", { class: "wordmark", text: `Hi ${state.me.user.name}` }),
      el("p", { class: "lede", text: "Start a circle, or join one with an invite code." }),
    ]),
    el("form", { class: "stack", onsubmit: onCreateCircle }, [
      field("Circle name", "circle-name", state.circleDraft, (value) => {
        state.circleDraft = value;
      }, { maxlength: "32" }),
      el("button", { class: "btn", type: "submit", text: "Create circle" }),
    ]),
    el("div", { class: "or", text: "or" }),
    el("form", { class: "stack", onsubmit: onJoinCircle }, [
      field("Invite code", "invite-code", state.codeDraft, (value) => {
        state.codeDraft = value.toUpperCase();
      }, { placeholder: "AB12CD34", maxlength: "12", autocapitalize: "characters", spellcheck: "false" }),
      el("button", { class: "btn secondary", type: "submit", text: "Join circle" }),
    ]),
  ]);
}

function shell() {
  const phone = el("div", { class: "phone" });
  if (state.tab === "home") phone.append(home());
  if (state.tab === "circle") phone.append(circleScreen());
  if (state.tab === "alerts") phone.append(alertsScreen());
  if (state.tab === "you") phone.append(youScreen());
  phone.append(tabbar());
  if (state.sheet) phone.append(sheet());
  return phone;
}

function home() {
  const mine = mySocial();
  const parts = [
    el("header", { class: "screen-head" }, [
      el("h1", { class: "screen-title", text: "Now" }),
      el("div", { class: "head-actions" }, [
        el("button", {
          class: "icon-btn",
          type: "button",
          "aria-label": "Create",
          onclick: () => openSheet("action"),
        }, [icon("add")]),
        el("button", {
          class: "avatar-btn",
          type: "button",
          "aria-label": "You",
          onclick: () => {
            state.tab = "you";
            render();
          },
        }, [avatar(state.me.user, 34, "header")]),
      ]),
    ]),
  ];
  if (showInstallPill()) parts.push(installPill());
  parts.push(
    el("div", { class: "now-row" }, [
      el("button", {
        class: mine ? "orb live" : "orb",
        type: "button",
        "aria-label": "Let friends know you're free now",
        "aria-pressed": mine ? "true" : "false",
        onclick: () => openSheet("free"),
      }),
      mine
        ? el("p", { class: "hint" }, [
            el("strong", { text: "You're free now" }),
            document.createTextNode(mine.note || "Friends have been told"),
          ])
        : el("p", { class: "hint" }, [
            document.createTextNode("Tap to let friends"),
            el("br"),
            document.createTextNode("know you're free now"),
          ]),
    ]),
  );
  if (state.me.circle.members.length < 2) {
    parts.push(
      el("button", {
        class: "invite-chip",
        type: "button",
        onclick: () => copyText(state.me.circle.inviteCode, "Invite code copied"),
      }, [
        document.createTextNode("Invite "),
        el("strong", { text: state.me.circle.inviteCode }),
      ]),
    );
  }
  if (state.socials.length) {
    parts.push(el("div", { class: "section" }, [el("div", { class: "cards" }, state.socials.map(socialCard))]));
  }
  const tomorrow = el("section", { class: "section" }, [
    el("h2", { text: "Tomorrow" }),
    el("div", { class: "cards" }, state.plans.length
      ? state.plans.map(planCard)
      : [
          el("button", {
            class: "empty",
            type: "button",
            text: "Nothing tomorrow yet",
            onclick: () => openSheet("plan"),
          }),
        ]),
  ]);
  parts.push(tomorrow);
  return el("div", {}, parts);
}

function socialCard(social) {
  const mine = social.creator.id === state.me.user.id;
  const joined = social.joined.some((person) => person.id === state.me.user.id);
  const people = [social.creator, ...social.joined];
  const names = social.joined.map((person) => person.name);
  return el("article", { class: "card card-now" }, [
    el("div", { class: "card-bg" }),
    mine
      ? el("button", { class: "pill quiet", type: "button", text: "End", onclick: () => endSocial(social) })
      : el("button", {
          class: "pill",
          type: "button",
          text: joined ? "Joined" : "Join",
          disabled: joined,
          onclick: () => joinSocial(social),
        }),
    el("div", { class: "card-copy" }, [
      el("div", { class: "avatars" }, people.map((person) => avatar(person))),
      el("h3", { text: social.note || "Free now" }),
      el("p", { text: `${social.creator.name} · ${remaining(social.expiresAt)}` }),
      el("p", { text: names.length ? `${names.join(", ")} joined` : "Waiting for friends" }),
    ]),
  ]);
}

function planCard(plan) {
  const mine = plan.creator.id === state.me.user.id;
  const joined = plan.joined.some((person) => person.id === state.me.user.id);
  const people = [plan.creator, ...plan.joined];
  return el("article", { class: "card card-photo", style: `--photo:url("${bgFor(plan.id)}")` }, [
    el("div", { class: "card-bg" }),
    mine
      ? el("button", { class: "pill quiet", type: "button", text: "Delete", onclick: () => deletePlan(plan) })
      : el("button", {
          class: "pill",
          type: "button",
          text: joined ? "Joined" : "Join",
          disabled: joined,
          onclick: () => joinPlan(plan),
        }),
    el("div", { class: "card-copy" }, [
      el("div", { class: "avatars" }, people.map((person) => avatar(person))),
      el("h3", { text: plan.note }),
      el("p", { text: `${plan.whenLabel} · ${plan.creator.name}` }),
    ]),
  ]);
}

function circleScreen() {
  const circle = state.me.circle;
  return el("div", {}, [
    el("header", { class: "screen-head" }, [el("h1", { class: "screen-title", text: "Circle" })]),
    el("div", { class: "panel" }, [
      el("h3", { text: circle.name }),
      el("div", { class: "code-block", text: circle.inviteCode }),
      el("p", { class: "help", text: "Anyone with this code joins your circle. That's the whole address book." }),
      el("div", { class: "stack" }, [
        el("button", {
          class: "btn",
          type: "button",
          text: "Copy code",
          onclick: () => copyText(circle.inviteCode, "Invite code copied"),
        }),
        el("button", {
          class: "btn secondary",
          type: "button",
          text: "Copy invite link",
          onclick: () => copyText(circle.inviteUrl, "Invite link copied"),
        }),
      ]),
    ]),
    el("div", { class: "list" }, circle.members.map((member) =>
      el("div", { class: "row" }, [
        avatar(member, 40),
        el("div", { class: "grow" }, [
          el("h3", { text: member.name }),
          el("p", { text: member.id === state.me.user.id ? "You" : "In the circle" }),
        ]),
      ]),
    )),
  ]);
}

function alertsScreen() {
  const items = state.notifications.length
    ? state.notifications.map((note) =>
        el("div", { class: "row" }, [
          note.readAt ? null : el("span", { class: "unread", "aria-label": "Unread" }),
          el("div", { class: "grow" }, [el("h3", { text: note.title }), el("p", { text: note.body })]),
          el("span", { class: "time", text: ago(note.createdAt) }),
        ]),
      )
    : [el("p", { class: "help", style: "padding: 8px 20px", text: "When a friend is free, it shows up here." })];
  const dev = state.meta?.devMode
    ? el("p", {
        class: "help",
        style: "padding: 4px 20px 0",
        text: "This server has no VAPID keys, so these in-app alerts stand in for push notifications.",
      })
    : null;
  return el("div", {}, [
    el("header", { class: "screen-head" }, [el("h1", { class: "screen-title", text: "Alerts" })]),
    dev,
    el("div", { class: "list" }, items),
  ]);
}

function youScreen() {
  const origin = state.meta?.publicBaseUrl || location.origin;
  const curl = `curl -X POST ${origin}/api/buzz/${state.me.user.buzzToken} \\\n  -H 'content-type: application/json' \\\n  -d '{"note":"Rooftop coffee??"}'`;
  return el("div", {}, [
    el("header", { class: "screen-head" }, [el("h1", { class: "screen-title", text: "You" })]),
    el("div", { class: "profile-hero" }, [
      avatar(state.me.user, 72, "lg"),
      el("strong", { text: state.me.user.name }),
    ]),
    el("form", { class: "panel stack", onsubmit: onRename }, [
      field("Name", "rename", state.me.user.name, () => {}, { maxlength: "24" }),
      el("button", { class: "btn secondary", type: "submit", text: "Save name" }),
    ]),
    el("div", { class: "panel" }, [
      el("h3", { text: "Notifications" }),
      notificationStatus(),
      el("p", {
        text: state.meta?.devMode
          ? "Add VAPID keys to deliver real phone notifications. Until then, alerts stay in this app — enough for two browser profiles."
          : "Install Hangry on your phone, then allow notifications, so a join reaches your pocket.",
      }),
      el("button", {
        class: "btn secondary",
        type: "button",
        text: currentGuide().status === "on"
          ? "Notification status"
          : currentGuide().status === "denied"
            ? "How to turn them back on"
            : "How to turn on notifications",
        onclick: openInstallGuide,
      }),
      currentGuide().status === "on" || currentGuide().status === "denied"
        ? null
        : el("button", {
            class: "btn",
            type: "button",
            text: state.pushBusy ? "Waiting…" : state.meta?.vapidPublicKey ? "Enable notifications" : "Push needs VAPID keys",
            disabled: state.pushBusy || !state.meta?.vapidPublicKey,
            onclick: onEnablePush,
          }),
      state.meta?.vapidPublicKey
        ? el("button", {
            class: "btn ghost",
            type: "button",
            text: "Send a test push",
            onclick: onTestPush,
          })
        : null,
      state.installEvent
        ? el("button", { class: "btn secondary", type: "button", text: "Install app", onclick: onInstall })
        : null,
    ]),
    el("div", { class: "panel" }, [
      el("h3", { text: "Buzzer and recovery" }),
      el("p", {
        text: "This secret starts a social from a button, and signs you back in if you clear this browser. Treat it like a password.",
      }),
      el("pre", { class: "curl", text: curl }),
      el("div", { class: "stack" }, [
        el("button", {
          class: "btn secondary",
          type: "button",
          text: "Copy curl",
          onclick: () => copyText(curl, "curl copied"),
        }),
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "Regenerate secret",
          onclick: onRotateBuzz,
        }),
      ]),
    ]),
    el("div", { class: "panel stack" }, [
      el("button", { class: "btn danger", type: "button", text: "Leave circle", onclick: onLeave }),
      el("button", { class: "btn ghost", type: "button", text: "Sign out", onclick: onLogout }),
    ]),
  ]);
}

function tabbar() {
  const unread = state.notifications.filter((note) => !note.readAt).length;
  const tabs = [
    ["home", "Now", "home"],
    ["circle", "Circle", "compass"],
    ["create", "Create", "plus"],
    ["alerts", "Alerts", "bell"],
    ["you", "You", "person"],
  ];
  return el("nav", { class: "tabbar" }, tabs.map(([id, label, glyph]) => {
    const current = id !== "create" && state.tab === id;
    return el("button", {
      class: "tab",
      type: "button",
      "aria-label": label,
      "aria-current": current ? "page" : null,
      onclick: () => onTab(id),
    }, [
      icon(glyph),
      id === "alerts" && unread ? el("span", { class: "badge", text: unread > 9 ? "9+" : String(unread) }) : null,
    ]);
  }));
}

function sheet() {
  if (state.sheet === "action") {
    return el("div", {}, [
      el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
      el("div", { class: "sheet", role: "dialog", "aria-label": "Create" }, [
        el("div", { class: "grabber" }),
        el("div", { class: "actions" }, [
          el("button", { class: "action", type: "button", text: "I'm free now", onclick: () => openSheet("free") }),
          el("button", { class: "action", type: "button", text: "Plan tomorrow", onclick: () => openSheet("plan") }),
          el("button", { class: "action", type: "button", text: "Cancel", onclick: closeSheet }),
        ]),
      ]),
    ]);
  }
  const planning = state.sheet === "plan";
  const ttl = ttlLabel(state.meta?.socialTtlMs ?? 7200000);
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", onsubmit: planning ? onCreatePlan : onFree }, [
      el("div", { class: "grabber" }),
      el("h2", { text: planning ? "Tomorrow" : "Free now" }),
      el("p", {
        class: "help",
        text: planning
          ? "Friends can join. It stays up through tomorrow."
          : `Friends in your circle get a push. This lasts ${ttl}.`,
      }),
      field(planning ? "Plan" : "Note", "sheet-note", state.noteDraft, (value) => {
        state.noteDraft = value;
      }, {
        placeholder: planning ? "Walk and dinner with Alvin?" : "Rooftop coffee??",
        maxlength: "80",
      }),
      el("div", { class: "stack", style: "margin-top:14px" }, [
        el("button", { class: "btn", type: "submit", text: planning ? "Add plan" : "I'm free" }),
        !planning && mySocial()
          ? el("button", { class: "btn ghost", type: "button", text: "I'm no longer free", onclick: () => endSocial(mySocial()) })
          : null,
      ]),
    ]),
  ]);
}

function banner(note) {
  return el("button", { class: "banner", type: "button", onclick: () => {
    state.banner = null;
    state.tab = "home";
    render();
  } }, [
    el("img", { src: "/icons/icon-192.png", alt: "" }),
    el("span", { class: "copy" }, [el("strong", { text: note.title }), el("span", { text: note.body })]),
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

function notificationStatus() {
  const guide = currentGuide();
  if (guide.status === "on") return el("p", { class: "status-on", text: "Notifications on" });
  if (guide.status === "denied") return el("p", { class: "status-off", text: "Notifications blocked" });
  return null;
}

function openInstallGuide() {
  state.installOpen = true;
  state.error = "";
  render();
}

function closeInstallGuide() {
  state.installOpen = false;
  render();
}

function installGuideView() {
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
      el("div", { class: "guide-head" }, [
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

function field(label, id, value, onValue, attrs = {}) {
  return el("label", { class: "field" }, [
    el("span", { text: label }),
    el("input", {
      id,
      type: "text",
      value,
      autocomplete: "off",
      ...attrs,
      oninput: (event) => onValue(event.target.value),
    }),
  ]);
}

function icon(name) {
  const node = el("span", { class: "icon" });
  node.innerHTML = ICONS[name];
  return node;
}

function avatar(person, size = 28, extra = "") {
  const node = el("span", {
    class: `avatar ${extra}`.trim(),
    text: initial(person.name),
    style: `background:${colorFor(person.id)}`,
  });
  if (size !== 28) {
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
  }
  return node;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "disabled") node.disabled = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function openSheet(name) {
  state.sheet = name;
  state.error = "";
  if (name === "free") state.noteDraft = mySocial()?.note ?? "";
  if (name === "plan") state.noteDraft = "";
  state.focusSheet = name === "free" || name === "plan";
  render();
}

function closeSheet() {
  state.sheet = null;
  render();
}

async function onTab(id) {
  if (id === "create") {
    openSheet("action");
    return;
  }
  state.tab = id;
  state.sheet = null;
  if (id === "alerts") {
    render();
    try {
      await api("/api/notifications/read", { method: "POST", body: {} });
      const readAt = Date.now();
      state.notifications = state.notifications.map((note) => ({ ...note, readAt: note.readAt ?? readAt }));
    } catch (error) {
      state.error = error.message;
    }
  }
  render();
}

async function onStart(event) {
  event.preventDefault();
  state.error = "";
  try {
    const data = await api("/api/auth/start", { method: "POST", body: { name: state.nameDraft }, token: null });
    localStorage.setItem(TOKEN_KEY, data.token);
    state.token = data.token;
    state.me = await api("/api/me");
    if (state.pendingCode) {
      try {
        await api("/api/circles/join", { method: "POST", body: { code: state.pendingCode } });
        state.me = await api("/api/me");
        history.replaceState(null, "", "/");
        state.pendingCode = "";
      } catch (error) {
        state.codeDraft = state.pendingCode;
        state.error = error.message;
      }
    }
    state.pushSnooze = false;
    render();
    refresh({ initial: true }).catch(() => {});
    void considerReminders();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function onRecover(event) {
  event.preventDefault();
  state.error = "";
  try {
    const data = await api("/api/auth/recover", { method: "POST", body: { token: state.codeDraft.trim() }, token: null });
    localStorage.setItem(TOKEN_KEY, data.token);
    state.token = data.token;
    state.sheet = null;
    state.me = await api("/api/me");
    state.pushSnooze = false;
    render();
    refresh({ initial: true }).catch(() => {});
    void considerReminders();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function onCreateCircle(event) {
  event.preventDefault();
  await run(async () => {
    await api("/api/circles", { method: "POST", body: { name: state.circleDraft || "friends" } });
    state.me = await api("/api/me");
  });
  void considerReminders();
}

async function onJoinCircle(event) {
  event.preventDefault();
  await run(async () => {
    await api("/api/circles/join", { method: "POST", body: { code: state.codeDraft } });
    state.me = await api("/api/me");
    if (state.pendingCode) history.replaceState(null, "", "/");
  });
  void considerReminders();
}

async function onFree(event) {
  event.preventDefault();
  await run(async () => {
    await api("/api/socials", { method: "POST", body: { note: state.noteDraft } });
    state.sheet = null;
    await refresh({ initial: true });
  });
}

async function onCreatePlan(event) {
  event.preventDefault();
  await run(async () => {
    await api("/api/plans", { method: "POST", body: { note: state.noteDraft } });
    state.sheet = null;
    await refresh({ initial: true });
  });
}

async function joinSocial(social) {
  await run(async () => {
    await api(`/api/socials/${social.id}/join`, { method: "POST", body: {} });
    await refresh({ initial: true });
  });
}

async function endSocial(social) {
  if (!social) return;
  state.confirm = {
    title: "End this?",
    body: "Friends will no longer see you as free.",
    confirmLabel: "End",
    action: async () => {
      await run(async () => {
        await api(`/api/socials/${social.id}`, { method: "DELETE" });
        state.sheet = null;
        await refresh({ initial: true });
      });
    },
  };
  render();
}

function confirmSheet() {
  const pending = state.confirm;
  if (!pending) return el("div");
  return el("div", {}, [
    el("button", {
      class: "scrim",
      type: "button",
      "aria-label": "Cancel",
      onclick: () => {
        state.confirm = null;
        render();
      },
    }),
    el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": pending.title }, [
      el("div", { class: "grabber" }),
      el("h2", { text: pending.title }),
      el("p", { class: "help", text: pending.body }),
      el("div", { class: "stack" }, [
        el("button", {
          class: "btn danger",
          type: "button",
          text: pending.confirmLabel,
          onclick: () => {
            const action = pending.action;
            state.confirm = null;
            render();
            void action();
          },
        }),
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "Cancel",
          onclick: () => {
            state.confirm = null;
            render();
          },
        }),
      ]),
    ]),
  ]);
}

async function joinPlan(plan) {
  await run(async () => {
    await api(`/api/plans/${plan.id}/join`, { method: "POST", body: {} });
    await refresh({ initial: true });
  });
}

async function deletePlan(plan) {
  if (!window.confirm("Delete this plan?")) return;
  await run(async () => {
    await api(`/api/plans/${plan.id}`, { method: "DELETE" });
    await refresh({ initial: true });
  });
}

async function onRename(event) {
  event.preventDefault();
  const input = document.getElementById("rename");
  await run(async () => {
    state.me = await api("/api/me", { method: "PATCH", body: { name: input.value } });
    state.error = "Name saved";
  });
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
    state.error = "Notifications are on";
    state.pushReminder = null;
  } catch (error) {
    state.error = error.message || "Could not enable notifications";
  } finally {
    state.pushBusy = false;
    render();
    scheduleErrorClear();
  }
  void considerPushReminder();
}

async function onTestPush() {
  await run(async () => {
    const result = await api("/api/push/test", { method: "POST", body: {} });
    await refresh({ initial: true });
    state.error = pushTestMessage(result?.subscriptions);
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

async function considerReminders() {
  if (!state.token || !state.me) return;
  const signals = currentSignals();
  if (!isInstalled() && state.me.circle && installDue()) {
    state.installSheet = true;
    state.pushReminder = null;
    render();
    return;
  }
  if (state.installSheet) return;
  if (!isInstalled() && needsInstallForPush(signals)) {
    state.pushReminder = null;
    render();
    return;
  }
  await considerPushReminder();
}

async function considerPushReminder() {
  if (!state.token || !state.me || state.pushSnooze || state.installSheet) return;
  const signals = currentSignals();
  if (signals.permission !== "granted") {
    state.pushReminder = pushReminder(signals, { hasSubscription: false, serverKnows: false });
    render();
    return;
  }
  const endpoint = await localSubscriptionEndpoint();
  let serverKnows = false;
  if (endpoint) {
    try {
      const status = await api("/api/push/status", { method: "POST", body: { endpoint } });
      serverKnows = Boolean(status?.known);
    } catch {
      serverKnows = false;
    }
  }
  state.pushReminder = pushReminder(signals, { hasSubscription: Boolean(endpoint), serverKnows });
  render();
}

function localSubscriptionEndpoint() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return Promise.resolve("");
  const ready = navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription());
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
  return Promise.race([ready, timeout]).then((subscription) => subscription?.endpoint || "").catch(() => "");
}

function pushReminderSheet() {
  const reminder = state.pushReminder;
  if (!reminder) return el("div");
  const snooze = () => {
    state.pushSnooze = true;
    render();
  };
  const actions = [];
  if (reminder.kind === "enable") {
    actions.push(el("button", {
      class: "btn",
      type: "button",
      text: state.pushBusy ? "Waiting…" : "Turn on notifications",
      disabled: state.pushBusy,
      onclick: () => onEnablePush(),
    }));
  } else if (reminder.kind === "guide") {
    actions.push(el("button", {
      class: "btn",
      type: "button",
      text: "Open the install guide",
      onclick: openInstallGuide,
    }));
  }
  actions.push(el("button", { class: "btn ghost", type: "button", text: "Not now", onclick: snooze }));
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Not now", onclick: snooze }),
    el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": reminder.title }, [
      el("div", { class: "grabber" }),
      el("h2", { text: reminder.title }),
      el("p", { class: "help", text: reminder.lede }),
      reminder.steps?.length
        ? el("ol", { class: "guide-reenable" }, reminder.steps.map((line) => el("li", { text: line })))
        : null,
      el("div", { class: "stack" }, actions),
    ]),
  ]);
}

async function onInstall() {
  if (!state.installEvent) return;
  state.installEvent.prompt();
  const choice = await state.installEvent.userChoice;
  state.installEvent = null;
  if (choice?.outcome === "accepted") {
    localStorage.setItem(INSTALLED_KEY, "1");
    state.installSheet = false;
  }
  render();
  void considerReminders();
}

function showInstallPill() {
  return Boolean(state.me?.circle) && !isInstalled() && !state.installPillHidden;
}

function installPill() {
  return el("div", { class: "install-pill" }, [
    el("button", {
      class: "text",
      type: "button",
      text: "Install Hangry to get notifications",
      onclick: () => {
        state.installSheet = true;
        state.pushReminder = null;
        render();
      },
    }),
    el("button", {
      class: "ios-dismiss",
      type: "button",
      "aria-label": "Hide install reminder",
      text: "×",
      onclick: () => {
        state.installPillHidden = true;
        render();
      },
    }),
  ]);
}

function dismissInstallSheet() {
  localStorage.setItem(INSTALL_LATER_KEY, String(Date.now()));
  state.installSheet = false;
  render();
  void considerReminders();
}

function installSheetView() {
  const prompt = installPrompt(currentSignals(), { canPrompt: Boolean(state.installEvent) });
  const actions = [];
  if (prompt.offerInstall) {
    actions.push(el("button", { class: "btn", type: "button", text: "Install app", onclick: () => onInstall() }));
  }
  if (prompt.copyLink) {
    actions.push(el("button", {
      class: "btn",
      type: "button",
      text: "Copy link",
      onclick: () => copyText(location.href, "Link copied. Open it in Chrome."),
    }));
  }
  actions.push(el("button", { class: "btn ghost", type: "button", text: "Not now", onclick: dismissInstallSheet }));
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Not now", onclick: dismissInstallSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": prompt.title }, [
      el("div", { class: "grabber" }),
      el("h2", { text: prompt.title }),
      el("p", { class: "help", text: prompt.lede }),
      prompt.steps.length
        ? el("ol", { class: "guide-reenable" }, prompt.steps.map((line) => el("li", { text: line })))
        : null,
      el("div", { class: "stack" }, actions),
    ]),
  ]);
}

async function onRotateBuzz() {
  if (!window.confirm("The old buzzer and recovery code will stop working.")) return;
  await run(async () => {
    const data = await api("/api/me/buzz-token", { method: "POST", body: {} });
    state.me = { ...state.me, user: { ...state.me.user, buzzToken: data.buzzToken } };
    state.error = "New secret ready";
  });
}

async function onLeave() {
  if (!window.confirm("Leave this circle?")) return;
  await run(async () => {
    state.me = await api("/api/circles/leave", { method: "POST", body: {} });
    state.tab = "home";
    state.socials = [];
    state.plans = [];
  });
}

async function onLogout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch {
    /* still drop the local session */
  }
  clearSession();
  state.tab = "home";
  state.sheet = null;
  render();
}

async function run(fn) {
  state.error = "";
  try {
    await fn();
  } catch (error) {
    state.error = error.message || "Something went wrong";
  }
  render();
  scheduleErrorClear();
}

function scheduleErrorClear() {
  const message = state.error;
  if (!message) return;
  clearTimeout(state.errorTimer);
  state.errorTimer = setTimeout(() => {
    if (state.error === message) {
      state.error = "";
      render();
    }
  }, 3200);
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    state.error = message;
  } catch {
    state.error = value;
  }
  render();
  setTimeout(() => {
    if (state.error === message) {
      state.error = "";
      render();
    }
  }, 2200);
}

function mySocial() {
  return state.socials.find((social) => social.creator.id === state.me?.user.id) ?? null;
}

function remaining(expiresAt) {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  if (minutes < 1) return "ending";
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

function ago(ts) {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function ttlLabel(ms) {
  const hours = ms / 3600000;
  if (Math.abs(hours - 2) < 0.05) return "about 2 hours";
  if (hours >= 1) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(ms / 60000)} minutes`;
}

function bgFor(id) {
  let hash = 0;
  for (const char of id) hash = (hash + char.charCodeAt(0)) % BACKGROUNDS.length;
  return BACKGROUNDS[hash];
}

function colorFor(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function initial(name) {
  const char = Array.from(name || "?")[0] || "?";
  return char.toUpperCase();
}

function base64UrlToUint8(base64Url) {
  const padded = `${base64Url}${"=".repeat((4 - (base64Url.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
