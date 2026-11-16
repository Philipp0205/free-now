import { activeStatus, statusLine } from "./status.js";
import { state } from "./state.js";
import { api, clearSession } from "./session.js";
import { render } from "./render.js";
import { alertsBell } from "./alerts.js";
import { onLeave, screenHeader } from "./circles.js";
import { buzzNote, flicPanel, onRotateBuzz } from "./flic.js";
import { busyHoursPanel, statusPanel } from "./status-ui.js";
import { busyPreviewScreen, friendsViewPanel } from "./busy-preview.js";
import { calendarFeedPanel, calendarSyncPanel, copyWithSelection, feedDate } from "./calendar-sync.js";
import { isInstalled, notificationStatusLabel, onInstall, onTestPush, openNotifications } from "./push-install.js";
import { openFeedback, openWhatsNewList } from "./whats-new-ui.js";
import { copyText, el, field, icon, paymentUrlError, run, scheduleErrorClear, viewerTz } from "./lib.js";
import { avatar, onRemovePhoto, pickPhoto } from "./avatars.js";

const YOU_SECTIONS = [
  { id: "profile", title: "Profile" },
  { id: "availability", title: "Availability & calendar" },
  { id: "notifications", title: "Notifications" },
  { id: "assistants", title: "Assistants" },
  { id: "account", title: "Account" },
];

function openYouSection(id) {
  state.youSection = id;
  render();
}

export function closeYouSection() {
  state.youSection = null;
  state.busyPreview = null;
  render();
}

function youSectionSummary(id) {
  if (id === "profile") return state.me.user.name;
  if (id === "availability") {
    const status = activeStatus(state.me.user.status);
    if (status) return statusLine(status, Date.now(), viewerTz());
    if (state.calendarSync?.source === "google") return "Google connected";
    if (state.me.user.calendarConnected || state.calendarSync?.connected) return "Calendar connected";
    return "No status";
  }
  if (id === "notifications") return notificationStatusLabel();
  if (id === "assistants") {
    const tokens = state.agentTokens;
    if (!tokens?.loaded || tokens.failed) return "";
    return tokens.tokens.length === 0 ? "No tokens" : tokens.tokens.length === 1 ? "1 token" : `${tokens.tokens.length} tokens`;
  }
  return "";
}

export function youMenuRow(title, summary, onclick) {
  return el("button", { class: "row nav-row", type: "button", "aria-label": title, onclick }, [
    el("div", { class: "grow" }, [
      el("h3", { text: title }),
      summary ? el("p", { text: summary }) : null,
    ]),
    icon("chevron"),
  ]);
}

export function youScreen() {
  if (state.youSection) return youSectionScreen(state.youSection);
  return el("div", {}, [
    screenHeader("You"),
    el("div", { class: "panel panel-rows" }, YOU_SECTIONS.map((section) => (
      youMenuRow(section.title, youSectionSummary(section.id), () => openYouSection(section.id))
    ))),
    el("div", { class: "panel panel-rows" }, [
      youMenuRow("What's new", "Recent changes to Hangry", () => { void openWhatsNewList(); }),
      youMenuRow("Send feedback", "Ideas, bugs, anything", openFeedback),
    ]),
  ]);
}

function youSectionScreen(id) {
  if (id === "availability" && state.busyPreview?.open) return busyPreviewScreen();
  const section = YOU_SECTIONS.find((item) => item.id === id);
  const bodies = {
    profile: profileSection,
    availability: () => [statusPanel(), friendsViewPanel(), busyHoursPanel(), calendarFeedPanel(), calendarSyncPanel()],
    notifications: notificationsSection,
    assistants: () => [agentTokensPanel()],
    account: accountSection,
  };
  return el("div", { class: "you-section" }, [
    el("header", { class: "chat-head" }, [
      el("button", { class: "text-btn chat-back", type: "button", text: "Back", onclick: closeYouSection }),
      el("h1", { text: section.title }),
      alertsBell(),
    ]),
    ...bodies[id](),
  ]);
}

function profileSection() {
  const hasPhoto = Boolean(state.me.user.avatarRev);
  return [
    el("div", { class: "profile-hero" }, [
      el("button", {
        class: "avatar-btn",
        type: "button",
        "aria-label": hasPhoto ? "Change photo" : "Add photo",
        disabled: state.avatarBusy,
        onclick: pickPhoto,
      }, [avatar(state.me.user, 72, "lg")]),
      el("strong", { text: state.me.user.name }),
      el("div", { class: "photo-actions" }, state.avatarBusy
        ? [el("span", { class: "help", text: "Saving photo…" })]
        : [
            el("button", { class: "text-btn", type: "button", text: hasPhoto ? "Change photo" : "Add photo", onclick: pickPhoto }),
            hasPhoto ? el("button", { class: "text-btn", type: "button", text: "Remove photo", onclick: () => { void onRemovePhoto(); } }) : null,
          ]),
    ]),
    el("form", { class: "panel stack", onsubmit: onRename }, [
      field("Your name", "rename", state.me.user.name, () => {}, { maxlength: "24" }),
      el("button", { class: "btn secondary", type: "submit", text: "Save name" }),
      el("p", { class: "help", text: "Friends see this name on your cards." }),
    ]),
    el("form", { class: "panel stack", novalidate: "", onsubmit: onSavePayment }, [
      field("Payment link", "payment-url", state.me.user.paymentUrl || "", () => {}, {
        type: "url",
        inputmode: "url",
        maxlength: "200",
        placeholder: "https://paypal.me/yourname",
      }),
      el("button", { class: "btn secondary", type: "submit", text: "Save payment link" }),
      el("p", { class: "help", text: "Optional. Circle members see a Pay link next to your name. paypal.me only." }),
    ]),
  ];
}

function notificationsSection() {
  return [
    el("div", { class: "panel" }, [
      el("button", {
        class: "row notif-row",
        type: "button",
        onclick: openNotifications,
      }, [
        el("div", { class: "grow" }, [
          el("h3", { text: "Notifications" }),
          el("p", { text: notificationStatusLabel() }),
        ]),
      ]),
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
  ];
}

function accountSection() {
  const code = state.me.user.buzzToken;
  return [
    el("div", { class: "panel" }, [
      el("button", {
        class: "text-btn",
        type: "button",
        text: state.showRecovery ? "Hide recovery code" : "Show recovery code",
        onclick: () => {
          state.showRecovery = !state.showRecovery;
          render();
        },
      }),
      state.showRecovery
        ? el("div", {}, [
            el("p", { class: "code-block", text: code }),
            el("p", { class: "help", text: "Save this. It is how you sign back in on another phone." }),
            buzzNote(code),
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
          ])
        : null,
    ]),
    flicPanel(code),
    installPanel(),
    donatePanel(),
    el("div", { class: "panel stack" }, [
      el("button", { class: "btn danger", type: "button", text: "Leave circle", onclick: onLeave }),
      el("button", { class: "btn ghost", type: "button", text: "Sign out", onclick: onLogout }),
    ]),
  ];
}

const DONATE_URL = "https://www.paypal.me/philippkurrle1";

/** A voluntary tip. Quiet on purpose: one button in Account, no amounts, nothing opens by itself. */
function donatePanel() {
  const kit = window.AppKit?.donate;
  if (!kit) return null;
  const button = kit.button({ url: DONATE_URL });
  button.classList.add("ak-btn-secondary");
  button.addEventListener("click", () => {
    kit.show({ url: DONATE_URL, appName: "Hangry" });
  });
  return el("div", { class: "panel donate-panel" }, [button]);
}

function installPanel() {
  const installed = isInstalled();
  return el("div", { class: "panel" }, [
    el("button", {
      class: "row install-row",
      type: "button",
      disabled: installed,
      onclick: () => { void onInstall(); },
    }, [
      el("div", { class: "grow" }, [
        el("h3", { text: "Install app" }),
        el("p", { text: installed ? "Installed" : "Add Hangry to your home screen." }),
      ]),
    ]),
  ]);
}

/** Assistant tokens: an outside assistant acts as this person. The full token shows once, right after making it. */
function agentTokensPanel() {
  if (!state.agentTokens) void loadAgentTokens();
  const data = state.agentTokens || { loaded: false };
  const wrap = (kids) => el("section", { class: "panel agent-tokens", "aria-label": "Assistant tokens" }, [
    el("h3", { text: "Assistant tokens" }),
    el("p", { text: "A token lets an assistant act as you: read your circles, set your status, create plans and say you are in. Friends see those actions as you. You can revoke a token at any time and it stops working at once. The full token is shown only once, so copy it now." }),
    ...kids,
  ]);
  if (!data.loaded) return wrap([el("p", { class: "help", text: "Loading…" })]);
  const tokens = data.tokens || [];
  return wrap([
    data.secret ? agentTokenSecret(data.secret) : null,
    el("form", { class: "stack", novalidate: "", onsubmit: (event) => { event.preventDefault(); void onCreateAgentToken(); } }, [
      el("label", { class: "field" }, [
        el("span", { text: "Token name" }),
        el("input", {
          id: "agent-token-name",
          type: "text",
          maxlength: "40",
          autocomplete: "off",
          placeholder: "Grok Bot",
          value: data.draft || "",
          oninput: (event) => { state.agentTokens.draft = event.target.value; },
        }),
      ]),
      el("button", { class: "btn secondary", type: "submit", text: data.busy ? "Creating…" : "Create token", disabled: data.busy }),
    ]),
    data.failed ? el("p", { class: "help", text: "Could not load your tokens." }) : null,
    tokens.length || data.failed ? null : el("p", { class: "help", text: "No tokens yet. Name one after the assistant you want to use it with." }),
    tokens.length ? el("ul", { class: "agent-token-list" }, tokens.map(agentTokenRow)) : null,
  ]);
}

function agentTokenSecret(secret) {
  return el("div", { class: "stack agent-token-once" }, [
    el("p", { class: "agent-token-secret", text: secret }),
    el("p", { class: "help", text: "It will not be shown again. Copy it now and keep it private." }),
    el("button", { class: "btn secondary", type: "button", text: "Copy", onclick: () => { void copyAgentToken(secret); } }),
  ]);
}

function agentTokenRow(token) {
  const used = token.lastUsedAt ? `Last used ${feedDate(token.lastUsedAt)}` : "Not used yet";
  return el("li", { class: "agent-token-row" }, [
    el("div", { class: "grow" }, [
      el("strong", { text: token.name }),
      el("p", { class: "help", text: `${token.tokenPrefix}… · Made ${feedDate(token.createdAt)} · ${used}` }),
    ]),
    el("button", {
      class: "text-btn danger",
      type: "button",
      text: "Revoke",
      "aria-label": `Revoke ${token.name}`,
      onclick: () => onRevokeAgentToken(token),
    }),
  ]);
}

async function copyAgentToken(secret) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(secret);
    copied = true;
  } catch {
    copied = copyWithSelection(secret);
  }
  state.error = copied ? "Token copied" : "Copy failed. Press and hold the token to copy it.";
  render();
  scheduleErrorClear();
}

/** The token shows once. Once the Assistants screen is not on show, it is gone for good. */
export function forgetShownAgentToken() {
  if (!state.agentTokens?.secret) return;
  if (state.tab === "you" && state.youSection === "assistants" && !state.chat && !state.past) return;
  state.agentTokens = { ...state.agentTokens, secret: "" };
}

async function loadAgentTokens() {
  state.agentTokens = { loaded: false };
  try {
    const data = await api("/api/me/agent-tokens", { circle: null });
    if (!state.agentTokens || state.agentTokens.loaded) return;
    state.agentTokens = { loaded: true, tokens: data.tokens, draft: "" };
  } catch {
    state.agentTokens = { loaded: true, failed: true, tokens: [], draft: "" };
  }
  document.querySelector(".agent-tokens")?.replaceWith(agentTokensPanel());
}

async function onCreateAgentToken() {
  const data = state.agentTokens;
  if (!data?.loaded || data.busy) return;
  data.busy = true;
  render();
  await run(async () => {
    try {
      const made = await api("/api/me/agent-tokens", { method: "POST", body: { name: data.draft || "" }, circle: null });
      const list = await api("/api/me/agent-tokens", { circle: null });
      state.agentTokens = { loaded: true, tokens: list.tokens, draft: "", secret: made.token };
    } finally {
      if (state.agentTokens) state.agentTokens.busy = false;
    }
  });
}

function onRevokeAgentToken(token) {
  state.confirm = {
    title: `Revoke ${token.name}?`,
    body: "It stops working at once. Anything using it loses access until you make a new token.",
    confirmLabel: "Revoke",
    action: async () => {
      await run(async () => {
        await api(`/api/me/agent-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE", circle: null });
        const list = await api("/api/me/agent-tokens", { circle: null });
        state.agentTokens = { ...state.agentTokens, tokens: list.tokens, secret: "" };
        state.error = "Token revoked";
      });
    },
  };
  render();
}

async function onRename(event) {
  event.preventDefault();
  const input = document.getElementById("rename");
  await run(async () => {
    state.me = await api("/api/me", { method: "PATCH", body: { name: input.value } });
    state.error = "Name saved";
  });
}

async function onSavePayment(event) {
  event.preventDefault();
  const value = document.getElementById("payment-url").value.trim();
  const problem = paymentUrlError(value);
  if (problem) {
    state.error = problem;
    render();
    scheduleErrorClear();
    return;
  }
  await run(async () => {
    state.me = await api("/api/me", { method: "PATCH", body: { paymentUrl: value } });
    state.error = value ? "Payment link saved" : "Payment link removed";
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
