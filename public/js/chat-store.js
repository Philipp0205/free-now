import { batch, signal } from "@preact/signals";
import { options } from "preact";
import { GOBLIN, mentionMatches } from "./mentions.js";

// Signal writes repaint on a microtask. flushChat() paints right now, for the spots that measure or focus the DOM next.
let pendingPaint = null;
options.debounceRendering = (process) => {
  pendingPaint = process;
  queueMicrotask(flushChat);
};

export function flushChat() {
  const process = pendingPaint;
  pendingPaint = null;
  if (process) process();
}

/**
 * Chat view state as signals. The plain `state` object stays the source of truth for the rest of the app:
 * chat.js copies the chat fields in here (syncChatSignals) when render() or a chat action runs,
 * and a chat action that changes one writes both, so existing writers keep working.
 */

/** { thread }, replaced on every sync. The thread is edited in place (a reaction, a poll), so its own identity says nothing. */
export const chatThread = signal({ thread: null });
export const chatMeId = signal(null);
export const chatMeName = signal("");
export const chatStatus = signal("");
export const chatDraft = signal("");
/** Open @ autocomplete: { start, query, index }. */
export const chatMention = signal(null);
/** Message id whose quick-reaction bar is open. */
export const chatReactFor = signal(null);
/** Pill whose names are showing: { id, emoji }. */
export const chatWho = signal(null);
/** Message id whose emoji picker is open under its reaction bar. It closes with the bar (see setChat). */
export const chatPicker = signal(null);
/** Message the composer replies to: { id, name, text, mine, color }. */
export const chatReplyTo = signal(null);
/** Message id lit up for a moment after a jump to its quote. */
export const chatFlash = signal(null);
/** The open GIF sheet: { reply: { id, name, mine } | null, from, status, gifs, message }. Null when closed. */
export const chatGif = signal(null);
/** GIFs are on (the server has a Giphy key). Off hides the composer button and the reaction-bar control. */
export const chatGifOn = signal(false);
/** The open poll sheet: { question, options, busy, message }. Null when closed. */
export const chatPoll = signal(null);
/** The message being edited in place: { id, text, busy }. Null when none. The draft lives in the box, not here. */
export const chatEdit = signal(null);
/** The photo staged in the composer: { blob, url, sending }. Null when none. */
export const chatPhoto = signal(null);

/** The signal behind each chat field of `state`, by the same name. */
export const CHAT_FIELDS = { chatDraft, chatMention, chatReactFor, chatWho, chatReplyTo, chatGif, chatPoll, chatEdit, chatPhoto };

/** Writes chat fields to the signals only. Callers write `state` first. Only the views that read a changed field repaint. */
export function setChat(patch) {
  batch(() => {
    // A bar that closes or moves to another message takes its picker with it. A repaint of the same bar keeps it.
    if ("chatReactFor" in patch && patch.chatReactFor !== chatReactFor.peek()) chatPicker.value = null;
    for (const [key, value] of Object.entries(patch)) CHAT_FIELDS[key].value = value;
  });
}

/** The thread was edited in place (a reaction) or replaced: repaint the list. */
export function bumpThread(thread) {
  chatThread.value = { thread };
}

const swipes = new Map();

/** Per-message swipe: null, or { dx, ready }. Only that row reads it, so a drag repaints one row. */
export function swipeSignal(id) {
  let sig = swipes.get(id);
  if (!sig) {
    sig = signal(null);
    swipes.set(id, sig);
  }
  return sig;
}

/** Everything back to empty, for when the chat screen is dropped. */
export function resetChatSignals() {
  batch(() => {
    for (const sig of swipes.values()) sig.value = null;
    swipes.clear();
    chatThread.value = { thread: null };
    chatMeId.value = null;
    chatMeName.value = "";
    chatStatus.value = "";
    chatFlash.value = null;
    chatPicker.value = null;
    for (const sig of Object.values(CHAT_FIELDS)) sig.value = sig === chatDraft ? "" : null;
  });
}

/** You can react once you are one of the chat's people and were not removed. */
export function canReact() {
  const thread = chatThread.value.thread;
  if (!thread || thread.removed) return false;
  return (thread.participants || []).some((person) => person.id === chatMeId.value);
}

/** Reply needs an open composer too, so a closed chat only takes reactions. */
export function canReply() {
  return canReact() && !chatThread.value.thread?.closed;
}

/** Who can be tagged: the chat's people, never you, and the Goblin. */
export function mentionChoices() {
  const pick = chatMention.value;
  if (!pick) return [];
  return mentionMatches([...(chatThread.value.thread?.participants || []), GOBLIN], pick.query, chatMeId.value);
}
