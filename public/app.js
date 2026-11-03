import { installGuide, installPrompt, installReminderDue, needsInstallForPush, pushReminder, pushTestMessage, readInstallSignals } from "./install-guide.js";
import { FIELD_REVEAL_MS, KEYBOARD_OFFSET_MIN, keyboardIsOpen, keyboardOffset, tabbarOverlapsKeyboard } from "./keyboard.js";

const TOKEN_KEY = "fn_token";
const SHARE_KEY = "fn_share_location";
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
  onboarding: false,
  pushOn: false,
  advanced: false,
  shareLocation: localStorage.getItem(SHARE_KEY) === "1",
  placeDraft: "",
  viewerLocation: null,
  mapCenter: null,
  mapCard: null,
  where: emptyWhere(),
  whereOpen: false,
  whereQuery: "",
  whereAutofill: false,
  whereResults: [],
  whereSearching: false,
  whereMap: false,
  focusSocial: "",
  invitePreview: null,
  inviteError: "",
  whenMode: "now",
  startChoice: "",
  etaFor: "",
};

const socialFocus = new URLSearchParams(location.search).get("social");
if (socialFocus) state.focusSocial = socialFocus;
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
  map: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="11" r="2.1" fill="currentColor"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6.5 15 12l-6 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
  if (!document.hidden && state.token) refresh().catch(() => {});
}, 3000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh().catch(() => {});
});

async function boot() {
  try {
    state.meta = await api("/api/meta", { token: null });
    if (state.pendingCode) {
      try {
        state.invitePreview = await api(`/api/invites/${state.pendingCode}`, { token: null });
      } catch {
        state.inviteError = "This invite link has expired.";
      }
    }
    if (state.token) {
      try {
        state.me = await api("/api/me");
      } catch (error) {
        if (error.status !== 401) throw error;
        clearSession();
      }
    }
    if (state.token && state.me && state.pendingCode && !state.inviteError && !state.me.circle) {
      try {
        await api("/api/circles/join", { method: "POST", body: { code: state.pendingCode } });
        state.me = await api("/api/me");
        history.replaceState(null, "", "/");
        state.pendingCode = "";
      } catch (error) {
        state.error = error.message;
      }
    }
  } catch (error) {
    state.error = error.message || "Could not reach Hangry";
  } finally {
    state.booting = false;
    render();
    refresh({ initial: true }).catch(() => {});
    rememberViewerLocation();
    void considerReminders();
    if (state.focusSocial) history.replaceState(null, "", "/");
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

let restingHeight = 0;
let restingWidth = 0;
let revealTimer = 0;

function isTextField(node) {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}

function prefersTouchUi() {
  if (window.matchMedia?.("(pointer: coarse)")?.matches) return true;
  return navigator.maxTouchPoints > 0 && !!window.matchMedia?.("(hover: none)")?.matches;
}

function readVirtualKeyboard() {
  const empty = { height: 0, top: null, bottom: null };
  if (!prefersTouchUi()) return empty;
  const rect = navigator.virtualKeyboard?.boundingRect;
  if (!rect || !Number.isFinite(rect.height) || rect.height <= 0) return empty;
  return { height: rect.height, top: rect.top, bottom: rect.bottom };
}

function syncKeyboardInset() {
  const vv = window.visualViewport;
  const layoutHeight = window.innerHeight;
  if (!vv) {
    document.documentElement.style.setProperty("--kb-offset", "0px");
    document.documentElement.style.setProperty("--vv-height", `${layoutHeight}px`);
    document.documentElement.classList.remove("kb-open");
    return;
  }
  const viewportHeight = vv.height;
  const offset = keyboardOffset(layoutHeight, viewportHeight, vv.offsetTop);
  const focused = isTyping();
  const width = window.innerWidth;
  if (!restingHeight) {
    restingHeight = viewportHeight;
    restingWidth = width;
  } else if (Math.abs(width - restingWidth) > 80) {
    restingHeight = viewportHeight;
    restingWidth = width;
  } else if (!focused && offset < KEYBOARD_OFFSET_MIN && viewportHeight >= restingHeight - 40) {
    restingHeight = viewportHeight;
    restingWidth = width;
  }
  const touchUi = prefersTouchUi();
  const vk = readVirtualKeyboard();
  const open = keyboardIsOpen({
    offset,
    focused,
    restingHeight,
    viewportHeight,
    virtualKeyboardHeight: vk.height,
    touchUi,
  });
  document.documentElement.style.setProperty("--kb-offset", `${offset}px`);
  document.documentElement.style.setProperty("--vv-height", `${Math.max(0, Math.round(viewportHeight))}px`);
  const bar = document.querySelector(".tabbar");
  const rect = bar?.getBoundingClientRect();
  const overlaps = rect
    ? tabbarOverlapsKeyboard({
        barTop: rect.top,
        barBottom: rect.bottom,
        layoutHeight,
        offset,
        shrunk: restingHeight - viewportHeight,
        virtualKeyboardTop: vk.top,
        virtualKeyboardBottom: vk.bottom,
      })
    : false;
  document.documentElement.classList.toggle("kb-open", open && overlaps);
}

function scheduleReveal(node) {
  window.clearTimeout(revealTimer);
  revealTimer = window.setTimeout(() => revealField(node), FIELD_REVEAL_MS);
}

function revealField(node) {
  if (!node.isConnected || document.activeElement !== node) return;
  if (node.id === "where-query") {
    scrollFieldAboveDock(node);
    revealWhereResults();
    return;
  }
  if (node.closest(".sheet")) {
    node.scrollIntoView({ block: "nearest", inline: "nearest" });
    scrollFieldAboveDock(node);
    return;
  }
  const form = node.closest("form");
  if (form) {
    scrollBottomIntoView(form);
    return;
  }
  node.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Keep a focused sheet field above the pinned action bar and the keyboard. */
function scrollFieldAboveDock(node) {
  const sheet = node.closest(".sheet");
  const dock = sheet?.querySelector(".sheet-dock");
  const scroller = sheet?.querySelector(".sheet-scroll") || scrollParent(node);
  const view = window.visualViewport;
  const viewTop = view?.offsetTop ?? 0;
  const viewBottom = viewTop + (view?.height ?? window.innerHeight);
  const margin = 12;
  for (let pass = 0; pass < 2; pass += 1) {
    const dockTop = dock?.getBoundingClientRect().top ?? viewBottom;
    const limit = Math.min(dockTop, viewBottom);
    const rect = node.getBoundingClientRect();
    if (rect.bottom > limit - margin) scroller.scrollBy({ top: rect.bottom - (limit - margin), left: 0 });
    else if (rect.top < viewTop + margin) scroller.scrollBy({ top: rect.top - (viewTop + margin), left: 0 });
    else break;
  }
}

/** Minimum scroll so the form's bottom edge, including its submit button, clears the keyboard. */
function scrollBottomIntoView(element) {
  const viewHeight = window.visualViewport?.height ?? window.innerHeight;
  const overflow = element.getBoundingClientRect().bottom - (viewHeight - 12);
  if (overflow <= 1) return;
  scrollParent(element).scrollBy({ top: overflow, left: 0 });
}

/** Keep the Where? hit list above the keyboard, inside the scrolling sheet. */
function revealWhereResults() {
  const list = document.querySelector(".where-results");
  if (!list?.isConnected) return;
  const view = window.visualViewport;
  const viewTop = view?.offsetTop ?? 0;
  const viewBottom = viewTop + (view?.height ?? window.innerHeight);
  const rect = list.getBoundingClientRect();
  const margin = 12;
  const parent = scrollParent(list);
  if (rect.bottom > viewBottom - margin) parent.scrollBy({ top: rect.bottom - (viewBottom - margin), left: 0 });
  else if (rect.top < viewTop + margin) parent.scrollBy({ top: rect.top - (viewTop + margin), left: 0 });
}

function scrollParent(element) {
  let node = element.parentElement;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function onViewportResize() {
  syncKeyboardInset();
  const active = document.activeElement;
  if (isTextField(active)) scheduleReveal(active);
}

function onViewportScroll() {
  syncKeyboardInset();
}

function bindKeyboard() {
  document.addEventListener("focusin", (event) => {
    if (isTextField(event.target)) scheduleReveal(event.target);
  });
  document.addEventListener("focusout", () => {
    window.setTimeout(syncKeyboardInset, 60);
  });
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", onViewportResize);
    vv.addEventListener("scroll", onViewportScroll, { passive: true });
  }
  window.addEventListener("resize", onViewportResize);
  window.addEventListener("orientationchange", () => {
    restingHeight = 0;
    syncKeyboardInset();
  });
  // Optional. overlaysContent stays off so interactive-widget=resizes-content can still shrink the layout.
  const vk = navigator.virtualKeyboard;
  if (vk?.addEventListener) vk.addEventListener("geometrychange", onViewportResize);
  syncKeyboardInset();
}

bindKeyboard();

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
    if (response.status === 401 && token && token === state.token) {
      clearSession();
      state.tab = "home";
      state.sheet = null;
      state.confirm = null;
      state.onboarding = false;
      state.installSheet = false;
      state.pushReminder = null;
      if (!state.booting) render();
    }
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
    document.getElementById("sheet-note")?.focus({ preventScroll: true });
  } else if (activeId) {
    const node = document.getElementById(activeId);
    if (node) {
      node.focus({ preventScroll: true });
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
  if (state.tab === "map") queueMicrotask(() => { mountMap().catch(() => {}); });
  if (state.whereMap && state.sheet === "free") queueMicrotask(() => { mountWhereMap().catch(() => {}); });
  if (state.whereResults.length && state.sheet === "free") queueMicrotask(() => revealWhereResults());
  if (state.focusSocial) {
    const id = state.focusSocial;
    queueMicrotask(() => {
      document.querySelector(`[data-social="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
    });
  }
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
  if (state.onboarding && !state.sheet && !state.confirm && !state.installOpen) {
    root.append(onboardingSheet());
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
      el("p", {
        class: "lede",
        text: state.invitePreview?.name
          ? `Join ${state.invitePreview.name}`
          : state.inviteError || "A private circle. Tap when you're free.",
      }),
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
          el("button", {
            class: "btn",
            type: "submit",
            text: state.invitePreview?.name ? `Join ${state.invitePreview.name}` : "Continue",
            disabled: Boolean(state.inviteError),
          }),
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
  if (state.tab === "map") phone.append(mapScreen());
  if (state.tab === "circle") phone.append(circleScreen());
  if (state.tab === "alerts") phone.append(alertsScreen());
  if (state.tab === "you") phone.append(youScreen());
  phone.append(tabbar());
  if (state.sheet) phone.append(sheet());
  return phone;
}

function screenHeader(title) {
  const unread = state.notifications.filter((note) => !note.readAt).length;
  return el("header", { class: "screen-head" }, [
    el("h1", { class: "screen-title", text: title }),
    el("button", {
      class: "icon-btn",
      type: "button",
      "aria-label": unread ? `Alerts, ${unread} unread` : "Alerts",
      onclick: () => { void onTab("alerts"); },
    }, [
      icon("bell"),
      unread ? el("span", { class: "badge", text: unread > 9 ? "9+" : String(unread) }) : null,
    ]),
  ]);
}

function home() {
  const mine = mySocial();
  const parts = [screenHeader("Now")];
  if (showInstallPill()) parts.push(installPill());
  parts.push(
    el("div", { class: "now-row" }, [
      el("button", {
        class: mine && isLiveSocial(mine) ? "orb live" : "orb",
        type: "button",
        "aria-label": "Let friends know you're free now",
        "aria-pressed": mine ? "true" : "false",
        onclick: () => openSheet("free"),
      }),
      mine
        ? el("p", { class: "hint" }, [
            el("strong", { text: mine.startsAt && mine.startsAt > Date.now() ? `Free from ${clock(mine.startsAt)}` : "You're free now" }),
            document.createTextNode(mine.note || "Friends have been told"),
          ])
        : el("p", { class: "hint" }, [
            document.createTextNode("Tap to let friends"),
            el("br"),
            document.createTextNode("know you're free now"),
          ]),
    ]),
  );
  parts.push(
    el("button", {
      class: "invite-chip",
      type: "button",
      text: "Share invite",
      onclick: () => shareInvite(),
    }),
  );
  const live = state.socials.filter((social) => isLiveSocial(social) || social.creator.id === state.me.user.id);
  const later = state.socials.filter((social) => !isLiveSocial(social) && social.creator.id !== state.me.user.id);
  if (live.length) {
    parts.push(el("div", { class: "section" }, [el("div", { class: "cards" }, live.map(socialCard))]));
  }
  if (later.length) {
    parts.push(el("section", { class: "section" }, [
      el("h2", { text: "Later today" }),
      el("div", { class: "cards" }, later.map(socialCard)),
    ]));
  }
  const tomorrow = el("section", { class: "section" }, [
    el("div", { class: "section-row" }, [
      el("h2", { text: "Tomorrow" }),
      el("button", { class: "text-btn", type: "button", text: "Plan tomorrow", onclick: () => openSheet("plan") }),
    ]),
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
  const people = [social.creator, ...social.joined.filter((person) => person.reply !== "declined")];
  const upcoming = social.startsAt && social.startsAt > Date.now();
  return el("article", {
    class: state.focusSocial === social.id ? "card card-now focused" : upcoming ? "card card-now later" : "card card-now",
    "data-social": social.id,
  }, [
    el("div", { class: "card-bg" }),
    mine
      ? el("button", { class: "pill quiet", type: "button", text: "End", onclick: () => endSocial(social) })
      : null,
    el("div", { class: "card-copy" }, [
      el("div", { class: "avatars" }, people.map((person) => avatar(person))),
      el("h3", { text: social.note || (upcoming ? "Free later" : "Free now") }),
      el("p", { text: upcoming ? `${social.creator.name} · from ${clock(social.startsAt)}` : `${social.creator.name} · ${remaining(social.expiresAt)}` }),
      placeLine(social.location, social.place),
      replySummary(social),
      mine ? null : replyActions(social),
    ]),
  ]);
}

function planCard(plan) {
  const mine = plan.creator.id === state.me.user.id;
  const people = [plan.creator, ...plan.joined];
  return el("article", { class: "card card-photo card-plan", style: `--photo:url("${bgFor(plan.id)}")` }, [
    el("div", { class: "card-bg" }),
    mine
      ? el("button", { class: "pill quiet", type: "button", text: "Delete", onclick: () => deletePlan(plan) })
      : null,
    el("div", { class: "card-copy" }, [
      el("div", { class: "avatars" }, people.map((person) => avatar(person))),
      el("h3", { text: plan.note }),
      el("p", { text: `${plan.whenLabel} · ${plan.creator.name}` }),
      placeLine(plan.location, plan.place),
      planReplySummary(plan),
      mine ? null : planReplyButtons(plan),
    ]),
  ]);
}

function circleScreen() {
  const circle = state.me.circle;
  return el("div", {}, [
    screenHeader("Circle"),
    el("div", { class: "panel" }, [
      el("h3", { text: circle.name }),
      el("div", { class: "code-block", text: circle.inviteCode }),
      el("p", { class: "help", text: "Share the link. It lasts 14 days. New invite link turns the old one off." }),
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
          text: "Share invite",
          onclick: () => shareInvite(),
        }),
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "New invite link",
          onclick: () => rotateInvite(),
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
        el("button", {
          class: "row",
          type: "button",
          onclick: () => openNotification(note),
        }, [
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
    screenHeader("Alerts"),
    dev,
    el("div", { class: "list" }, items),
  ]);
}

function youScreen() {
  const origin = state.meta?.publicBaseUrl || location.origin;
  const code = state.me.user.buzzToken;
  const curl = `curl -X POST ${origin}/api/buzz/${code} \\\n  -H 'content-type: application/json' \\\n  -d '{"note":"Rooftop coffee??"}'`;
  return el("div", {}, [
    screenHeader("You"),
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
      el("h3", { text: "Recovery code" }),
      el("p", { class: "code-block", text: code }),
      el("p", { class: "help", text: "Save this. It is how you sign back in on another phone." }),
      el("div", { class: "stack" }, [
        el("button", {
          class: "btn secondary",
          type: "button",
          text: "Copy",
          onclick: () => copyText(code, "Recovery code copied"),
        }),
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "New code",
          onclick: onRotateBuzz,
        }),
      ]),
      el("button", {
        class: "text-btn",
        type: "button",
        text: state.advanced ? "Hide advanced" : "Advanced (ESP32 buzzer)",
        onclick: () => {
          state.advanced = !state.advanced;
          render();
        },
      }),
      state.advanced
        ? el("div", {}, [
            el("pre", { class: "curl", text: curl }),
            el("button", {
              class: "btn ghost",
              type: "button",
              text: "Copy curl",
              onclick: () => copyText(curl, "curl copied"),
            }),
          ])
        : null,
    ]),
    el("div", { class: "panel stack" }, [
      el("button", { class: "btn danger", type: "button", text: "Leave circle", onclick: onLeave }),
      el("button", { class: "btn ghost", type: "button", text: "Sign out", onclick: onLogout }),
    ]),
  ]);
}

function tabbar() {
  const tabs = [
    ["home", "Now", "home"],
    ["map", "Map", "map"],
    ["circle", "Circle", "compass"],
    ["you", "You", "person"],
  ];
  return el("nav", { class: "tabbar" }, tabs.map(([id, label, glyph]) => {
    const current = state.tab === id;
    return el("button", {
      class: "tab",
      type: "button",
      "aria-label": label,
      "aria-current": current ? "page" : null,
      onclick: () => onTab(id),
    }, [
      icon(glyph),
      el("span", { class: "tab-label", text: label }),
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
  const later = !planning && state.whenMode === "later";
  const ttl = ttlLabel(state.meta?.socialTtlMs ?? 7200000);
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", onsubmit: planning ? onCreatePlan : onFree }, [
      el("div", { class: "sheet-scroll" }, [
        el("div", { class: "grabber" }),
        el("div", { class: "sheet-form" }, [
          el("div", { class: "sheet-intro" }, [
            el("h2", { text: planning ? "Tomorrow" : later ? "Free later today" : "Free now" }),
            el("p", {
              class: "help",
              text: planning
                ? "Friends can join. It stays up through tomorrow."
                : later
                  ? `Friends get a push now, and a reminder when it starts. It then lasts ${ttl}.`
                  : `Friends in your circle get a push. This lasts ${ttl}.`,
            }),
          ]),
          planning ? null : whenBlock(),
          planning ? null : timeBlock(),
          sheetField(planning ? "Plan" : "Note (optional)", "sheet-note", state.noteDraft, (value) => {
            state.noteDraft = value;
            paintSummary();
          }, {
            placeholder: planning ? "Walk and dinner with Alvin?" : "Rooftop coffee??",
            maxlength: "80",
          }),
          planning
            ? sheetField("Place (optional)", "sheet-place", state.placeDraft, (value) => {
                state.placeDraft = value;
              }, { placeholder: "A park, a cafe, a street", maxlength: "80" })
            : whereBlock(),
          planning ? shareToggle("Use my location") : null,
        ]),
      ]),
      el("div", { class: "sheet-dock stack" }, [
        planning ? null : el("p", { class: "sheet-summary", text: friendsSummary() }),
        el("button", {
          class: "btn",
          type: "submit",
          text: planning ? "Add plan" : later ? "I'm free later" : "I'm free",
          disabled: later && !laterTimeChosen(),
        }),
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

function mapScreen() {
  const pins = collectPins();
  if (!pins.length) {
    destroyLiveMap();
    mapWrap = null;
    return el("div", { class: "map-screen" }, [
      screenHeader("Map"),
      el("div", { class: "map-empty" }, [
        el("h2", { text: "No places yet" }),
        el("p", { text: "When a friend shares where they are, or a plan has a spot on the map, it shows up here." }),
      ]),
    ]);
  }
  if (!mapWrap) {
    mapWrap = el("div", { class: "map-wrap" }, [
      el("div", { id: "hangry-map", class: "hangry-map" }),
      el("div", { id: "map-card-host" }),
    ]);
  }
  return el("div", { class: "map-screen" }, [
    screenHeader("Map"),
    mapWrap,
  ]);
}

function collectPins() {
  const pins = [];
  for (const social of state.socials) {
    if (!social.location) continue;
    const mine = social.creator.id === state.me.user.id;
    const place = audiencePlace(social.place);
    pins.push({
      kind: "social",
      id: social.id,
      lat: social.location.lat,
      lng: social.location.lng,
      title: social.creator.name,
      initial: initial(social.creator.name),
      note: place
        ? (social.note ? `${social.note} · ${place}` : place)
        : (social.note || "Free now"),
      time: remaining(social.expiresAt),
      own: mine,
    });
  }
  for (const plan of state.plans) {
    if (!plan.location) continue;
    const mine = plan.creator.id === state.me.user.id;
    const place = audiencePlace(plan.place);
    pins.push({
      kind: "plan",
      id: plan.id,
      lat: plan.location.lat,
      lng: plan.location.lng,
      title: plan.creator.name,
      initial: initial(plan.creator.name),
      note: place ? `${plan.note} · ${place}` : plan.note,
      time: plan.whenLabel,
      own: mine,
    });
  }
  return pins;
}

let leafletPromise = null;
let liveMap = null;
let mapWrap = null;
let liveMarkers = new Map();
let openMapPin = null;
let whereLeaflet = null;
const TILE_MAX_ZOOM = 19;
let whereTimer = 0;
let skipWhereInput = false;
let reverseTimer = 0;
const PIN_PX = 36;

function emptyWhere() {
  return { mode: "none", place: "", lat: null, lng: null, precise: false };
}

function whereFromSocial(social) {
  if (!social || (!social.place && !social.location)) return emptyWhere();
  if (social.location && !social.place) {
    return { mode: "here", place: "", lat: social.location.lat, lng: social.location.lng, precise: false };
  }
  return {
    mode: "place",
    place: social.place || "",
    lat: social.location?.lat ?? null,
    lng: social.location?.lng ?? null,
    precise: Boolean(social.location),
  };
}

function whereLabel() {
  if (state.where.mode === "here" && /^near you$/i.test(state.where.place || "")) return "Current location";
  if (state.where.place) return state.where.place;
  if (state.where.mode === "here") return "Current location";
  if (state.where.lat != null) return "Dropped pin";
  return "Pick a place";
}

function whereIsEmpty() {
  return whereLabel() === "Pick a place";
}

function isLiveSocial(social) {
  return !social?.startsAt || social.startsAt <= Date.now();
}

function clock(ms) {
  const tz = state.meta?.tz || "Europe/Berlin";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function whenBlock() {
  return el("div", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", id: "when-label", text: "When" }),
    el("div", { class: "segment", role: "group", "aria-labelledby": "when-label" }, [
      whenChoice("now", "Now"),
      whenChoice("later", "Later today"),
    ]),
  ]);
}

function whenChoice(mode, text) {
  const on = state.whenMode === mode;
  return el("button", {
    type: "button",
    class: on ? "on" : "",
    "aria-pressed": on ? "true" : "false",
    text,
    onclick: () => {
      state.whenMode = mode;
      if (mode === "now") state.startChoice = "";
      render();
    },
  });
}

function timeBlock() {
  if (state.whenMode !== "later") return null;
  return el("label", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", text: "Time" }),
    el("input", {
      id: "later-time",
      class: "sheet-control",
      type: "time",
      value: /^\d{2}:\d{2}$/.test(state.startChoice) ? state.startChoice : "",
      oninput: (event) => {
        state.startChoice = event.target.value;
        render();
      },
    }),
  ]);
}

function friendsSummary() {
  const name = state.me?.user?.name?.trim() || "You";
  const place = (wherePayload().place || "").trim();
  const later = state.whenMode === "later";
  const time = later && /^\d{2}:\d{2}$/.test(state.startChoice) ? state.startChoice : "";
  if (later && !time) return `Friends get: ${name} is free later today`;
  return `Friends get: ${freeSheetLine(name, place, time)}`;
}

function freeSheetLine(name, place, fromTime) {
  const spot = place.trim();
  const nearYou = /^near you$/i.test(spot);
  const near = /^near\s+/i.test(spot) ? spot.replace(/^near\s+/i, "") : "";
  if (fromTime) {
    if (near) return `${name} is free from ${fromTime} near ${near}`;
    if (nearYou || !spot) return `${name} is free from ${fromTime}${nearYou ? ", nearby" : ""}`;
    return `${name} is free from ${fromTime} at ${spot}`;
  }
  if (!spot) return `${name} is free now`;
  if (nearYou) return `${name} is free nearby`;
  if (near) return `${name} is free now near ${near}`;
  return `${name} is free now at ${spot}`;
}

function paintSummary() {
  const node = document.querySelector(".sheet-summary");
  if (node) node.textContent = friendsSummary();
}

function sheetField(label, id, value, onValue, attrs = {}) {
  return el("label", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", text: label }),
    el("input", {
      id,
      class: "sheet-control",
      type: "text",
      value,
      autocomplete: "off",
      ...attrs,
      oninput: (event) => onValue(event.target.value),
    }),
  ]);
}

function laterTimeChosen() {
  return state.startChoice === "+60" || /^\d{2}:\d{2}$/.test(state.startChoice);
}

function startPayload() {
  if (state.whenMode !== "later") return { startsAt: null };
  if (state.startChoice === "+60") return { later: true, startsInMin: 60 };
  if (/^\d{2}:\d{2}$/.test(state.startChoice)) return { later: true, startsAt: state.startChoice };
  return { later: true };
}

function inReply(person) {
  return person.reply === "coming" || person.reply === "join" || person.reply === "in";
}

function replyLine(person, social) {
  const upcoming = social.startsAt && social.startsAt > Date.now();
  const eta = !upcoming && person.etaMin ? person.etaMin : null;
  const mine = person.id === state.me.user.id;
  if (person.reply === "declined") return mine ? "You can't make it" : `${person.name} can't`;
  if (mine) return eta ? `You're in · ${eta} min` : "You're in";
  return eta ? `${person.name} · there in ${eta} min` : `${person.name} is in`;
}

function replySummary(social) {
  const people = social.joined.filter((person) => inReply(person) || person.reply === "declined");
  if (!people.length) return el("p", { text: "Waiting for friends" });
  return el("div", {}, people.map((person) => el("p", { class: "reply-line", text: replyLine(person, social) })));
}

function replyActions(social) {
  const mine = social.joined.find((person) => person.id === state.me.user.id);
  const upcoming = social.startsAt && social.startsAt > Date.now();
  const inNow = mine && inReply(mine) && mine.reply !== "declined";
  return el("div", {}, [
    el("div", { class: "reply-row" }, [
      el("button", {
        class: inNow ? "chip on" : "chip",
        type: "button",
        text: "I'm in",
        onclick: () => replyTo(social, "in", upcoming ? null : mine?.etaMin ?? null),
      }),
      el("button", {
        class: mine?.reply === "declined" ? "chip on" : "chip",
        type: "button",
        text: "Can't",
        onclick: () => replyTo(social, "declined"),
      }),
    ]),
    inNow && !upcoming
      ? el("div", { class: "eta-row" }, [5, 10, 20].map((minutes) => el("button", {
          class: mine?.etaMin === minutes ? "chip on" : "chip",
          type: "button",
          text: `${minutes} min`,
          onclick: () => replyTo(social, "in", minutes),
        })))
      : null,
  ]);
}

async function replyTo(social, reply, eta = null) {
  await run(async () => {
    await api(`/api/socials/${social.id}/reply`, { method: "POST", body: { reply, eta } });
    await refresh({ initial: true });
  });
}

async function shareInvite() {
  const circle = state.me?.circle;
  if (!circle) return;
  const payload = { title: "Hangry", text: `Join ${circle.name} on Hangry`, url: circle.inviteUrl };
  if (navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  await copyText(circle.inviteUrl, "Invite link copied");
}

async function rotateInvite() {
  await run(async () => {
    const data = await api("/api/circles/invite", { method: "POST", body: {} });
    state.me = { ...state.me, circle: data.circle };
    state.error = "New invite link ready. The old one no longer works.";
  });
}

function wherePayload() {
  const where = state.where;
  const typed = (state.whereQuery || where.place || "").trim();
  if (where.mode === "here" && where.lat != null && where.lng != null) {
    return { place: where.place || "near you", lat: where.lat, lng: where.lng, precise: false };
  }
  if ((where.mode === "place" || typed) && (typed || where.lat != null)) {
    return {
      place: typed,
      lat: where.lat,
      lng: where.lng,
      precise: Boolean(where.precise && where.lat != null && where.lng != null),
    };
  }
  return { place: "", lat: null, lng: null };
}

function whereBlock() {
  const value = whereLabel();
  const empty = whereIsEmpty();
  return el("div", { class: "where sheet-group" }, [
    el("span", { class: "sheet-label", id: "where-label", text: "Where" }),
    el("div", { class: empty ? "where-field" : "where-field has-value" }, [
      el("button", {
        class: "where-row",
        type: "button",
        "aria-labelledby": "where-label",
        "aria-expanded": state.whereOpen ? "true" : "false",
        onclick: () => {
          state.whereOpen = !state.whereOpen;
          if (!state.whereOpen) state.whereMap = false;
          render();
          if (state.whereOpen) queueMicrotask(() => document.getElementById("where-query")?.focus());
        },
      }, [
        el("span", { class: empty ? "where-v is-placeholder" : "where-v", text: value }),
        icon("chevron"),
      ]),
      empty
        ? null
        : el("button", {
            class: "where-clear",
            type: "button",
            text: "Clear",
            onclick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              clearWhereSelection(state.whereOpen);
            },
          }),
    ]),
    state.whereOpen ? wherePicker() : null,
  ]);
}

function wherePicker() {
  return el("div", { class: "where-picker" }, [
    el("input", {
      id: "where-query",
      class: "sheet-control",
      type: "text",
      value: state.whereQuery,
      placeholder: "Search for a place",
      maxlength: "80",
      autocomplete: "off",
      enterkeyhint: "search",
      onbeforeinput: onWhereBeforeInput,
      oninput: onWhereInput,
    }),
    state.whereSearching ? el("p", { class: "where-hint", text: "Searching…" }) : null,
    state.whereResults.length
      ? el("div", { class: "where-results" }, state.whereResults.map((hit) => el("button", {
          class: "where-hit",
          type: "button",
          onclick: () => chooseWhereHit(hit),
        }, [
          el("span", { class: "where-hit-name", text: hit.name }),
          hitMeta(hit) ? el("span", { class: "where-hit-meta", text: hitMeta(hit) }) : null,
        ])))
      : null,
    el("button", {
      class: "where-action",
      type: "button",
      text: "Use my current location",
      onclick: () => { void useCurrentWhere(); },
    }),
    el("button", {
      class: "where-action",
      type: "button",
      text: state.whereMap ? "Hide map" : "Pick on map",
      onclick: () => {
        state.whereMap = !state.whereMap;
        render();
      },
    }),
    state.whereMap ? el("div", { id: "where-map", class: "where-map" }) : null,
    state.where.mode !== "none"
      ? el("button", {
          class: "where-action",
          type: "button",
          text: "Clear place",
          onclick: () => clearWhereSelection(true),
        })
      : null,
  ]);
}

function hitMeta(hit) {
  const distance = Number.isFinite(hit.distanceM) ? formatDistance(hit.distanceM) : "";
  return [distance, hit.address].filter(Boolean).join(" · ");
}

function searchOrigin() {
  if (state.viewerLocation) return state.viewerLocation;
  if (state.mapCenter) return state.mapCenter;
  return recentPlace();
}

function recentPlace() {
  for (const social of state.socials || []) {
    if (social.location) return social.location;
  }
  for (const plan of state.plans || []) {
    if (plan.location) return plan.location;
  }
  return null;
}

function rememberMapCenter(map) {
  const center = map.getCenter();
  if (!center) return;
  state.mapCenter = { lat: center.lat, lng: center.lng };
}

function pickerFocus() {
  if (state.where.lat != null && state.where.lng != null) {
    return { lat: state.where.lat, lng: state.where.lng, zoom: 15 };
  }
  if (state.viewerLocation) return { lat: state.viewerLocation.lat, lng: state.viewerLocation.lng, zoom: 15 };
  const recent = recentPlace();
  if (recent) return { lat: recent.lat, lng: recent.lng, zoom: 15 };
  return { lat: 51.1657, lng: 10.4515, zoom: 6 };
}

function chooseWhereHit(hit) {
  state.whereAutofill = false;
  state.where = { mode: "place", place: hit.name, lat: hit.lat, lng: hit.lng, precise: true };
  state.whereQuery = hit.name;
  state.whereResults = [];
  state.whereSearching = false;
  render();
}

function clearWhereSelection(keepOpen) {
  state.whereAutofill = false;
  state.where = emptyWhere();
  state.whereQuery = "";
  state.whereResults = [];
  state.whereSearching = false;
  state.whereMap = false;
  state.whereOpen = Boolean(keepOpen);
  clearTimeout(whereTimer);
  render();
  paintSummary();
  if (keepOpen) queueMicrotask(() => document.getElementById("where-query")?.focus());
}

function swallowNextWhereInput() {
  skipWhereInput = true;
  queueMicrotask(() => { skipWhereInput = false; });
}

function onWhereBeforeInput(event) {
  if (!state.whereAutofill) return;
  const type = event.inputType || "";
  if (type.startsWith("delete")) {
    event.preventDefault();
    swallowNextWhereInput();
    clearWhereSelection(true);
    return;
  }
  if (type.startsWith("insert") && typeof event.data === "string") {
    event.preventDefault();
    swallowNextWhereInput();
    commitTypedWhere(event.data);
  }
}

function onWhereInput(event) {
  if (skipWhereInput) {
    skipWhereInput = false;
    event.target.value = state.whereQuery;
    const end = state.whereQuery.length;
    try { event.target.setSelectionRange(end, end); } catch { /* the caret can stay */ }
    return;
  }
  if (state.whereAutofill) {
    const next = event.target.value;
    const previous = state.whereQuery;
    if (next.length < previous.length) {
      clearWhereSelection(true);
      return;
    }
    if (next !== previous && next.startsWith(previous)) {
      commitTypedWhere(next.slice(previous.length));
      return;
    }
    if (next !== previous) {
      commitTypedWhere(next);
      return;
    }
  }
  applyWhereQuery(event.target.value);
}

function commitTypedWhere(text) {
  state.whereAutofill = false;
  state.where = {
    mode: text.trim() ? "place" : "none",
    place: text,
    lat: null,
    lng: null,
    precise: false,
  };
  state.whereQuery = text;
  const input = document.getElementById("where-query");
  if (input) {
    input.value = text;
    const end = text.length;
    try { input.setSelectionRange(end, end); } catch { /* keep the caret where the field left it */ }
  }
  const label = document.querySelector(".where-v");
  if (label) {
    label.textContent = text.trim() || "Pick a place";
    label.classList.toggle("is-placeholder", !text.trim());
  }
  paintSummary();
  scheduleWhereSearch();
}

function applyWhereQuery(value) {
  state.whereAutofill = false;
  state.whereQuery = value;
  const typed = value.trim();
  state.where.mode = typed ? "place" : "none";
  state.where.place = typed;
  state.where.lat = null;
  state.where.lng = null;
  state.where.precise = false;
  const label = document.querySelector(".where-v");
  if (label) {
    label.textContent = typed || "Pick a place";
    label.classList.toggle("is-placeholder", !typed);
  }
  paintSummary();
  scheduleWhereSearch();
}

function rerenderWhere() {
  const input = document.activeElement?.id === "where-query" ? document.activeElement : null;
  const caret = input ? input.selectionStart : null;
  render();
  if (!input) return;
  queueMicrotask(() => {
    const next = document.getElementById("where-query");
    if (!next) return;
    next.focus();
    if (caret != null) {
      try { next.setSelectionRange(caret, caret); } catch { /* the field keeps its own caret */ }
    }
  });
}

function scheduleWhereSearch() {
  clearTimeout(whereTimer);
  const query = state.whereQuery.trim();
  if (query.length < 2) {
    state.whereResults = [];
    state.whereSearching = false;
    return;
  }
  whereTimer = setTimeout(() => {
    state.whereSearching = true;
    const label = document.querySelector(".where-picker");
    if (label && !document.querySelector(".where-hint")) {
      /* render once the results arrive */
    }
    const origin = searchOrigin();
    const near = origin ? `&lat=${encodeURIComponent(origin.lat)}&lng=${encodeURIComponent(origin.lng)}` : "";
    api(`/api/geocode?q=${encodeURIComponent(query)}${near}`).then((data) => {
      if (state.whereQuery.trim() !== query) return;
      state.whereResults = data.results || [];
      state.whereSearching = false;
      rerenderWhere();
    }).catch(() => {
      state.whereSearching = false;
      state.whereResults = [];
      rerenderWhere();
    });
  }, 400);
}

async function defaultCurrentWhere() {
  if (!navigator.geolocation || !navigator.permissions?.query) return;
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    if (status.state !== "granted") return;
  } catch {
    return;
  }
  if (state.sheet === "free" && state.where.mode === "none") await useCurrentWhere();
}

async function useCurrentWhere() {
  if (!navigator.geolocation) {
    state.error = "This browser can't share location. The rest still works.";
    render();
    scheduleErrorClear();
    return;
  }
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 0,
      });
    });
    state.viewerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    state.whereAutofill = true;
    state.where = { mode: "here", place: "near you", lat: pos.coords.latitude, lng: pos.coords.longitude, precise: false };
    state.whereQuery = "Current location";
    state.whereResults = [];
    state.error = "";
    const keepFocus = document.activeElement?.id === "where-query";
    render();
    if (keepFocus) queueMicrotask(() => document.getElementById("where-query")?.focus());
    const named = await api(`/api/geocode?lat=${encodeURIComponent(pos.coords.latitude)}&lng=${encodeURIComponent(pos.coords.longitude)}`).catch(() => null);
    if (state.where.mode === "here" && state.where.lat === pos.coords.latitude && state.whereAutofill) {
      const place = named?.place && !/^near you$/i.test(named.place) ? named.place : "near you";
      state.where.place = place;
      state.whereQuery = place === "near you" ? "Current location" : place;
      const stillFocused = document.activeElement?.id === "where-query";
      render();
      if (stillFocused) queueMicrotask(() => document.getElementById("where-query")?.focus());
    }
  } catch {
    state.error = "Location stayed off. Everything else still works.";
    render();
    scheduleErrorClear();
  }
}

function scheduleReverse(lat, lng) {
  clearTimeout(reverseTimer);
  reverseTimer = setTimeout(() => {
    api(`/api/geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`).then((data) => {
      if (state.where.lat !== lat || state.where.lng !== lng) return;
      if (state.whereQuery.trim() || !data.place) return;
      state.where.place = data.place;
      state.whereQuery = data.place;
      state.where.mode = "place";
      render();
    }).catch(() => {});
  }, 400);
}

function openNotification(note) {
  if (note.kind === "social" && note.refId) {
    state.focusSocial = note.refId;
    state.tab = "home";
    state.sheet = null;
  }
  render();
}

function addMapTiles(L, map) {
  const tileUrl = state.meta?.mapTileUrl
    || "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
  const tileAttribution = state.meta?.mapTileAttribution
    || "Powered by Esri | © Esri, HERE, Garmin, USGS, OpenStreetMap contributors";
  L.tileLayer(tileUrl, {
    attribution: tileAttribution,
    subdomains: tileUrl.includes("{s}") ? "abcd" : "abc",
    detectRetina: tileUrl.includes("{r}"),
    maxZoom: TILE_MAX_ZOOM,
    maxNativeZoom: TILE_MAX_ZOOM,
  }).addTo(map);
}

function destroyLiveMap() {
  if (liveMap) liveMap.remove();
  liveMap = null;
  liveMarkers = new Map();
  openMapPin = null;
}

function pinKey(pin) {
  return `${pin.kind}:${pin.id}`;
}

function pinIcon(L, pin) {
  return L.divIcon({
    className: `pin pin-${pin.kind}`,
    html: `<span class="pin-letter">${escapeHtml(pin.initial || "")}</span>`,
    iconSize: [PIN_PX, PIN_PX],
    iconAnchor: [PIN_PX / 2, PIN_PX / 2],
  });
}

function syncMapMarkers(L, pins) {
  const next = new Set();
  for (const pin of pins) {
    const key = pinKey(pin);
    next.add(key);
    const sig = `${pin.lat},${pin.lng},${pin.initial},${pin.kind}`;
    const existing = liveMarkers.get(key);
    if (existing) {
      if (existing.sig !== sig) {
        existing.marker.setLatLng([pin.lat, pin.lng]);
        existing.marker.setIcon(pinIcon(L, pin));
        existing.sig = sig;
      }
      existing.marker.off("click");
      existing.marker.on("click", () => showMapCard(pin));
      continue;
    }
    const marker = L.marker([pin.lat, pin.lng], { icon: pinIcon(L, pin) });
    marker.on("click", () => showMapCard(pin));
    marker.addTo(liveMap);
    liveMarkers.set(key, { marker, sig });
  }
  for (const [key, entry] of liveMarkers) {
    if (next.has(key)) continue;
    entry.marker.remove();
    liveMarkers.delete(key);
    if (openMapPin === key) {
      openMapPin = null;
      document.getElementById("map-card-host")?.replaceChildren();
    }
  }
}

function refreshOpenCard(pins) {
  if (!openMapPin) return;
  const pin = pins.find((item) => pinKey(item) === openMapPin);
  if (!pin) {
    openMapPin = null;
    document.getElementById("map-card-host")?.replaceChildren();
    return;
  }
  showMapCard(pin);
}

async function mountWhereMap() {
  const host = document.getElementById("where-map");
  if (!host || !state.whereMap || state.sheet !== "free") return;
  const L = await loadLeaflet();
  if (!host.isConnected || !state.whereMap || state.sheet !== "free") return;
  if (whereLeaflet) {
    whereLeaflet.remove();
    whereLeaflet = null;
  }
  const focus = pickerFocus();
  const map = L.map(host, { zoomControl: false, maxZoom: TILE_MAX_ZOOM });
  map.setView([focus.lat, focus.lng], Math.min(focus.zoom, TILE_MAX_ZOOM));
  addMapTiles(L, map);
  map.on("dragend", () => rememberMapCenter(map));
  const marker = L.marker([lat, lng], {
    draggable: true,
    icon: L.divIcon({
      className: "pin pin-social",
      html: `<span class="pin-letter"></span>`,
      iconSize: [PIN_PX, PIN_PX],
      iconAnchor: [PIN_PX / 2, PIN_PX / 2],
    }),
  }).addTo(map);
  const apply = (ll) => {
    state.where.mode = "place";
    state.where.lat = ll.lat;
    state.where.lng = ll.lng;
    state.where.precise = true;
    const label = document.querySelector(".where-v");
    if (label) label.textContent = state.where.place || "Dropped pin";
    scheduleReverse(ll.lat, ll.lng);
  };
  marker.on("dragend", () => apply(marker.getLatLng()));
  map.on("click", (event) => {
    marker.setLatLng(event.latlng);
    apply(event.latlng);
  });
  whereLeaflet = map;
  setTimeout(() => map.invalidateSize(), 60);
}

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector("link[data-leaflet]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/vendor/leaflet/leaflet.css";
      link.dataset.leaflet = "1";
      document.head.append(link);
    }
    const script = document.createElement("script");
    script.src = "/vendor/leaflet/leaflet.js";
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error("map failed to load"));
    document.body.append(script);
  });
  return leafletPromise;
}

async function mountMap() {
  const host = document.getElementById("hangry-map");
  if (!host || state.tab !== "map") return;
  const L = await loadLeaflet();
  if (!host.isConnected || state.tab !== "map") return;
  const pins = collectPins();
  if (!pins.length) {
    destroyLiveMap();
    return;
  }
  if (liveMap && liveMap.getContainer() === host) {
    syncMapMarkers(L, pins);
    refreshOpenCard(pins);
    liveMap.invalidateSize();
    reserveAttribution();
    return;
  }
  if (liveMap) destroyLiveMap();
  const map = L.map(host, { zoomControl: false, maxZoom: TILE_MAX_ZOOM });
  L.control.zoom({ position: "topright" }).addTo(map);
  addMapTiles(L, map);
  liveMap = map;
  watchAttribution(map);
  syncMapMarkers(L, pins);
  if (state.viewerLocation) {
    map.setView([state.viewerLocation.lat, state.viewerLocation.lng], 14);
  } else {
    map.fitBounds(pins.map((pin) => [pin.lat, pin.lng]), { padding: [36, 36], maxZoom: 15 });
  }
  rememberMapCenter(map);
  map.on("dragend", () => rememberMapCenter(map));
  setTimeout(() => map.invalidateSize(), 60);
}

function watchAttribution(map) {
  const attr = map.getContainer()?.querySelector(".leaflet-control-attribution");
  if (!attr || attr.dataset.watched) {
    reserveAttribution();
    return;
  }
  attr.dataset.watched = "1";
  if (window.ResizeObserver) new ResizeObserver(() => reserveAttribution()).observe(attr);
  reserveAttribution();
}

/** Keep the pin card above the attribution plate, which wraps on a narrow phone. */
function reserveAttribution() {
  const mapEl = document.getElementById("hangry-map");
  const attr = mapEl?.querySelector(".leaflet-control-attribution");
  const wrap = document.querySelector(".map-wrap");
  if (!mapEl || !attr || !wrap) return;
  const gap = Math.ceil(mapEl.getBoundingClientRect().bottom - attr.getBoundingClientRect().top) + 8;
  if (gap < 16) return;
  wrap.style.setProperty("--attr-h", `${gap}px`);
}

function showMapCard(pin) {
  openMapPin = pinKey(pin);
  const host = document.getElementById("map-card-host");
  if (!host) return;
  host.replaceChildren(mapCard(pin));
  reserveAttribution();
}

function mapCard(pin) {
  const distance = state.viewerLocation ? formatDistance(haversine(state.viewerLocation, pin)) : "";
  const social = pin.kind === "social"
    ? state.socials.find((item) => item.id === pin.id) || { id: pin.id, startsAt: null, joined: [] }
    : null;
  const plan = pin.kind === "plan"
    ? state.plans.find((item) => item.id === pin.id) || { id: pin.id, joined: [] }
    : null;
  return el("article", { class: "map-card" }, [
    el("strong", { text: pin.title }),
    el("p", { text: pin.note }),
    el("p", { class: "map-card-time", text: distance ? `${pin.time} · ${distance}` : pin.time }),
    social && !pin.own ? replySummary(social) : null,
    social && !pin.own ? replyActions(social) : null,
    plan && !pin.own ? planPinActions(plan) : null,
    el("div", { class: "map-card-actions" }, [
      mapsLink(pin.lat, pin.lng, pin.note, "Open in Maps"),
    ]),
  ]);
}

function planReplyLine(person) {
  const mine = person.id === state.me.user.id;
  if (person.reply === "declined") return mine ? "You can't make it" : `${person.name} can't`;
  return mine ? "You're in" : `${person.name} is in`;
}

function planReplySummary(plan) {
  const people = plan.joined.filter((person) => person.reply === "declined" || inReply(person));
  if (!people.length) return el("p", { text: "Waiting for friends" });
  return el("div", {}, people.map((person) => el("p", { class: "reply-line", text: planReplyLine(person) })));
}

function planReplyButtons(plan) {
  const mine = plan.joined.find((person) => person.id === state.me.user.id);
  const inNow = Boolean(mine) && mine.reply !== "declined";
  const declined = mine?.reply === "declined";
  return el("div", { class: "reply-row" }, [
    el("button", {
      class: inNow ? "chip on" : "chip",
      type: "button",
      text: "I'm in",
      onclick: () => replyToPlan(plan, "in"),
    }),
    el("button", {
      class: declined ? "chip on" : "chip",
      type: "button",
      text: "Can't",
      onclick: () => replyToPlan(plan, "declined"),
    }),
  ]);
}

function planPinActions(plan) {
  const mine = plan.joined.find((person) => person.id === state.me.user.id);
  return el("div", {}, [
    mine && (mine.reply === "declined" || inReply(mine))
      ? el("p", { class: "reply-line", text: planReplyLine(mine) })
      : null,
    planReplyButtons(plan),
  ]);
}

async function replyToPlan(plan, reply) {
  await run(async () => {
    await api(`/api/plans/${plan.id}/reply`, { method: "POST", body: { reply } });
    await refresh({ initial: true });
  });
}

function shareToggle(label) {
  return el("label", { class: "share-toggle" }, [
    el("input", {
      type: "checkbox",
      checked: state.shareLocation,
      onchange: (event) => {
        state.shareLocation = event.target.checked;
        localStorage.setItem(SHARE_KEY, state.shareLocation ? "1" : "0");
      },
    }),
    el("span", { text: label }),
  ]);
}

async function sharedPoint() {
  if (!state.shareLocation) return { lat: null, lng: null };
  if (!navigator.geolocation) {
    state.error = "This browser can't share location. The rest still works.";
    return { lat: null, lng: null };
  }
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 0,
      });
    });
    state.viewerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    return state.viewerLocation;
  } catch {
    state.error = "Location stayed off. Everything else still works.";
    return { lat: null, lng: null };
  }
}

function rememberViewerLocation() {
  if (!navigator.geolocation || !navigator.permissions?.query) return;
  navigator.permissions.query({ name: "geolocation" }).then((status) => {
    if (status.state !== "granted") return;
    navigator.geolocation.getCurrentPosition((pos) => {
      state.viewerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (state.tab === "home" || state.tab === "map") render();
    }, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 });
  }).catch(() => {});
}

function audiencePlace(place) {
  const spot = typeof place === "string" ? place.trim() : "";
  return /^near you$/i.test(spot) ? "nearby" : spot;
}

function placeLine(location, placeName) {
  const named = audiencePlace(placeName);
  if (!location && !named) return null;
  const distance = location && state.viewerLocation
    ? formatDistance(haversine(state.viewerLocation, location))
    : "";
  const where = named || "nearby";
  const text = distance ? `${where} · ${distance}` : where;
  if (!location) return el("p", { class: "place-line static", text });
  return el("a", {
    class: "place-line",
    href: mapsHref(location.lat, location.lng, named || "Hangry"),
    target: mapsExternal() ? "_blank" : null,
    rel: mapsExternal() ? "noreferrer" : null,
    "aria-label": `Open in Maps, ${text}`,
  }, [
    el("span", { class: "place-pin", "aria-hidden": "true" }),
    el("span", { text }),
  ]);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function mapsLink(lat, lng, label, text) {
  return el("a", {
    class: "map-link",
    href: mapsHref(lat, lng, label),
    target: mapsExternal() ? "_blank" : null,
    rel: mapsExternal() ? "noreferrer" : null,
    text,
  });
}

function mapsExternal() {
  return !/android/i.test(navigator.userAgent);
}

function mapsHref(lat, lng, label) {
  const name = encodeURIComponent(label || "Hangry");
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) return `https://maps.apple.com/?ll=${lat},${lng}&q=${name}`;
  if (/android/i.test(navigator.userAgent)) return `geo:${lat},${lng}?q=${lat},${lng}(${name})`;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function haversine(a, b) {
  const radius = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(meters) {
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
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
    else if (key === "checked") node.checked = Boolean(value);
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
  if (name === "free") {
    state.noteDraft = mySocial()?.note ?? "";
    state.where = whereFromSocial(mySocial());
    state.whereQuery = state.where.place;
    state.whereAutofill = false;
    state.whereOpen = false;
    state.whereResults = [];
    state.whereSearching = false;
    state.whereMap = false;
    const mine = mySocial();
    const upcoming = mine?.startsAt && mine.startsAt > Date.now();
    state.whenMode = upcoming ? "later" : "now";
    state.startChoice = upcoming ? clock(mine.startsAt) : "";
  }
  if (name === "plan") {
    state.noteDraft = "";
    state.placeDraft = "";
  }
  state.focusSheet = false;
  render();
  if (name === "free" && state.where.mode === "none") void defaultCurrentWhere();
}

function closeSheet() {
  state.sheet = null;
  state.whereMap = false;
  if (whereLeaflet) {
    whereLeaflet.remove();
    whereLeaflet = null;
  }
  render();
}

async function onTab(id) {
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
    const data = await api("/api/auth/start", {
      method: "POST",
      body: { name: state.nameDraft, code: state.pendingCode || undefined },
      token: null,
    });
    localStorage.setItem(TOKEN_KEY, data.token);
    state.token = data.token;
    state.me = await api("/api/me");
    if (data.circle) {
      history.replaceState(null, "", "/");
      state.pendingCode = "";
    } else if (state.pendingCode) {
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
  if (state.whenMode === "later" && !laterTimeChosen()) return;
  await run(async () => {
    await api("/api/socials", { method: "POST", body: { note: state.noteDraft, ...wherePayload(), ...startPayload() } });
    state.sheet = null;
    state.whereMap = false;
    await refresh({ initial: true });
  });
}

async function onCreatePlan(event) {
  event.preventDefault();
  const where = await sharedPoint();
  const locationNote = state.error;
  if (locationNote) render();
  await run(async () => {
    await api("/api/plans", { method: "POST", body: { note: state.noteDraft, place: state.placeDraft, ...where } });
    state.sheet = null;
    state.placeDraft = "";
    state.error = locationNote;
    await refresh({ initial: true });
  }, locationNote);
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
      pending.copy ? el("p", { class: "code-block", text: pending.copy }) : null,
      el("div", { class: "stack" }, [
        pending.copy
          ? el("button", {
              class: "btn secondary",
              type: "button",
              text: "Copy",
              onclick: () => copyText(pending.copy, "Recovery code copied"),
            })
          : null,
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
  void considerReminders();
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

async function considerReminders() {
  if (!state.token || !state.me || !state.me.circle) {
    state.onboarding = false;
    state.pushOn = false;
    state.installSheet = false;
    state.pushReminder = null;
    render();
    return;
  }
  state.pushOn = await devicePushOn();
  const prompt = installPrompt(currentSignals(), { canPrompt: Boolean(state.installEvent) });
  const wantInstall = !isInstalled() && installDue() && !prompt.quiet;
  const wantPush = !state.pushOn && !state.pushSnooze;
  state.onboarding = wantInstall || wantPush;
  state.installSheet = false;
  state.pushReminder = null;
  render();
}

function dismissOnboarding() {
  state.pushSnooze = true;
  if (!isInstalled()) localStorage.setItem(INSTALL_LATER_KEY, String(Date.now()));
  state.onboarding = false;
  render();
}

function onboardingSheet() {
  const prompt = installPrompt(currentSignals(), { canPrompt: Boolean(state.installEvent) });
  const showInstall = !isInstalled() && !prompt.quiet;
  const showPush = !state.pushOn;
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
      el("div", { class: "grabber" }),
      el("h2", { text: showPush ? "Turn on notifications" : "Add to home screen" }),
      el("p", {
        class: "help",
        text: showPush
          ? "So a friend can reach this phone. Adding Hangry to your home screen keeps it one tap away."
          : "Add Hangry to your home screen so it stays one tap away.",
      }),
      showInstall && prompt.steps.length
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
  const prompt = installPrompt(currentSignals(), { canPrompt: false });
  return Boolean(state.me?.circle) && !state.pushOn && !isInstalled() && !state.installPillHidden && !prompt.quiet;
}

function installPill() {
  return el("div", { class: "install-pill" }, [
    el("button", {
      class: "text",
      type: "button",
      text: "Add to home screen",
      onclick: () => {
        state.onboarding = true;
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
  state.confirm = {
    title: "New secret?",
    body: "The old buzzer and recovery code will stop working.",
    confirmLabel: "Regenerate",
    action: async () => {
      await run(async () => {
        const data = await api("/api/me/buzz-token", { method: "POST", body: {} });
        state.me = { ...state.me, user: { ...state.me.user, buzzToken: data.buzzToken } };
        state.error = "New secret ready";
      });
    },
  };
  render();
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

function onLogout() {
  const code = state.me?.user?.buzzToken || "";
  state.confirm = {
    title: "Sign out?",
    body: "You'll need this recovery code to get back in.",
    confirmLabel: "Sign out",
    copy: code,
    action: async () => {
      try {
        await api("/api/auth/logout", { method: "POST", body: {} });
      } catch {
        /* still drop the local session */
      }
      clearSession();
      state.tab = "home";
      state.sheet = null;
      state.onboarding = false;
      render();
    },
  };
  render();
}

async function run(fn, keepError = "") {
  state.error = keepError;
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
