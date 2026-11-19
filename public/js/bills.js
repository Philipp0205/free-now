import { state } from "./state.js";
import { api } from "./session.js";
import { render } from "./render.js";
import { el, run, skeletonList } from "./lib.js";
import { shortDate } from "./when.js";
import { calToday } from "./events.js";
import { euro, paySection, replaceEvent } from "./event-pay.js";
import { openEventDetail } from "./event-sheets.js";

/** A list this old is fetched again the next time the You menu shows. */
const FRESH_MS = 30000;

let billsSeq = 0;

function userId() {
  return state.me?.user?.id || "";
}

/**
 * Open bills across every circle: what I owe and what others owe me, from GET /api/bills.
 * The old lists stay on screen while a reload runs, and a failed load is not retried until asked.
 */
export async function loadBills() {
  const seq = ++billsSeq;
  const who = userId();
  const prev = state.bills;
  state.bills = { ...(prev || {}), loading: true, failed: false, stale: false };
  try {
    const data = await api("/api/bills", { circle: null });
    if (seq !== billsSeq || !who || who !== userId()) return;
    state.bills = { loaded: true, loading: false, at: Date.now(), stale: false, owe: data.owe, owed: data.owed, totals: data.totals };
  } catch {
    if (seq !== billsSeq || !who || who !== userId()) return;
    state.bills = { ...(prev || {}), loading: false, failed: true, at: Date.now() };
  }
  if (state.tab !== "you") return;
  if (state.youSection === "bills") render();
  // On the menu only the one summary line changes, so patch it in place instead of rebuilding the page.
  else if (!state.youSection) document.querySelector('.page .nav-row[aria-label="Bills"] p')?.replaceChildren(billsSummary());
}

/** Starts a load when nothing is loaded yet, something changed, or the list is old. Never loops on a failure. */
export function ensureBills() {
  const data = state.bills;
  if (!data) return void loadBills();
  if (data.loading || data.failed) return;
  if (data.stale || Date.now() - (data.at || 0) > FRESH_MS) void loadBills();
}

/** The one-line summary on the You menu row. */
export function billsSummary() {
  const data = state.bills;
  if (!data?.loaded) return "Who owes what";
  const { oweCents, owedCents, owe, owed } = data.totals;
  if (!oweCents && !owedCents) return "All settled";
  const parts = [];
  if (oweCents) parts.push(`${euro(owe)} to pay`);
  if (owedCents) parts.push(`${euro(owed)} owed to you`);
  return parts.join(" · ");
}

async function onMarkPaid(bill, personId) {
  await run(async () => {
    const result = await api(`/api/${bill.kind}s/${bill.id}/paid`, {
      method: "POST",
      body: { userId: personId, paid: true },
      circle: bill.circleId,
    });
    replaceEvent(bill.kind, result[bill.kind]);
    state.error = "Marked paid";
    await loadBills();
  });
}

function meta(bill, extra) {
  return [shortDate(bill.day, calToday()), bill.circleName, extra].filter(Boolean).join(" · ");
}

function billHead(bill, extra) {
  return el("button", {
    class: "bill-head",
    type: "button",
    onclick: () => openEventDetail(bill.kind, bill.event, "bills"),
  }, [
    el("span", { class: "bill-main" }, [
      el("strong", { class: "bill-title", text: bill.title }),
      el("span", { class: "bill-meta", text: meta(bill, extra) }),
    ]),
    el("span", { class: "bill-amount", text: euro(bill.amount) }),
  ]);
}

function oweCard(bill) {
  return el("div", { class: "panel bill", "data-bill": `${bill.kind}:${bill.id}` }, [
    billHead(bill, `${bill.collector.name} collects`),
    paySection(bill.event),
    el("button", {
      class: "btn secondary",
      type: "button",
      text: "Mark paid",
      "aria-label": `Mark ${bill.title} paid`,
      onclick: () => { void onMarkPaid(bill, userId()); },
    }),
  ]);
}

function owedCard(bill) {
  return el("div", { class: "panel bill", "data-bill": `${bill.kind}:${bill.id}` }, [
    billHead(bill, bill.unpaid.length === 1 ? "1 to pay" : `${bill.unpaid.length} to pay`),
    el("div", { class: "list bill-people", role: "group", "aria-label": `Who owes for ${bill.title}` }, bill.unpaid.map((person) => (
      el("div", { class: "bill-person" }, [
        el("span", { class: "bill-person-name", text: person.name }),
        el("span", { class: "bill-person-amount", text: euro(bill.event.payment.amount) }),
        el("button", {
          class: "text-btn",
          type: "button",
          text: "Mark paid",
          "aria-label": `Mark ${person.name} paid`,
          onclick: () => { void onMarkPaid(bill, person.id); },
        }),
      ])
    ))),
  ]);
}

function group(title, label, bills, card) {
  if (!bills.length) return null;
  return el("section", { class: "bill-group", "aria-label": label }, [
    el("h3", { class: "members-title", text: title }),
    ...bills.map(card),
  ]);
}

/** The Bills screen under You: totals, then what I owe, then what is owed to me. */
export function billsSection() {
  const data = state.bills;
  if (!data?.loaded) {
    if (data?.failed) {
      return [el("div", { class: "panel stack" }, [
        el("p", { class: "help", text: "Could not load your bills." }),
        el("button", { class: "btn secondary", type: "button", text: "Try again", onclick: () => { void loadBills(); } }),
      ])];
    }
    return [el("div", { class: "panel" }, [skeletonList(3)])];
  }
  const settled = !data.owe.length && !data.owed.length;
  // A tick made elsewhere (the detail sheet) leaves the list stale. loadBills clears the flag at once, so this runs once.
  if (data.stale && !data.loading) void loadBills();
  return [
    el("section", { class: "panel bills-totals", "aria-label": "Totals" }, settled
      ? [el("p", { class: "bills-settled", text: "All settled" }), el("p", { class: "help", text: "Nothing to pay and nobody owes you." })]
      : [
        el("div", { class: "bills-total" }, [el("span", { text: "You owe" }), el("strong", { text: euro(data.totals.owe) })]),
        el("div", { class: "bills-total" }, [el("span", { text: "Owed to you" }), el("strong", { text: euro(data.totals.owed) })]),
      ]),
    data.failed ? el("p", { class: "help bills-note", text: "Could not refresh. Showing the last list." }) : null,
    group("You owe", "You owe", data.owe, oweCard),
    group("Owed to you", "Owed to you", data.owed, owedCard),
    el("p", { class: "help bills-note", text: "Events with a price, across all your circles. Past ones stay until everyone has paid." }),
  ];
}
