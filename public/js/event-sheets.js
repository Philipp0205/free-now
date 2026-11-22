import { shortDate, planDayChoice, planDayDate } from "./when.js";
import { cardCrowd } from "./map-pin.js";
import { planGradientClass } from "./card-grad.js";
import { cardColorField } from "./plans/card-color-ui.js";
import { audiencePlace } from "./place.js";
import { emptyWhereSession, state } from "./state.js";
import { api, isNetworkFailure, refresh } from "./session.js";
import { render } from "./render.js";
import { canManageEvent, linkify } from "./cards.js";
import { chatRow } from "./chat.js";
import { deliveryLine } from "./push-install.js";
import { calPlanOver, calSocialDay, calSocialOver, calToday, mapCircleLine, mapEvents } from "./events.js";
import { appTz, clock, el, mapsHref, payLink, remaining, run, scheduleErrorClear, weroEntry } from "./lib.js";
import { PICK_DATE_ERROR, planDayBlock, planTimeError, saveOnlyFromButton, sheetField } from "./composer.js";
import { arrivalDefault, chooseArrival, replyLine } from "./replies.js";
import { cardActions, planOpen } from "./plan-share.js";
import { whereBlock, wherePayload } from "./where.js";
import { guestDetailRow, planReplyLine } from "./map-card.js";
import { avatar } from "./avatars.js";
import { closeSheet } from "./sheets.js";
import { euro, paidList, paySection, paymentBody, paymentEditState, paymentFields } from "./event-pay.js";
import { MAYBE_COPY } from "./plans/maybe-copy.js";
import { endFromItem, endError, endPayload, eventRange } from "./plans/event-end.js";
import { endField } from "./plans/event-end-ui.js";
import { invitePeople, invitesFromItem, inviteBody } from "./plans/private-event.js";
import { inviteField, privateMarker } from "./plans/private-event-ui.js";
import { emptyPhotoDraft } from "./plans/event-photo-draft.js";
import { savePhotoDraft } from "./plans/event-photo.js";
import { eventPhoto, photoField } from "./plans/event-photo-ui.js";
import { liveToggle } from "./map-places/live-ui.js";

export function openEventDetail(kind, item, from = "") {
  if (!item?.id) return;
  state.cardMenu = null;
  // Bills can show an event no list holds (over and settled), so that sheet keeps its own copy.
  state.eventDetail = { kind, id: item.id, from, ...(from === "bills" ? { item } : {}) };
  state.sheet = "event-detail";
  render();
}

function eventDetailItem() {
  const detail = state.eventDetail;
  if (!detail) return null;
  return findEvent(detail.kind, detail.id) || detail.item || null;
}

/** An event by id from Home, then the map, then the calendar month. */
function findEvent(kind, id) {
  const lists = kind === "plan"
    ? [state.plans, mapEvents().plans, state.calendarPlans]
    : [state.socials, mapEvents().socials, state.calendarSocials];
  for (const list of lists) {
    const found = list.find((row) => row.id === id);
    if (found) return found;
  }
  return null;
}

/**
 * The sheet's reply buttons (In and Maybe). The calendar and the compact list also get the chat row
 * and Share, as before; a card already has those behind the sheet. None on an ended event or in Bills.
 */
function detailActions(kind, item, { calendar, compact, over, mine, bills }) {
  const full = calendar || compact;
  const chat = full ? chatRow(kind, item) : null;
  const skip = over || bills || (mine && !full);
  const reply = skip ? null : cardActions(kind, item, { locked: mine, maybe: true, share: full });
  if (!chat && !reply) return null;
  return el("div", { class: "detail-actions" }, [chat, reply]);
}

/** The sheet's when line. An event with an end shows its range ("19:00 - 22:00"). */
function detailWhen(kind, item, over) {
  const range = eventRange(kind, item, Date.now(), appTz());
  if (kind === "plan") {
    const time = range || item.time;
    return `${item.whenLabel}${time ? ` · ${time}` : ""}${over ? " · Ended" : ""}`;
  }
  if (over) return `${shortDate(calSocialDay(item), calToday())} · ${range || clock(item.startsAt ?? item.createdAt)} · Ended`;
  if (range) return range;
  return item.startsAt && item.startsAt > Date.now() ? `from ${clock(item.startsAt)}` : remaining(item.expiresAt);
}

export function eventDetailSheet() {
  const detail = state.eventDetail;
  const item = eventDetailItem();
  if (!detail || !item) {
    return el("div", {}, [
      el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
      el("div", { class: "sheet", role: "dialog", "aria-label": "Details" }, [
        el("div", { class: "sheet-head" }, [
          el("div", { class: "grabber" }),
          el("h2", { text: "Details" }),
          el("p", { class: "help", text: "This hangout is gone." }),
        ]),
      ]),
    ]);
  }
  const kind = detail.kind;
  const title = item.note || (kind === "plan" ? "Plan" : "Free now");
  const calendar = detail.from === "calendar";
  const over = (calendar || detail.from === "bills") && (kind === "plan" ? calPlanOver(item) : calSocialOver(item));
  const mine = item.creator?.id === state.me.user.id;
  const when = detailWhen(kind, item, over);
  const crowd = cardCrowd(item.creator, item.joined);
  const line = (person) => (kind === "plan" ? planReplyLine(person) : replyLine(person, item));
  const personRow = (text, person) => over
    ? el("div", { class: "guest-row" }, [avatar(person), el("p", { class: "reply-line", text }), payLink(person), weroEntry(person)])
    : guestDetailRow(text, person, kind, item);
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("div", { class: "sheet", role: "dialog", "aria-label": "Details", "data-snap": `event-detail:${kind}:${item.id}` }, [
      el("div", { class: kind === "plan" ? `sheet-head card-grad ${planGradientClass(item)}` : "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: title }),
        el("p", { class: "help", text: `${when} · ${item.creator.name}` }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        calendar ? mapCircleLine(item) : null,
        calendar && kind === "plan" ? planCirclesLine(item) : null,
        privateMarker(item, "detail-private"),
        eventPhoto(kind, item, "event-photo detail-photo"),
        kind === "plan" && item.description ? el("p", { class: "detail-desc" }, linkify(item.description)) : null,
        item.place || item.location ? el("p", { class: "detail-place", text: audiencePlace(item.place) || "nearby" }) : null,
        item.payment ? el("p", { class: "detail-price", text: `${euro(item.payment.amount)} per person · ${item.payment.collector.name} collects` }) : null,
        deliveryLine(kind, item),
        over ? null : liveToggle(kind, item),
        detailActions(kind, item, { calendar, compact: detail.from === "compact", over, mine, bills: detail.from === "bills" }),
        el("h3", { class: "members-title", text: "Who's in" }),
        el("div", { class: "list" }, crowd.people.map((person) => personRow(
          person.id === item.creator.id ? `${person.name} · host` : line(person), person,
        ))),
        crowd.maybe.length ? el("h3", { class: "members-title", text: MAYBE_COPY.group }) : null,
        crowd.maybe.length ? el("div", { class: "list maybe-list" }, crowd.maybe.map((person) => (
          personRow(line(person), person)
        ))) : null,
        crowd.cant.length ? el("h3", { class: "members-title", text: "Can't make it" }) : null,
        crowd.cant.length ? el("div", { class: "list cant-list" }, crowd.cant.map((person) => (
          personRow(line(person), person)
        ))) : null,
        paySection(item),
        paidList(kind, item),
      ]),
      !over && canManageEvent(item) ? el("div", { class: "sheet-dock" }, [
        el("button", {
          class: "btn danger",
          type: "button",
          text: kind === "plan" ? "End plan" : "End",
          onclick: () => endManaged(kind, item),
        }),
      ]) : null,
    ]),
  ]);
}

export function openArrivalPicker(kind, item, value) {
  state.arrivalPick = {
    kind,
    id: item.id,
    value: /^\d{2}:\d{2}$/.test(value) ? value : (arrivalDefault(kind, item) || ""),
  };
  state.sheet = "arrival";
  render();
}

export function arrivalSheet() {
  const pick = state.arrivalPick;
  if (!pick) return el("div");
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", {
      class: "sheet",
      role: "dialog",
      "aria-label": "Pick arrival",
      onsubmit: (event) => {
        event.preventDefault();
        const value = document.getElementById("arrival-time")?.value || pick.value;
        const kind = pick.kind;
        const item = findEvent(kind, pick.id);
        state.arrivalPick = null;
        state.sheet = null;
        if (item && value) chooseArrival(kind, item, value);
        else render();
      },
    }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Pick arrival" }),
        el("p", { class: "help", text: "When do you think you'll get there?" }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("label", { class: "sheet-group" }, [
          el("span", { class: "sheet-label", text: "Time" }),
          el("input", {
            id: "arrival-time",
            class: "sheet-control",
            type: "time",
            step: "60",
            value: pick.value,
            "aria-label": "Pick time",
            oninput: (event) => { pick.value = event.target.value; },
          }),
        ]),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn", type: "submit", text: "Save" }),
      ]),
    ]),
  ]);
}

export function mapsUrl(lat, lng, label) {
  if (lat == null || lng == null) return "";
  return mapsHref(lat, lng, label);
}

export function openAdminEdit(kind, item) {
  const time = kind === "social" ? (item.startsAt ? clock(item.startsAt) : "") : (item.time || "");
  const session = emptyWhereSession();
  const place = item.place || "";
  const lat = item.location?.lat ?? null;
  const lng = item.location?.lng ?? null;
  if (place || lat != null || lng != null) {
    session.where = { mode: "place", place, lat, lng, precise: lat != null && lng != null };
    session.whereQuery = place;
  }
  const day = kind === "plan" ? planDayChoice(item.forDate, Date.now(), appTz()) : "";
  state.adminEdit = {
    kind,
    id: item.id,
    note: item.note || "",
    description: item.description || "", cardColor: item.cardColor ?? null,
    time,
    startTime: time,
    end: endFromItem(item, appTz()),
    day,
    date: item.forDate || "",
    shared: kind === "plan" && Boolean(item.shareId) && item.creator?.id === state.me.user.id,
    invites: invitesFromItem(item),
    photo: emptyPhotoDraft(),
    ...paymentEditState(item),
    ...session,
  };
  state.sheet = "admin-edit";
  render();
}

export function adminEditSheet() {
  const edit = state.adminEdit;
  if (!edit) return el("div");
  const paymentItem = findEvent(edit.kind, edit.id);
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", "aria-label": "Edit", ...saveOnlyFromButton(saveAdminEdit) }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Edit" }),
        el("p", { class: "help", text: "This updates it for everyone in the circle." }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("div", { class: "sheet-form" }, [
          sheetField("Note", "admin-note", edit.note, (value) => { edit.note = value; }, { maxlength: "80" }),
          edit.kind === "plan" ? descriptionField(edit) : null,
          edit.kind === "plan" ? cardColorField(edit) : null,
          edit.kind === "plan" ? planDayBlock(edit, "admin") : null,
          el("label", { class: "sheet-group" }, [
            el("span", { class: "sheet-label", text: edit.kind === "plan" ? "Time" : "Time (empty means now)" }),
            el("input", {
              id: "admin-time",
              class: "sheet-control",
              type: "time",
              value: edit.time,
              oninput: (event) => { edit.time = event.target.value; },
            }),
            edit.kind === "plan" ? planTimeError() : null,
          ]),
          endField(edit.end, render, "admin-end"),
          paymentItem && paymentItem.creator?.id === state.me.user.id ? photoField(edit.photo, paymentItem, edit.kind) : null,
          paymentItem && paymentItem.creator?.id === state.me.user.id
            ? inviteField(edit.invites, invitePeople(state.me?.circle?.members, paymentItem, state.me.user.id))
            : null,
          whereBlock(edit),
          paymentItem && paymentItem.creator?.id === state.me.user.id ? paymentFields(edit, paymentItem) : null,
          edit.shared ? el("button", { class: "btn ghost stop-sharing", type: "button", text: "Stop sharing", onclick: () => { void stopSharing(edit); } }) : null,
        ]),
      ]),
      el("div", { class: "sheet-dock" }, [
        el("button", { class: "btn", type: "submit", text: "Save" }),
      ]),
    ]),
  ]);
}

/** Host of an open plan, in more than one circle. Same rule the server checks in readPlanCircles. */
export function canShareCircles(plan) {
  return Boolean(plan?.creator?.id) && plan.creator.id === state.me?.user?.id
    && (state.me.circles || []).length > 1
    && Boolean(plan.circles?.length)
    && !plan.removedBy
    && planOpen(plan);
}

export function openShareCircles(plan) {
  const mine = new Set((state.me.circles || []).map((circle) => circle.id));
  state.shareCircles = {
    id: plan.id,
    home: plan.circles[0],
    picked: new Set(plan.circles.slice(1).map((circle) => circle.id).filter((id) => mine.has(id))),
    busy: false,
    error: "",
  };
  state.sheet = "share-circles";
  render();
}

/** Home circle fixed, toggle chips for the host's other circles. Saves only the circle set. */
export function shareCirclesSheet() {
  const share = state.shareCircles;
  if (!share) return el("div");
  const others = (state.me.circles || []).filter((circle) => circle.id !== share.home.id);
  return el("div", {}, [
    el("button", { class: "scrim", type: "button", "aria-label": "Close", onclick: closeSheet }),
    el("form", { class: "sheet", role: "dialog", "aria-label": "Share with other circles", ...saveOnlyFromButton(saveShareCircles) }, [
      el("div", { class: "sheet-head" }, [
        el("div", { class: "grabber" }),
        el("h2", { text: "Share with other circles" }),
        el("p", { class: "help", text: "Same plan, same chat and guest list. New circles get one notification." }),
      ]),
      el("div", { class: "sheet-scroll" }, [
        el("div", { class: "sheet-form" }, [
          el("div", { class: "sheet-group" }, [
            el("span", { class: "sheet-label", text: "Always in" }),
            el("div", { class: "also-circles" }, [
              el("span", { class: "chip chip-fixed", text: share.home.name }),
            ]),
          ]),
          el("div", { class: "sheet-group" }, [
            el("span", { class: "sheet-label", id: "share-circles-label", text: "Your other circles" }),
            el("div", { class: "also-circles", role: "group", "aria-labelledby": "share-circles-label" }, others.map((circle) => {
              const on = share.picked.has(circle.id);
              return el("button", {
                type: "button",
                class: on ? "chip on" : "chip",
                "aria-pressed": on ? "true" : "false",
                text: circle.name,
                onclick: () => {
                  if (share.picked.has(circle.id)) share.picked.delete(circle.id);
                  else share.picked.add(circle.id);
                  share.error = "";
                  render();
                },
              });
            })),
          ]),
          share.error ? el("p", { class: "time-error", role: "alert", text: share.error }) : null,
        ]),
      ]),
      el("div", { class: "sheet-dock stack" }, [
        el("button", { class: "btn", type: "submit", text: share.busy ? "Saving…" : "Save", disabled: share.busy }),
        el("button", { class: "btn ghost", type: "button", text: "Cancel", onclick: closeSheet }),
      ]),
    ]),
  ]);
}

async function saveShareCircles(event) {
  event.preventDefault();
  const share = state.shareCircles;
  if (!share || share.busy) return;
  const circleIds = [share.home.id, ...share.picked];
  share.busy = true;
  share.error = "";
  render();
  try {
    // Circles only: the server keeps every other field, so this is never a move.
    await api(`/api/plans/${share.id}`, { method: "PATCH", body: { circleIds } });
  } catch (error) {
    share.busy = false;
    share.error = isNetworkFailure(error)
      ? "You're offline. Try again."
      : error.status >= 500 ? "Something went wrong. Try again." : (error.message || "Something went wrong. Try again.");
    if (state.shareCircles === share) render();
    return;
  }
  state.shareCircles = null;
  state.sheet = null;
  await refresh({ initial: true });
  state.error = circleIds.length > 1 ? `Shared with ${circleIds.length} circles` : `Now only in ${share.home.name}`;
  render();
  scheduleErrorClear();
}

/** "Friends + Climbing" when a plan is in more than one circle. */
export function planCirclesLine(plan) {
  if (!plan?.circles || plan.circles.length < 2) return null;
  return el("p", { class: "plan-circles", text: plan.circles.map((circle) => circle.name).join(" + ") });
}

async function stopSharing(edit) {
  await run(async () => {
    await api(`/api/plans/${edit.id}/share`, { method: "DELETE" });
    edit.shared = false;
    await refresh({ initial: true });
    state.error = "Link stopped. Old links no longer work.";
    render();
    scheduleErrorClear();
  });
}

export function descriptionField(edit, id = "admin-description") {
  const area = el("textarea", {
    id,
    class: "sheet-control sheet-textarea",
    rows: "3",
    maxlength: "280",
    placeholder: "Optional",
    oninput: (event) => { edit.description = event.target.value; },
  });
  area.value = edit.description;
  return el("label", { class: "sheet-group" }, [
    el("span", { class: "sheet-label", text: "Description" }),
    area,
  ]);
}

async function saveAdminEdit(event) {
  event.preventDefault();
  const edit = state.adminEdit;
  if (!edit) return;
  const note = document.getElementById("admin-note")?.value ?? edit.note;
  const description = document.getElementById("admin-description")?.value ?? edit.description;
  const picked = wherePayload(edit);
  const time = document.getElementById("admin-time")?.value || null;
  const date = edit.kind === "plan" ? planDayDate(edit.day, edit.date, Date.now(), appTz()) : "";
  if (edit.kind === "plan" && !date) {
    state.error = PICK_DATE_ERROR;
    render();
    return;
  }
  const endProblem = endError(edit.end, time || "", edit.kind === "plan");
  if (endProblem) {
    edit.end.error = endProblem;
    render();
    return;
  }
  await run(async () => {
    const body = edit.kind === "social"
      ? { note, place: picked.place, lat: picked.lat, lng: picked.lng }
      : { note, description, place: picked.place, time, date, lat: picked.lat, lng: picked.lng, cardColor: edit.cardColor ?? null };
    // A start that has not moved is not resent: once it has passed, the server would refuse it as "not later today".
    if (edit.kind === "social" && time !== edit.startTime) body.startsAt = time;
    Object.assign(body, endPayload(edit.end));
    if (picked.lat != null && picked.lng != null) body.precise = Boolean(picked.precise);
    const paymentItem = findEvent(edit.kind, edit.id);
    // Only the host may change who it is for; the server refuses anyone else.
    if (paymentItem?.creator?.id === state.me.user.id) body.invitees = inviteBody(edit.invites);
    if (paymentItem) Object.assign(body, paymentBody(edit, paymentItem));
    await api(`/api/${edit.kind}s/${edit.id}`, { method: "PATCH", body });
    const photoNote = paymentItem?.creator?.id === state.me.user.id ? await savePhotoDraft(edit.kind, edit.id, edit.photo) : "";
    state.sheet = null;
    await refresh({ initial: true });
    if (photoNote) state.error = photoNote;
  });
}

export function endManaged(kind, item) {
  const own = item.creator?.id === state.me.user.id;
  const who = item.creator?.name || "They";
  state.confirm = {
    title: "End this?",
    body: own ? "Friends will no longer see it." : `${who} will be told this ended.`,
    confirmLabel: "End",
    action: async () => {
      await run(async () => {
        await api(`/api/${kind}s/${item.id}`, { method: "DELETE" });
        if (state.sheet === "event-detail") closeSheet();
        await refresh({ initial: true });
      });
    },
  };
  render();
}
