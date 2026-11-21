import { TOKEN_KEY, state } from "./state.js";
import { adoptCircle, api, clearSession, refresh, rememberCircle } from "./session.js";
import { render } from "./render.js";
import { copyText, el, field, run } from "./lib.js";
import { considerReminders, noteInviteJoin, reportDisplay } from "./push-install.js";
import { rememberViewerLocation, warmMap } from "./map-card.js";
import { onLogout } from "./you.js";

/**
 * True for an account that has no email yet (made before email was required). The server answers 403 for
 * everything except reading /api/me, signing out and saving an email, so the app shows only the email screen.
 * Strictly null: a cached /api/me from an older build has no email key at all and must not trip this.
 */
export function needsEmail() {
  return Boolean(state.token && state.me?.user && state.me.user.email === null);
}

export function emailField(label, id, value, onValue) {
  return field(label, id, value, onValue, {
    type: "email",
    inputmode: "email",
    autocomplete: "email",
    autocapitalize: "none",
    spellcheck: "false",
    placeholder: "you@example.com",
  });
}

/** Saves the address on the signed in account. The server mails a fresh confirmation link each time. */
export async function saveEmail(email) {
  const data = await api("/api/auth/email", { method: "POST", body: { email } });
  state.me = { ...state.me, user: { ...state.me.user, email: data.email, emailVerifiedAt: data.emailVerifiedAt } };
}

/** Everything that waited for a session: reports, alerts, the poll, the map. Used after sign in and after the email gate. */
function enterApp() {
  state.pushSnooze = false;
  state.signature = "";
  render();
  reportDisplay();
  refresh({ initial: true }).catch(() => {});
  void considerReminders();
  rememberViewerLocation();
  if (state.me?.user) warmMap();
}

async function afterEmailSaved() {
  try {
    state.me = await api("/api/me");
    adoptCircle(state.me);
    if (state.pendingCode && !state.inviteError) {
      try {
        const joined = await api("/api/circles/join", { method: "POST", body: { code: state.pendingCode } });
        rememberCircle(joined.circle.id);
        state.me = await api("/api/me");
        history.replaceState(null, "", "/");
        state.pendingCode = "";
        noteInviteJoin();
      } catch (error) {
        state.error = error.message;
      }
    }
  } catch {
    /* the poll catches up */
  }
  enterApp();
}

async function onSaveGateEmail(event) {
  event.preventDefault();
  await run(async () => {
    await saveEmail(state.emailDraft.trim());
    state.emailDraft = "";
    state.error = "Confirmation link sent";
  });
  if (!needsEmail()) await afterEmailSaved();
}

/** The only screen an account without an email can use. */
export function emailGate() {
  return el("section", { class: "gate", "data-screen": "email-gate" }, [
    el("div", { class: "hero" }, [
      el("h1", { class: "wordmark", text: "Add your email" }),
      el("p", {
        class: "lede",
        text: "Spontaco now keeps an email on every account, so you can always get back in. We will send a link to confirm it.",
      }),
    ]),
    el("form", { class: "stack", onsubmit: onSaveGateEmail }, [
      emailField("Email", "gate-email", state.emailDraft, (value) => {
        state.emailDraft = value;
      }),
      el("button", { class: "btn", type: "submit", text: "Save email" }),
      el("button", { class: "btn ghost", type: "button", text: "Sign out", onclick: onLogout }),
    ]),
    el("div", { class: "gate-links" }, [el("a", { class: "gate-about", href: "/privacy", text: "Privacy" })]),
  ]);
}

export async function onResendEmail() {
  await run(async () => {
    await saveEmail(state.me.user.email);
    state.error = "Confirmation link sent";
  });
}

function notice(label, children) {
  return el("section", { class: "notice", "aria-label": label }, children);
}

function recoveryCard() {
  const code = state.recoveryOnce;
  return notice("Recovery code", [
    el("strong", { text: "Save your recovery code" }),
    el("p", { class: "code-block", text: code }),
    el("p", { text: "It is how you sign back in on another phone, and it is shown only once. You can also get a sign-in link by email." }),
    el("div", { class: "notice-actions" }, [
      el("button", { class: "text-btn", type: "button", text: "Copy", onclick: () => copyText(code, "Recovery code copied") }),
      el("button", {
        class: "text-btn",
        type: "button",
        text: "I saved it",
        onclick: () => {
          state.recoveryOnce = "";
          render();
        },
      }),
    ]),
  ]);
}

function emailBanner(address) {
  return notice("Confirm your email", [
    el("strong", { text: "Confirm your email" }),
    el("p", { text: `We sent a link to ${address}. Until you tap it, a lost code cannot be recovered by email.` }),
    el("div", { class: "notice-actions" }, [
      el("button", { class: "text-btn", type: "button", text: "Resend", onclick: onResendEmail }),
      el("button", {
        class: "text-btn",
        type: "button",
        text: "Change",
        onclick: () => {
          state.tab = "you";
          state.youSection = "account";
          render();
        },
      }),
    ]),
  ]);
}

/** Cards above the page: the one-time recovery code first, then the unconfirmed email. */
export function accountNotices() {
  const out = [];
  if (state.recoveryOnce) out.push(recoveryCard());
  const user = state.me?.user;
  if (user?.email && !user.emailVerifiedAt) out.push(emailBanner(user.email));
  return out;
}

async function onLostCode(event) {
  event.preventDefault();
  await run(async () => {
    await api("/api/auth/lost-code", { method: "POST", body: { email: state.emailDraft.trim() }, token: null });
    state.lostSent = true;
  });
}

export function closeLostCode() {
  state.lostOpen = false;
  state.lostSent = false;
  state.error = "";
  render();
}

/** Replaces the recovery code form on the welcome screen. The answer is the same for every address. */
export function lostCodeForm() {
  if (state.lostSent) {
    return el("div", { class: "stack" }, [
      el("p", {
        class: "hint",
        text: "If that address belongs to an account, a sign-in link is on its way. It works once, for 20 minutes.",
      }),
      el("button", { class: "btn ghost", type: "button", text: "Back", onclick: closeLostCode }),
    ]);
  }
  return el("form", { class: "stack", onsubmit: onLostCode }, [
    emailField("Account email", "lost-email", state.emailDraft, (value) => {
      state.emailDraft = value;
    }),
    el("button", { class: "btn", type: "submit", text: "Email me a link" }),
    el("button", { class: "btn ghost", type: "button", text: "Back", onclick: closeLostCode }),
  ]);
}

const LINK_COPY = {
  verify: {
    title: "Confirm your email",
    lede: "Tap to confirm this address for your Spontaco account.",
    action: "Confirm email",
    done: "Email confirmed.",
  },
  recover: {
    title: "Sign in",
    lede: "Tap to sign in. You get a new recovery code, and the old one stops working.",
    action: "Sign in",
    done: "You're signed in.",
  },
};

/** The page behind a link from an email. Opening it changes nothing; the button posts the token. */
export function linkScreen() {
  const flow = state.linkFlow;
  const copy = LINK_COPY[flow.kind];
  const failed = Boolean(flow.error);
  return el("section", { class: "gate", "data-screen": `link-${flow.kind}` }, [
    el("div", { class: "hero" }, [
      el("button", { class: "orb small", type: "button", "aria-hidden": "true", tabindex: "-1" }),
      el("h1", { class: "wordmark", text: flow.done ? copy.done : failed ? "Link not valid" : copy.title }),
      el("p", { class: "lede", text: flow.done ? "" : failed ? flow.error : copy.lede }),
    ]),
    el("div", { class: "stack" }, [
      flow.done || failed
        ? el("button", { class: "btn", type: "button", text: "Open Spontaco", onclick: onLeaveLink })
        : el("button", {
            class: "btn",
            type: "button",
            text: flow.busy ? "Working…" : copy.action,
            disabled: Boolean(flow.busy),
            onclick: onConfirmLink,
          }),
    ]),
  ]);
}

async function onConfirmLink() {
  const flow = state.linkFlow;
  if (!flow || flow.busy) return;
  flow.busy = true;
  render();
  try {
    if (flow.kind === "verify") {
      const data = await api("/api/auth/verify", { method: "POST", body: { token: flow.token }, token: null });
      if (state.me?.user) {
        state.me = { ...state.me, user: { ...state.me.user, email: data.email, emailVerifiedAt: data.emailVerifiedAt } };
      }
    } else {
      const data = await api("/api/auth/lost-code/consume", { method: "POST", body: { token: flow.token }, token: null });
      // Someone else may be signed in on this phone. Their session ends here; the server keeps it for them.
      clearSession();
      localStorage.setItem(TOKEN_KEY, data.token);
      state.token = data.token;
      state.me = await api("/api/me");
      adoptCircle(state.me);
      state.recoveryOnce = data.recoveryCode;
    }
    flow.done = true;
  } catch (error) {
    flow.error = error.message;
  }
  flow.busy = false;
  render();
}

function onLeaveLink() {
  const signedIn = Boolean(state.token && state.me);
  state.linkFlow = null;
  history.replaceState(null, "", "/");
  if (signedIn) enterApp();
  else render();
}
