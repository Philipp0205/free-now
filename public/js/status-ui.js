import { activeStatus, busyUntilPresets, statusBadge, statusLine, statusUntilDay, statusLabel, STATUS_TEXT_MAX, STATUS_PLACE_MAX, statusToday, untilFromClock } from "./status.js";
import { state } from "./state.js";
import { api } from "./session.js";
import { render } from "./render.js";
import { el, field, run, userTz, viewerTz } from "./lib.js";

/** The active status the person set by hand. Weekly hours do not count. */
function manualStatus() {
  const status = activeStatus(state.me.user.status);
  return status && status.source !== "schedule" ? status : null;
}

/** "Busy until" quick picks as chips. `isOn` marks the chosen one in the editor. */
function busyPresetChips(onPick, isOn = () => false) {
  return el("div", { class: "busy-presets", role: "group", "aria-label": "Busy until" }, busyUntilPresets(Date.now(), userTz()).map((preset) => el("button", {
    type: "button",
    class: isOn(preset) ? "chip on" : "chip",
    "aria-pressed": isOn(preset) ? "true" : "false",
    text: preset.label,
    onclick: () => onPick(preset),
  })));
}

/** Away / Busy on the You tab: a summary with Edit and Clear, or quick Busy picks and two buttons that open the editor. */
export function statusPanel() {
  const status = activeStatus(state.me.user.status);
  if (state.statusDraft) return statusEditor();
  if (status) {
    const fromHours = status.source === "schedule";
    return el("div", { class: "panel status-panel", "data-status": status.type }, [
      el("h3", { text: "Your status" }),
      el("p", { class: "status-summary" }, [
        el("span", { class: "status-card-mark", "aria-hidden": "true", text: statusBadge(status.type) }),
        el("span", { text: statusLine(status, Date.now(), viewerTz()) }),
      ]),
      el("p", {
        class: "help",
        text: fromHours
          ? "From your weekly hours. Friends only see that you're busy or free, and until when."
          : "People in your circles see this next to your name.",
      }),
      el("div", { class: "status-actions" }, fromHours
        ? [
            el("button", { class: "btn secondary", type: "button", text: "Set a status", onclick: () => editStatus("busy") }),
            el("button", { class: "text-btn", type: "button", text: "Edit weekly hours", onclick: editBusyHours }),
          ]
        : [
            el("button", { class: "btn secondary", type: "button", text: "Edit status", onclick: () => editStatus(status.type) }),
            el("button", { class: "text-btn", type: "button", text: "Clear status", onclick: () => { void onClearStatus(); } }),
          ]),
    ]);
  }
  return el("div", { class: "panel status-panel" }, [
    el("h3", { text: "Status" }),
    el("p", { class: "help", text: "Busy for a bit, or away for a while? Let your circles know." }),
    el("p", { class: "busy-presets-label", text: "Busy until" }),
    busyPresetChips((preset) => { void onQuickBusy(preset); }),
    el("div", { class: "status-actions two" }, [
      el("button", { class: "btn secondary", type: "button", text: "\u2708\ufe0f Set Away", onclick: () => editStatus("away") }),
      el("button", { class: "btn secondary", type: "button", text: "\u23f3 Set Busy", onclick: () => editStatus("busy") }),
    ]),
  ]);
}

async function onQuickBusy(preset) {
  await run(async () => {
    state.me = await api("/api/me/status", {
      method: "PUT",
      body: { type: "busy", until: preset.until, timezone: userTz() },
    });
    state.statusDraft = null;
    state.error = "Status saved";
  });
}

function editStatus(type) {
  const current = manualStatus();
  state.statusDraft = {
    type,
    text: current?.text || "",
    place: current?.place || "",
    untilDay: statusUntilDay(current),
    until: current?.type === "busy" && type === "busy" ? current.until ?? null : null,
    preset: "",
    clock: "",
  };
  render();
  requestAnimationFrame(() => document.getElementById("status-text")?.focus({ preventScroll: true }));
}

function statusEditor() {
  const draft = state.statusDraft;
  const busy = draft.type === "busy";
  const typeButton = (type) => el("button", {
    type: "button",
    class: draft.type === type ? "on" : "",
    "aria-pressed": draft.type === type ? "true" : "false",
    text: statusLabel(type),
    onclick: () => {
      draft.type = type;
      render();
    },
  });
  return el("form", { class: "panel stack status-panel status-editor", onsubmit: onSaveStatus }, [
    el("h3", { id: "status-type-label", text: "Your status" }),
    el("div", { class: "segment", role: "group", "aria-labelledby": "status-type-label" }, [typeButton("away"), typeButton("busy")]),
    field("Note (optional)", "status-text", draft.text, (value) => { draft.text = value; }, {
      maxlength: String(STATUS_TEXT_MAX),
      placeholder: "Tennis vacation in Portugal",
    }),
    field("Where (optional)", "status-place", draft.place, (value) => { draft.place = value; }, {
      maxlength: String(STATUS_PLACE_MAX),
      placeholder: "Portugal",
    }),
    ...(busy
      ? [
          el("p", { class: "busy-presets-label", text: "Busy until" }),
          busyPresetChips((preset) => {
            draft.until = preset.until;
            draft.preset = preset.id;
            draft.clock = "";
            render();
          }, (preset) => draft.preset === preset.id),
          el("label", { class: "field" }, [
            el("span", { text: "Or until a time" }),
            el("input", {
              id: "status-until-time",
              class: "sheet-control",
              type: "time",
              value: draft.clock || "",
              oninput: (event) => setBusyClock(draft, event.target.value),
              onchange: (event) => {
                setBusyClock(draft, event.target.value);
                render();
              },
            }),
          ]),
          el("p", { class: "help", text: "It clears itself at that time. Friends only see that you're busy or free, and until when." }),
        ]
      : [
          el("label", { class: "field" }, [
            el("span", { text: "Until (optional)" }),
            el("input", {
              id: "status-until",
              class: "sheet-control",
              type: "date",
              min: statusToday(),
              value: draft.untilDay || "",
              oninput: (event) => { draft.untilDay = event.target.value; },
              onchange: (event) => { draft.untilDay = event.target.value; },
            }),
          ]),
          el("p", { class: "help", text: "It clears itself after that day. Leave it empty to keep it until you clear it." }),
        ]),
    el("div", { class: "status-actions" }, [
      el("button", { class: "btn", type: "submit", text: "Save status" }),
      el("button", { class: "text-btn", type: "button", text: "Cancel", onclick: () => { state.statusDraft = null; render(); } }),
    ]),
  ]);
}

/** A custom time sets the end to its next occurrence. The page redraws on change, not on every keystroke. */
function setBusyClock(draft, value) {
  draft.clock = value;
  draft.preset = "";
  draft.until = untilFromClock(value, Date.now(), userTz());
}

async function onSaveStatus(event) {
  event.preventDefault();
  const draft = state.statusDraft;
  if (!draft) return;
  const busy = draft.type === "busy";
  await run(async () => {
    state.me = await api("/api/me/status", {
      method: "PUT",
      body: busy
        ? { type: draft.type, text: draft.text, place: draft.place, until: draft.until || null, untilDay: null, timezone: userTz() }
        : { type: draft.type, text: draft.text, place: draft.place, untilDay: draft.untilDay || null, until: null },
    });
    state.statusDraft = null;
    state.error = "Status saved";
  });
}

async function onClearStatus() {
  await run(async () => {
    state.me = await api("/api/me/status", { method: "DELETE" });
    state.statusDraft = null;
    state.error = "Status cleared";
  });
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BUSY_BLOCKS_MAX = 3;

/** "Mon–Fri 09:00 to 17:00" for one block: runs of consecutive days are joined. */
function busyBlockText(block) {
  const days = [...new Set(block.days)].sort((a, b) => a - b);
  const runs = [];
  for (const day of days) {
    const last = runs[runs.length - 1];
    if (last && last[1] === day - 1) last[1] = day;
    else runs.push([day, day]);
  }
  const names = runs.map(([from, to]) => {
    if (from === to) return WEEKDAYS[from - 1];
    return to === from + 1 ? `${WEEKDAYS[from - 1]}, ${WEEKDAYS[to - 1]}` : `${WEEKDAYS[from - 1]}\u2013${WEEKDAYS[to - 1]}`;
  });
  return `${names.join(", ")} ${block.start} to ${block.end}`;
}

/** Weekly busy hours on the You tab: a summary with Edit and Remove, or a button that opens the editor. */
export function busyHoursPanel() {
  if (state.hoursDraft) return busyHoursEditor();
  const schedule = state.me.user.busyHours;
  if (!schedule?.blocks?.length) {
    return el("div", { class: "panel stack hours-panel" }, [
      el("h3", { text: "Weekly hours" }),
      el("p", { class: "help", text: "Set hours when you're usually busy, like weekdays 9 to 5. Friends only see that you're busy or free, and until when." }),
      el("button", { class: "btn secondary", type: "button", text: "Set weekly hours", onclick: editBusyHours }),
    ]);
  }
  return el("div", { class: "panel stack hours-panel" }, [
    el("h3", { text: "Weekly hours" }),
    el("div", { class: "hours-summary" }, schedule.blocks.map((block) => el("p", { text: busyBlockText(block) }))),
    el("p", { class: "help", text: `Times are in your time zone (${schedule.timezone}). Friends only see that you're busy or free, and until when.` }),
    el("div", { class: "status-actions" }, [
      el("button", { class: "btn secondary", type: "button", text: "Edit weekly hours", onclick: editBusyHours }),
      el("button", { class: "text-btn", type: "button", text: "Remove weekly hours", onclick: () => { void onRemoveBusyHours(); } }),
    ]),
  ]);
}

function editBusyHours() {
  const saved = state.me.user.busyHours?.blocks;
  state.hoursDraft = {
    blocks: saved?.length
      ? saved.map((block) => ({ days: [...block.days], start: block.start, end: block.end }))
      : [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
  };
  render();
}

function busyHoursEditor() {
  const draft = state.hoursDraft;
  const blocks = draft.blocks.map((block, index) => el("div", { class: "hours-block", "data-block": String(index) }, [
    el("div", { class: "hours-days", role: "group", "aria-label": `Days for block ${index + 1}` }, WEEKDAYS.map((name, i) => {
      const day = i + 1;
      const on = block.days.includes(day);
      return el("button", {
        type: "button",
        class: on ? "chip on" : "chip",
        "aria-pressed": on ? "true" : "false",
        text: name,
        onclick: () => {
          block.days = on ? block.days.filter((d) => d !== day) : [...block.days, day].sort((a, b) => a - b);
          render();
        },
      });
    })),
    el("div", { class: "hours-times" }, [
      el("label", { class: "field" }, [
        el("span", { text: "From" }),
        el("input", {
          class: "sheet-control hours-start",
          type: "time",
          value: block.start,
          oninput: (event) => { block.start = event.target.value; },
          onchange: (event) => { block.start = event.target.value; },
        }),
      ]),
      el("label", { class: "field" }, [
        el("span", { text: "To" }),
        el("input", {
          class: "sheet-control hours-end",
          type: "time",
          value: block.end,
          oninput: (event) => { block.end = event.target.value; },
          onchange: (event) => { block.end = event.target.value; },
        }),
      ]),
    ]),
    draft.blocks.length > 1
      ? el("button", {
          class: "text-btn",
          type: "button",
          text: "Remove",
          "aria-label": `Remove block ${index + 1}`,
          onclick: () => { draft.blocks.splice(index, 1); render(); },
        })
      : null,
  ]));
  return el("form", { class: "panel stack hours-panel hours-editor", onsubmit: onSaveBusyHours }, [
    el("h3", { text: "Weekly hours" }),
    ...blocks,
    draft.blocks.length < BUSY_BLOCKS_MAX
      ? el("button", {
          class: "text-btn",
          type: "button",
          text: "Add another block",
          onclick: () => { draft.blocks.push({ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }); render(); },
        })
      : null,
    el("p", { class: "help", text: `Times are in your time zone (${userTz()}). Friends only see that you're busy or free, and until when.` }),
    el("div", { class: "status-actions" }, [
      el("button", { class: "btn", type: "submit", text: "Save weekly hours" }),
      el("button", { class: "text-btn", type: "button", text: "Cancel", onclick: () => { state.hoursDraft = null; render(); } }),
    ]),
  ]);
}

async function onSaveBusyHours(event) {
  event.preventDefault();
  const draft = state.hoursDraft;
  if (!draft) return;
  await run(async () => {
    if (draft.blocks.some((block) => !block.days.length)) {
      state.error = "Pick at least one day";
      return;
    }
    const body = await api("/api/me/busy-hours", {
      method: "PUT",
      body: { timezone: userTz(), blocks: draft.blocks.map((block) => ({ days: block.days, start: block.start, end: block.end })) },
    });
    state.hoursDraft = null;
    state.me = await api("/api/me");
    state.error = body.schedule ? "Weekly hours saved" : "Weekly hours removed";
  });
}

async function onRemoveBusyHours() {
  await run(async () => {
    await api("/api/me/busy-hours", { method: "DELETE" });
    state.hoursDraft = null;
    state.me = await api("/api/me");
    state.error = "Weekly hours removed";
  });
}
