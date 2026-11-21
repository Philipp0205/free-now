import { state } from "../state.js";
import { api } from "../session.js";
import { render } from "../render.js";
import { chatTargetUrl, syncChatAlerts } from "../alerts.js";
import { tick } from "../replies.js";
import { scheduleErrorClear } from "../lib.js";
import { APP_VERSION } from "../app.js";
import { setChat } from "../chat-store.js";
import {
  addPollOption,
  dropPollOption,
  newPollDraft,
  pollPayload,
  postErrorText,
  setPollOption,
  setPollQuestion,
  voteErrorText,
} from "./poll-logic.js";

/** Writes the poll sheet's draft to `state` and the signal. Only the sheet repaints; no app render() while typing. */
function setDraft(draft) {
  state.chatPoll = draft;
  setChat({ chatPoll: draft });
}

/** Opens the poll sheet in an event chat. A circle chat has no polls. */
export function openPoll() {
  if (!state.chat || state.chat.kind === "circle") return;
  tick();
  state.chatPoll = newPollDraft();
  Object.assign(state, { chatReactFor: null, chatWho: null });
  setChat({ chatPoll: state.chatPoll, chatReactFor: null, chatWho: null });
  // render() so the scroll lock, the Back entry and the focus rules apply like any other sheet.
  render();
  document.getElementById("poll-question")?.focus({ preventScroll: true });
}

/** Closes the sheet and drops the draft. */
export function closePoll() {
  if (!state.chatPoll) return false;
  state.chatPoll = null;
  setChat({ chatPoll: null });
  render();
  document.querySelector(".chat-poll-btn")?.focus({ preventScroll: true });
  return true;
}

export function editQuestion(text) {
  if (state.chatPoll) setDraft(setPollQuestion(state.chatPoll, text));
}

export function editOption(index, text) {
  if (state.chatPoll) setDraft(setPollOption(state.chatPoll, index, text));
}

export function addOption() {
  if (!state.chatPoll) return;
  setDraft(addPollOption(state.chatPoll));
  const fields = document.querySelectorAll(".poll-option-input");
  fields[fields.length - 1]?.focus({ preventScroll: true });
}

export function removeOption(index) {
  if (state.chatPoll) setDraft(dropPollOption(state.chatPoll, index));
}

/** Posts the poll. On success the thread comes back with it and the sheet closes; a failure keeps the sheet open with the reason. */
export async function submitPoll(event) {
  event.preventDefault();
  const draft = state.chatPoll;
  if (!draft || draft.busy || !state.chat) return;
  const poll = pollPayload(draft);
  if (!poll) return;
  tick();
  const target = { kind: state.chat.kind, id: state.chat.id };
  setDraft({ ...draft, busy: true, message: "" });
  try {
    const chat = (await api(chatTargetUrl(target), { method: "POST", body: { poll, appVersion: APP_VERSION } })).chat;
    if (state.chat?.kind === target.kind && state.chat.id === target.id) state.chatThread = chat;
    state.chatStick = true;
    void syncChatAlerts(target);
    state.chatPoll = null;
    setChat({ chatPoll: null });
    render();
  } catch (error) {
    if (error.status === 401) return;
    if (state.chatPoll) setDraft({ ...draft, busy: false, message: postErrorText(error) });
  }
}

/** Votes for an option, or moves your vote to it. The server's counts replace the poll in the thread. */
export async function voteFor(message, index) {
  if (!message.poll || message.poll.mine === index) return;
  tick();
  try {
    const result = await api(`/api/messages/${encodeURIComponent(message.id)}/vote`, { method: "POST", body: { choice: index } });
    const current = state.chatThread?.messages?.find((item) => item.id === message.id);
    if (current) current.poll = result.poll;
  } catch (error) {
    if (error.status === 401) return;
    state.error = voteErrorText(error);
    scheduleErrorClear();
  }
  render();
}
