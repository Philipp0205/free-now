import { state } from "./state.js";
import { api } from "./session.js";
import { render } from "./render.js";
import { actingCircle } from "./events.js";
import { el, scheduleErrorClear, weroEntry } from "./lib.js";

/** "12.50" to "€12.50". The server sends the amount already formatted. */
export function euro(amount) {
  return `€${amount}`;
}

/** "€12.50 per person", or null when the event has no price. */
export function priceLine(item, cls = "card-price") {
  const pay = item?.payment;
  if (!pay) return null;
  return el("p", { class: cls, text: `${euro(pay.amount)} per person` });
}

function me() {
  return state.me?.user?.id || "";
}

/** Same rule the server checks: the organizer, the collector, or the person themselves. */
function canTick(item, member) {
  const pay = item.payment;
  return me() === item.creator?.id || me() === pay.collector.id || me() === member.id;
}

function statusText(item, member) {
  if (member.collector) return "collects";
  return member.paid ? `Paid · by ${member.setByName || "someone"}` : `Owes ${euro(item.payment.amount)}`;
}

/**
 * Puts a fresh event from the server into every list that may show it, and into the open detail sheet when that
 * sheet came from Bills (a settled event has left the bills list, so the sheet keeps its own copy).
 * Bills are marked stale so the next look reloads them.
 */
export function replaceEvent(kind, fresh) {
  const lists = kind === "plan"
    ? [state.plans, state.mapPlans, state.calendarPlans]
    : [state.socials, state.mapSocials, state.calendarSocials];
  for (const list of lists) {
    const at = (list || []).findIndex((row) => row.id === fresh.id);
    if (at >= 0) list[at] = fresh;
  }
  const detail = state.eventDetail;
  if (detail?.item && detail.kind === kind && detail.id === fresh.id) detail.item = fresh;
  if (state.bills) {
    state.bills.stale = true;
    for (const bill of [...(state.bills.owe || []), ...(state.bills.owed || [])]) {
      if (bill.kind === kind && bill.id === fresh.id) bill.event = fresh;
    }
  }
}

/**
 * Pay options for a going member who is not the collector: a PayPal link with the amount, the Wero email with Copy,
 * or a hint when the collector has neither.
 */
export function paySection(item) {
  const pay = item?.payment;
  if (!pay) return null;
  const mine = pay.members.find((member) => member.id === me());
  if (!mine || mine.collector) return null;
  const collector = pay.collector;
  const paypal = typeof collector.paypalUrl === "string" && collector.paypalUrl.startsWith("https://www.paypal.me/")
    ? el("a", {
      class: "btn pay-paypal",
      href: collector.paypalUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      text: `Pay ${euro(pay.amount)} with PayPal`,
      "aria-label": `Pay ${euro(pay.amount)} with PayPal`,
    })
    : null;
  const wero = collector.weroEmail
    ? el("div", { class: "pay-wero" }, [
      weroEntry({ id: collector.id, name: collector.name, weroEmail: collector.weroEmail }, "wero-entry full"),
      el("p", { class: "help", text: `Send ${euro(pay.amount)} to ${collector.name} with Wero.` }),
    ])
    : null;
  return el("section", { class: "pay-section", "aria-label": "Pay" }, [
    el("h3", { class: "members-title", text: `Pay ${collector.name}` }),
    paypal,
    wero,
    paypal || wero ? null : el("p", { class: "help pay-hint", text: `${collector.name} has not added PayPal or Wero yet. They can add one in their profile.` }),
  ]);
}

/** Who paid, visible to everyone in the circle. Ticking is for the organizer, the collector, or yourself. */
export function paidList(kind, item) {
  const pay = item?.payment;
  if (!pay) return null;
  return el("div", { class: "pay-paid" }, [
    el("h3", { class: "members-title", text: "Who paid" }),
    el("div", { class: "list paid-list", role: "group", "aria-label": "Who paid" }, pay.members.map((member) => paidRow(kind, item, member))),
  ]);
}

function paidRow(kind, item, member) {
  const status = el("span", { class: "paid-status", text: statusText(item, member) });
  if (member.collector) {
    return el("div", { class: "paid-row" }, [el("span", { class: "paid-name", text: member.name }), status]);
  }
  const box = el("input", {
    type: "checkbox",
    class: "paid-box",
    checked: member.paid,
    disabled: !canTick(item, member),
    "aria-label": `Mark ${member.name} paid`,
  });
  box.addEventListener("change", () => { void tick(kind, item, member, box, status); });
  return el("label", { class: "paid-row" }, [box, el("span", { class: "paid-name", text: member.name }), status]);
}

/**
 * Posts the tick. The checkbox stays in place (no re-render) so a tap is not lost; the status text is updated
 * from the server answer and the lists get the fresh event.
 */
async function tick(kind, item, member, box, status) {
  const want = box.checked;
  box.disabled = true;
  try {
    const result = await api(`/api/${kind}s/${item.id}/paid`, { method: "POST", body: { userId: member.id, paid: want }, circle: actingCircle(item) });
    const fresh = result[kind];
    replaceEvent(kind, fresh);
    const row = fresh.payment?.members.find((entry) => entry.id === member.id);
    if (row) {
      box.checked = row.paid;
      status.textContent = statusText(fresh, row);
    }
    box.disabled = !canTick(fresh, member);
  } catch (error) {
    box.checked = !want;
    box.disabled = false;
    state.error = error.message || "Something went wrong. Try again.";
    render();
    scheduleErrorClear();
  }
}

/** The edit sheet's starting values. */
export function paymentEditState(item) {
  const pay = item.payment;
  const start = pay && pay.collector.id !== item.creator?.id ? pay.collector.id : "";
  return { price: pay ? pay.amount : "", collectorId: start, collectorStart: start, priceStart: pay ? pay.amount : "" };
}

/** Candidates for Who collects: going members who already paid, besides the organizer. */
function collectorChoices(item) {
  return (item.payment?.members || []).filter((member) => member.paid && member.id !== item.creator?.id);
}

/** Price per person, and who collects once someone has paid. Organizer only. */
export function paymentFields(edit, item) {
  const price = el("input", {
    id: "admin-price",
    class: "sheet-control",
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    placeholder: "Optional, in euros",
    value: edit.price,
    oninput: (event) => {
      const had = Boolean(edit.price.trim());
      edit.price = event.target.value;
      // Show or hide Who collects as the price appears or goes away, without losing the field's focus.
      if (had !== Boolean(edit.price.trim())) syncCollector(edit, item);
    },
  });
  const slot = el("div", { id: "admin-collector-slot" });
  const fields = el("div", { class: "pay-fields" }, [
    el("label", { class: "sheet-group" }, [el("span", { class: "sheet-label", text: "Price per person" }), price]),
    slot,
  ]);
  syncCollector(edit, item, slot);
  return fields;
}

function syncCollector(edit, item, given) {
  const slot = given || document.getElementById("admin-collector-slot");
  if (!slot) return;
  slot.replaceChildren();
  const choices = collectorChoices(item);
  if (!edit.price.trim() || !choices.length) return;
  const select = el("select", {
    id: "admin-collector",
    class: "sheet-control",
    onchange: (event) => { edit.collectorId = event.target.value; },
  }, [
    el("option", { value: "", text: `${item.creator.name} (organizer)` }),
    ...choices.map((member) => el("option", { value: member.id, text: member.name })),
  ]);
  select.value = choices.some((member) => member.id === edit.collectorId) ? edit.collectorId : "";
  slot.append(el("label", { class: "sheet-group" }, [el("span", { class: "sheet-label", text: "Who collects" }), select]));
}

/** The price and collector keys for the save body. Only the organizer sends them, and the collector only when changed. */
export function paymentBody(edit, item) {
  if (item.creator?.id !== me()) return {};
  const body = {};
  const price = edit.price.trim();
  if (price !== edit.priceStart) body.price = price || null;
  if (price && edit.collectorId !== edit.collectorStart) body.collectorId = edit.collectorId || null;
  return body;
}
