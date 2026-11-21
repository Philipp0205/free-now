import { captureOpenMenu, ghostClosedMenu, placeOpenCardMenus, playMenuPop } from "./cards.js";
import { state } from "./state.js";
import { RETRY_NOTE, calendarLanding, onRecover, onStart } from "./session.js";
import { mountMap, mountWhereMap } from "./map-card.js";
import { anchorOpenSheet, revealWhereResults } from "./keyboard-ui.js";
import { alertsScreen, banner, circleUnread, personalAlerts } from "./alerts.js";
import { home, pastScreen } from "./home.js";
import { circleScreen } from "./members.js";
import { chatScreen, growComposer, releaseChatScreen, setChatLogPlace, stickChatLog } from "./chat.js";
import { forgetShownAgentToken, youScreen } from "./you.js";
import { forgetShownFeedLink } from "./calendar-sync.js";
import { whatsNewSheet } from "./whats-new-ui.js";
import { confirmSheet, liftSheetToast, sheet, sheetIsOpen } from "./sheets.js";
import { installGuideView, installStepsSheet, joinInstallSheet, onboardingSheet, syncInstallPrompt } from "./push-install.js";
import { mapScreen } from "./events.js";
import { whereBag } from "./where.js";
import { TIME_LATER_ERROR } from "./composer.js";
import { sharePreviewScreen } from "./plan-share.js";
import { el, field, icon } from "./lib.js";
import { bindSheetSwipe, onTab, syncOverlayHistory } from "./nav.js";
import { bindLargeTitle, bindPullToRefresh } from "./native.js";
import { onCreateCircle, onJoinCircle } from "./circles.js";
import { accountNotices, emailField, emailGate, linkScreen, lostCodeForm, needsEmail } from "./account.js";
import { slideOutSheet, takeLeavingSheet } from "./sheet-out.js";

/** Set by a tab bar tap that changes the page; the next render fades that page in once, then clears it. */
let pageEntrance = false;
/** Page scroll per tab, saved while the page is uncovered, so Back from a sheet, chat or place returns to it. */
const tabY = new Map();
// The overlay entries are pushed while the page is covered and saved at scroll 0; the browser would restore that after Back.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

export function render() {
  const activeId = state.focusSheet ? null : document.activeElement?.id || null;
  const caret = document.activeElement?.selectionStart ?? null;
  const y = document.scrollingElement?.scrollTop ?? 0;
  const sheetY = document.querySelector(".sheet-scroll")?.scrollTop ?? 0;
  const chatLog = document.querySelector(".chat-log");
  const chatY = chatLog?.scrollTop ?? 0;
  const chatNearEnd = chatLog ? chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 48 : true;
  const calY = document.querySelector(".cal")?.scrollTop ?? 0;
  const shownTab = document.querySelector("[data-page]")?.dataset.page ?? null;
  const wasCovered = !shownTab || document.documentElement.classList.contains("sheet-open");
  if (shownTab && !wasCovered) tabY.set(shownTab, y);
  const freshTab = pageEntrance;
  const openMenu = captureOpenMenu();
  const leavingSheet = takeLeavingSheet();
  document.getElementById("app").replaceChildren(view());
  // The chat screen is one stable host that view() hands back each time; if it did not come back, chat was left.
  releaseChatScreen();
  pageEntrance = false;
  if (freshTab) {
    // The kit plays the landing once per real switch: the page fades in, the tab you landed on springs.
    const tabs = window.AppKit?.tabbar;
    tabs?.animatePage?.(document.querySelector("[data-page]"));
    tabs?.animateIn?.(document.querySelector(".tabbar .tab[aria-current]"));
  }
  const sheetScroll = document.querySelector(".sheet-scroll");
  if (sheetScroll) sheetScroll.scrollTop = sheetY;
  // The month scrolls inside the Events tab, so a refresh render keeps its place.
  const cal = document.querySelector(".cal");
  if (cal) cal.scrollTop = calY;
  const nextLog = document.querySelector(".chat-log");
  if (nextLog) nextLog.scrollTop = state.chatStick || chatNearEnd ? nextLog.scrollHeight : chatY;
  if (nextLog) {
    setChatLogPlace(state.chatStick || chatNearEnd, nextLog.scrollTop);
  }
  state.chatStick = false;
  if (state.chat) {
    growComposer(document.getElementById("chat-input"));
    stickChatLog();
  }
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
  if (state.tab === "map") queueMicrotask(() => { mountMap().catch(() => {}); });
  const picking = state.sheet === "free" || state.sheet === "plan" || state.sheet === "admin-edit";
  const bag = whereBag();
  if (bag.whereMap && picking) {
    queueMicrotask(() => {
      mountWhereMap().then(() => {
        const node = document.querySelector(".sheet-scroll");
        if (node) node.scrollTop = sheetY;
      }).catch((error) => console.error("where map failed", error));
    });
  }
  if (bag.whereResults.length && picking) queueMicrotask(() => revealWhereResults());
  document.documentElement.classList.toggle("sheet-open", sheetIsOpen());
  if (!state.chat && !state.past && !sheetIsOpen() && document.scrollingElement) {
    // Back from a sheet, chat or place: the document scroll collapsed while covered, so use the saved one.
    // This runs after sheet-open is toggled off, or the collapsed document would clamp it to 0.
    const switched = (wasCovered || shownTab !== state.tab) && !freshTab;
    document.scrollingElement.scrollTop = switched ? tabY.get(state.tab) ?? 0 : y;
  }
  bindLargeTitle();
  bindPullToRefresh();
  anchorOpenSheet();
  bindSheetSwipe();
  liftSheetToast();
  syncOverlayHistory();
  if (state.cardMenu) {
    placeOpenCardMenus();
    requestAnimationFrame(() => { if (state.cardMenu) placeOpenCardMenus(); });
  }
  // A menu opened by this render pops in once; one closed by it pops out from where it sat.
  playMenuPop();
  if (!state.cardMenu) ghostClosedMenu(openMenu);
  // A sheet closed by the user slides on down from where it was, after everything above has found the live page.
  slideOutSheet(leavingSheet);
  syncInstallPrompt();
  if (state.focusPlanScroll) {
    state.focusPlanScroll = false;
    const id = state.focusPlan;
    queueMicrotask(() => {
      document.querySelector(`[data-plan="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
    });
  }
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
    root.append(el("div", { class: "boot" }, [el("div", { class: "orb live", "aria-label": "Loading" })]));
    return root;
  }
  if (state.offline && state.token && !state.me) {
    root.append(el("div", { class: "boot" }, [
      el("div", { class: "orb live", "aria-hidden": "true" }),
      el("p", { class: "lede", text: "You're offline. Retrying…" }),
    ]));
    if (state.error) root.append(el("div", { class: "toast", role: "status", text: state.error }));
    return root;
  }
  if (state.linkFlow) {
    root.append(linkScreen());
    if (state.error) root.append(el("div", { class: "toast", role: "status", text: state.error }));
    return root;
  }
  if (needsEmail()) {
    // Nothing else works for this account yet, so nothing else is offered: no sheets, prompts or what's new.
    root.append(emailGate());
    if (state.error && !RETRY_NOTE.has(state.error)) root.append(el("div", { class: "toast", role: "status", text: state.error }));
    return root;
  }
  if (state.sharePreview) {
    root.append(sharePreviewScreen());
    if (state.installOpen) root.append(installGuideView());
    if (state.error) root.append(el("div", { class: "toast", role: "status", text: state.error }));
    return root;
  }
  if (calendarLanding && !state.token) {
    root.append(calendarReturnScreen());
  } else if (!state.token || !state.me) {
    root.append(welcome());
  } else if (!state.me.circle) {
    root.append(setup());
    if (state.sheet === "whats-new") root.append(whatsNewSheet());
  } else {
    root.append(shell());
  }
  if (state.installOpen) root.append(installGuideView());
  const joinSheet = state.joinInstall && state.me?.circle && !state.sheet && !state.confirm && !state.installOpen
    ? joinInstallSheet()
    : null;
  if (joinSheet) {
    root.append(joinSheet);
  } else if (state.onboarding && !state.sheet && !state.confirm && !state.installOpen) {
    root.append(onboardingSheet());
  }
  if (state.installSteps && state.me?.circle && !state.confirm && !state.installOpen) root.append(installStepsSheet());
  if (state.banner) root.append(banner(state.banner));
  if (state.confirm) root.append(confirmSheet());
  if (state.error && state.error !== TIME_LATER_ERROR && !RETRY_NOTE.has(state.error)) {
    root.append(el("div", { class: "toast", role: "status", text: state.error }));
  }
  return root;
}

/** Google's page can open in a browser tab that has no session. Say how it went and point back to the app. */
function calendarReturnScreen() {
  return el("section", { class: "gate" }, [
    el("div", { class: "hero" }, [
      el("button", { class: "orb small", type: "button", "aria-hidden": "true", tabindex: "-1" }),
      el("h1", { class: "wordmark", text: "Spontaco" }),
      el("p", { class: "lede", text: calendarLanding === "google" ? "Google Calendar connected." : "Could not connect Google Calendar." }),
      el("p", { class: "lede", text: "Go back to Spontaco." }),
    ]),
  ]);
}

function welcome() {
  const recovering = state.sheet === "recover";
  const inviting = Boolean(state.pendingCode) && !state.inviteError;
  return el("section", { class: "gate" }, [
    el("div", { class: "hero" }, [
      el("button", { class: "orb small", type: "button", "aria-hidden": "true", tabindex: "-1" }),
      el("h1", { class: "wordmark", text: "Spontaco" }),
      el("p", {
        class: "lede",
        text: state.invitePreview?.name
          ? `Join ${state.invitePreview.name}`
          : state.inviteError === "expired"
            ? "This invite has expired. Ask for a new link."
            : state.inviteError === "invalid"
              ? "This invite isn't valid. Ask for a new link."
              : "A private circle. Tap when you're free.",
      }),
    ]),
    recovering
      ? state.lostOpen
        ? lostCodeForm()
        : el("form", { class: "stack", onsubmit: onRecover }, [
          field("Recovery code", "recover-code", state.codeDraft, (value) => {
            state.codeDraft = value;
          }),
          inviting
            ? el("p", { class: "hint", text: "Find it in You, Show recovery code, on the phone where you are signed in." })
            : null,
          el("button", {
            class: "btn",
            type: "submit",
            text: inviting ? `Sign in and join${state.invitePreview?.name ? ` ${state.invitePreview.name}` : ""}` : "Sign back in",
          }),
          el("button", {
            class: "text-btn",
            type: "button",
            text: "I lost my code",
            onclick: () => {
              state.lostOpen = true;
              state.lostSent = false;
              state.error = "";
              render();
            },
          }),
          el("button", {
            class: "btn ghost",
            type: "button",
            text: "Back",
            onclick: () => {
              state.sheet = null;
              state.codeDraft = "";
              state.error = "";
              render();
            },
          }),
        ])
      : el("form", { class: "stack", onsubmit: onStart }, [
          field("Your name", "name", state.nameDraft, (value) => {
            state.nameDraft = value;
          }, { placeholder: "Alex", maxlength: "24", autocomplete: "nickname" }),
          emailField("Email", "email", state.emailDraft, (value) => {
            state.emailDraft = value;
          }),
          el("p", { class: "hint", text: "We email you a link to confirm it. It is how you get back in if you lose your code." }),
          el("button", {
            class: "btn",
            type: "submit",
            text: state.invitePreview?.name ? `Join ${state.invitePreview.name}` : "Continue",
            disabled: Boolean(state.inviteError),
          }),
          state.inviteError
            ? el("button", {
                class: "btn secondary",
                type: "button",
                text: "Start my own circle",
                onclick: () => {
                  state.inviteError = "";
                  state.invitePreview = null;
                  state.pendingCode = "";
                  state.codeDraft = "";
                  history.replaceState(null, "", "/");
                  render();
                },
              })
            : null,
          el("button", {
            class: inviting ? "btn secondary" : "btn ghost",
            type: "button",
            text: inviting ? "I already have an account" : "I have a recovery code",
            onclick: () => {
              state.sheet = "recover";
              state.codeDraft = "";
              state.error = "";
              render();
            },
          }),
        ]),
    el("div", { class: "gate-links" }, [
      state.pendingCode || state.inviteError || recovering
        ? null
        : el("a", { class: "gate-about", href: "/welcome", text: "What is Spontaco?" }),
      el("a", { class: "gate-about", href: "/privacy", text: "Privacy" }),
    ]),
  ]);
}

export function useNamedCircleDefault() {
  const name = state.me?.user?.name?.trim();
  if (name && (state.circleDraft === "friends" || !state.circleDraft.trim())) {
    state.circleDraft = `${name}'s circle`;
  }
}

function setup() {
  return el("section", { class: "gate" }, [
    ...accountNotices(),
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
    personalAlerts(),
  ]);
}

function shell() {
  forgetShownFeedLink();
  forgetShownAgentToken();
  const phone = el("div", { class: "phone" });
  if (state.chat) {
    phone.append(chatScreen());
    // The event details sheet opened from the chat title stacks on top of the chat.
    if (state.sheet === "event-detail") phone.append(sheet());
    return phone;
  }
  if (state.past) {
    phone.append(pastScreen());
    return phone;
  }
  if (state.statusMessage) phone.append(el("p", { class: "status-banner", role: "status", text: state.statusMessage }));
  phone.append(...accountNotices());
  // Only an explicit tab bar switch fades in (render() plays it); sheet closes, Back and the 3s refresh renders never do.
  const screens = { home, map: mapScreen, circle: circleScreen, alerts: alertsScreen, you: youScreen };
  const page = screens[state.tab]?.();
  if (page) {
    page.classList.add("page");
    page.dataset.page = state.tab;
    phone.append(page);
  }
  phone.append(tabbar());
  if (state.sheet) phone.append(sheet());
  return phone;
}

/** The page, and the Events month list that scrolls inside the page, back to the top. Smooth unless reduced motion. */
function scrollPageTop() {
  const scroll = window.AppKit?.scroll;
  const scrollers = [window, document.querySelector(".cal")].filter(Boolean);
  for (const node of scrollers) {
    if (scroll) scroll.toTop(node);
    else node.scrollTo(0, 0);
  }
}

function tabbar() {
  const tabs = [
    ["home", "Now", "home"],
    // The Events tab (formerly Map): the id stays "map" so routing and hashes do not move.
    ["map", "Events", "calendar"],
    ["chat", "Chat", "chat"],
    ["circle", "Circle", "compass"],
    ["you", "You", "person"],
  ];
  const unread = circleUnread();
  // ak-tabbar, ak-tab and ak-tab-icon bring the kit's icon dip and landing motion; .tabbar and .tab keep Hangry's look.
  return el("nav", { class: "tabbar ak-tabbar" }, tabs.map(([id, label, glyph]) => {
    const current = state.tab === id;
    const name = id === "chat" && unread ? `Chat, ${unread} unread` : label;
    const glyphNode = icon(glyph);
    glyphNode.classList.add("ak-tab-icon");
    return el("button", {
      class: "tab ak-tab",
      type: "button",
      "aria-label": name,
      "aria-current": current ? "page" : null,
      onclick: () => {
        // Chat is its own screen, not a page. A tap on the page already showing is not a switch.
        if (id !== "chat" && (id !== state.tab || state.chat)) pageEntrance = true;
        // A tap on the tab already showing also jumps that page to the top. onTab has redrawn by its first await.
        const again = id !== "chat" && id === state.tab && !state.chat;
        const pending = onTab(id);
        if (again) {
          scrollPageTop();
          // The Events refetch redraws the month and would cut the scroll short, so finish it once that is done.
          void pending.finally(scrollPageTop);
        }
      },
    }, [
      glyphNode,
      el("span", { class: "tab-label", text: label }),
      id === "chat" && unread
        ? el("span", { class: "badge", role: "img", "aria-label": `${unread > 9 ? "9+" : unread} new`, text: unread > 9 ? "9+" : String(unread) })
        : null,
    ]);
  }));
}
