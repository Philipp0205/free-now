import { state } from "./state.js";
import { render } from "./render.js";
import { el, isTyping } from "./lib.js";
import { shortDate } from "./when.js";
import { calToday } from "./events.js";
import { euro, paySection } from "./event-pay.js";
import { closeSheet, sheetIsOpen } from "./sheets.js";
import { loadBills, onMarkPaid } from "./bills.js";
import {
  addDismiss, billsReady, oldestDebtDays, readDismissCount, reminderCopy, reminderLevel, resetIfSettled,
  shouldShowReminder, throttleOpen, unpaidItems,
} from "./payment-reminder.js";

/** The rules, copy and counter are in payment-reminder.js. This file wires them to the app and draws the sheet. */

/** Bills older than this are fetched again just before the sheet opens. */
const FRESH_MS = 30000;

/** In memory only, so a fresh page load is always allowed to show it. */
let lastShownAt = null;
/** A show was asked for (cold start or coming back) and has not opened or been dropped yet. */
let pending = false;
/** The level the open sheet was built for, so a re-render never changes the words under the reader. */
let shownLevel = 1;
/** Set while the sheet closes because everything got paid. That is not a dismissal. */
let quiet = false;

function store() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function signedIn() {
  return Boolean(state.token && state.me?.user && state.me.circle && state.me.user.email !== null);
}

/** Something else has the screen. Not a reason to give up: the 3s poll tries again. */
function blocked() {
  return Boolean(
    state.booting
    || state.offline
    || state.linkFlow
    || state.sharePreview
    || document.hidden
    || sheetIsOpen()
    || state.cardMenu
    || state.chat
    || state.past
    || isTyping()
    // The push and install steps go first.
    || !state.remindersChecked,
  );
}

/** Cold start and coming back to the app. Starts from fresh bills, and skips everything inside the throttle window. */
export function requestReminder() {
  if (!signedIn()) return;
  if (state.sheet === "payment-reminder") return;
  if (!throttleOpen(lastShownAt, Date.now())) return;
  pending = true;
  void loadBills();
}

/** Opens the sheet once nothing else is open. Called after each bills load and on the 3s poll. */
export function stepReminder() {
  if (!pending) return;
  if (!signedIn()) {
    pending = false;
    return;
  }
  if (state.bills?.loading) return;
  if (blocked()) return;
  const bills = state.bills;
  if (!billsReady(bills) || !unpaidItems(bills).length) {
    pending = false;
    return;
  }
  if (Date.now() - (bills.at || 0) > FRESH_MS) {
    void loadBills();
    return;
  }
  if (!shouldShowReminder({ bills, now: Date.now(), lastShownAt })) {
    pending = false;
    return;
  }
  shownLevel = reminderLevel({
    dismissCount: readDismissCount(store()),
    ageDays: oldestDebtDays(bills.owe, calToday()),
  });
  lastShownAt = Date.now();
  pending = false;
  state.sheet = "payment-reminder";
  render();
}

/**
 * Every finished bills load comes here. A good load that shows nothing owed puts the dismiss count back to 0
 * (it covers paying from the sheet, from Bills, or anywhere else). The open sheet closes once nothing is left.
 */
export function noteBillsLoaded(ok) {
  if (ok) resetIfSettled(state.bills, store());
  if (state.sheet === "payment-reminder") {
    if (ok && !unpaidItems(state.bills).length) {
      quiet = true;
      try {
        closeSheet();
      } finally {
        quiet = false;
      }
    }
    return;
  }
  if (!pending) return;
  if (!ok) {
    pending = false;
    return;
  }
  stepReminder();
}

/** closeSheet calls this for the reminder. Closing with something still owed counts as a dismissal. */
export function noteReminderClosed() {
  if (quiet) return;
  if ((state.bills?.owe || []).length) addDismiss(store());
}

function reminderRow(bill, today) {
  return el("div", { class: "panel bill", "data-bill": `${bill.kind}:${bill.id}` }, [
    el("div", { class: "bill-head static" }, [
      el("span", { class: "bill-main" }, [
        el("strong", { class: "bill-title", text: bill.title }),
        el("span", { class: "bill-meta", text: [`To ${bill.collector.name}`, bill.circleName, shortDate(bill.day, today)].filter(Boolean).join(" · ") }),
      ]),
      el("span", { class: "bill-amount", text: euro(bill.amount) }),
    ]),
    paySection(bill.event),
    el("button", {
      class: "btn secondary",
      type: "button",
      text: "Mark paid",
      "aria-label": `Mark ${bill.title} paid`,
      onclick: () => { void onMarkPaid(bill, state.me?.user?.id || ""); },
    }),
  ]);
}

export function paymentReminderSheet() {
  const copy = reminderCopy(shownLevel);
  const owe = Array.isArray(state.bills?.owe) ? state.bills.owe : [];
  const today = calToday();
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet payment-reminder", role: "dialog", "aria-label": "Payment reminder", "data-level": String(copy.level) }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: copy.heading }),
        el("p", { class: "help", text: copy.body }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("div", { class: "bill-group", role: "group", "aria-label": "You owe" }, owe.map((bill) => reminderRow(bill, today))),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn ghost", type: "button", text: "Later", onclick: closeSheet }),
      ]),
    ]),
  ]);
}
