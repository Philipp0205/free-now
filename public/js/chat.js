import { mentionAt, insertMention, toggledReactions } from "./mentions.js";
import { APP_VERSION } from "./app.js";
import { state } from "./state.js";
import { api, isNetworkFailure, noteConnectionProblem, scheduleOfflineRetry } from "./session.js";
import { prefersTouchUi } from "./keyboard-ui.js";
import { render } from "./render.js";
import { navigate } from "./native.js";
import { chatTargetUrl, eventUnread, forgetOpenUnread, syncChatAlerts } from "./alerts.js";
import { tick } from "./replies.js";
import { forgetRain, noteRainThread } from "./emoji-rain.js";
import { openEventDetail } from "./event-sheets.js";
import { copyText, el, icon, run, scheduleErrorClear } from "./lib.js";
import { batch } from "@preact/signals";
import { EDIT_FAILED, EDIT_GONE, EDIT_OFFLINE } from "./chat/chat-copy.js";
import {
  bumpThread,
  chatFlash,
  chatGifOn,
  chatMeId,
  chatMeName,
  chatPicker,
  chatStatus,
  mentionChoices,
  resetChatSignals,
  setChat,
  swipeSignal,
} from "./chat-store.js";
import { mountChatView, paintChatView, unmountChatView } from "./chat-view.jsx";

export async function openChat(target) {
  state.chatReturn = state.tab;
  state.chat = target;
  state.chatStick = true;
  state.chatReplyTo = null;
  forgetOpenUnread(target);
  // Whatever is in the chat when it opens is old: the first thread only marks messages seen.
  forgetRain();
  // Event chats show their screen (Loading…) at once. The thread fills in when the GET lands, or on the next poll.
  // The circle Chat tab keeps the tab bar while it loads, so a later tab tap wins.
  if (target.kind !== "circle") void navigate(render, "push");
  await run(async () => {
    const chat = (await api(chatTargetUrl(target))).chat;
    // Another tab was tapped while this loaded; that tap wins.
    if (state.chat === target) {
      state.chatThread = chat;
      noteRainThread(chat);
    }
    void syncChatAlerts(target);
  });
}

export function closeChat() {
  forgetRain();
  state.chat = null;
  state.chatThread = null;
  state.chatDraft = "";
  state.chatMention = null;
  state.chatReactFor = null;
  state.chatWho = null;
  state.chatReplyTo = null;
  state.chatGif = null;
  state.chatEdit = null;
  state.tab = state.chatReturn || "home";
  void navigate(() => {
    // The Preact host is dropped with the screen, so the old chat stays on screen until the slide has captured it.
    dropChatScreen();
    render();
  }, "pop");
}

/**
 * The chat screen is one host element that lives for as long as the same chat is open. render() rebuilds #app
 * every time, but it only ever receives this node again, so the Preact tree under it (and the composer's caret,
 * the log's scroll, a swipe or a long-press in flight) is never remounted. It is dropped when the chat closes
 * (closeChat, or render() finding state.chat empty) and when another chat is opened.
 */
let host = null;
let hostKey = "";

function chatKey() {
  return `${state.chat?.kind || ""}:${state.chat?.id || ""}`;
}

export function chatScreen() {
  if (host && hostKey !== chatKey()) dropChatScreen();
  syncChatSignals();
  if (!host) {
    host = el("section", { class: "chat-screen" });
    hostKey = chatKey();
    mountChatView(host, ACTIONS);
  } else {
    paintChatView(host);
  }
  const thread = state.chatThread;
  const me = thread?.participants?.find((person) => person.id === state.me?.user?.id);
  host.setAttribute("aria-label", thread?.title || "Chat");
  if (me) host.setAttribute("style", `--me:${me.color}`);
  else host.removeAttribute("style");
  // The draft is the textarea's value. Something other than typing changed it (a send kept only the unsent tail).
  const input = host.querySelector("#chat-input");
  if (input && input.value !== state.chatDraft) input.value = state.chatDraft;
  return host;
}

/** render() calls this after it swaps the page in: a host that did not make it back into the page means chat was left. */
export function releaseChatScreen() {
  if (host && !host.isConnected) dropChatScreen();
}

/** Unmounts the chat view and drops the host. Called when leaving chat (closeChat, releaseChatScreen) and when another chat opens. */
export function dropChatScreen() {
  if (!host) return;
  endPress();
  swipe = null;
  clearTimeout(flashTimer);
  clearTimeout(gifTimer);
  gifSeq += 1;
  state.chatGif = null;
  state.chatEdit = null;
  unmountChatView(host);
  host = null;
  hostKey = "";
  resetChatSignals();
}

/** Copies the chat fields of the plain state into the signals the view reads. Existing writers keep writing `state`. */
function syncChatSignals() {
  batch(() => {
    // The thread is edited in place (reactions, polls), so a fresh wrapper is what tells the view to repaint.
    bumpThread(state.chatThread);
    chatMeId.value = state.me?.user?.id ?? null;
    chatMeName.value = state.me?.user?.name || "";
    chatStatus.value = state.statusMessage || "";
    chatGifOn.value = Boolean(state.meta?.giphy);
    setChat({
      chatDraft: state.chatDraft,
      chatMention: state.chatMention,
      chatReactFor: state.chatReactFor,
      chatWho: state.chatWho,
      chatReplyTo: state.chatReplyTo,
      chatGif: state.chatGif,
      chatEdit: state.chatEdit,
    });
  });
}

/** A chat action's write: `state` for everyone else, then the signals, so only the views that read them repaint. */
function put(patch) {
  Object.assign(state, patch);
  setChat(patch);
}

/**
 * Repaints the chat from the signals without an app render(): the same scroll rules render() applies, the composer
 * refit and the log kept clear of the bar. A no-op when the chat is not on screen.
 */
function repaint() {
  if (!host) return;
  const log = host.querySelector(".chat-log");
  const y = log?.scrollTop ?? 0;
  const nearEnd = log ? log.scrollHeight - log.scrollTop - log.clientHeight < 48 : true;
  paintChatView(host);
  if (log) {
    log.scrollTop = nearEnd ? log.scrollHeight : y;
    setChatLogPlace(nearEnd, log.scrollTop);
  }
  growComposer(document.getElementById("chat-input"));
  stickChatLog();
}

function onInput(event) {
  const input = event.target;
  put({ chatDraft: input.value });
  growComposer(input);
  noteMentionTyping(input);
}

function onBlur(event) {
  if (!event.target.isConnected || !state.chatMention) return;
  put({ chatMention: null });
}

function noteMentionTyping(input) {
  const found = mentionAt(input.value, input.selectionStart ?? input.value.length);
  const before = state.chatMention;
  put({ chatMention: found ? { ...found, index: before && before.start === found.start ? before.index : 0 } : null });
}

const COMPOSER_MAX = 136;

/** Fits the composer to its text: one line up to about five, then it scrolls. */
export function growComposer(input) {
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX)}px`;
}

function onComposerKey(event) {
  const people = mentionChoices();
  if (!people.length) {
    // A textarea would add a newline; Enter sends, Shift+Enter breaks the line.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      event.target.form?.requestSubmit();
    }
    return;
  }
  const pick = state.chatMention;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    put({ chatMention: { ...pick, index: (Math.min(pick.index, people.length - 1) + step + people.length) % people.length } });
  } else if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    chooseMention(people[Math.min(pick.index, people.length - 1)]);
  } else if (event.key === "Escape") {
    // Only the list closes; the chat stays open.
    event.preventDefault();
    event.stopPropagation();
    put({ chatMention: null });
  }
}

function chooseMention(person) {
  const input = document.getElementById("chat-input");
  const pick = state.chatMention;
  if (!input || !pick) return;
  const next = insertMention(input.value, pick.start, input.selectionStart ?? input.value.length, person.name);
  input.value = next.text;
  growComposer(input);
  put({ chatDraft: next.text, chatMention: null });
  input.focus({ preventScroll: true });
  input.setSelectionRange(next.caret, next.caret);
}

/** One line of a message, for a quote. */
function snippet(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** Puts the composer in reply mode for this message, with the keyboard up. */
function startReply(message) {
  put({
    chatReplyTo: { id: message.id, name: message.name, text: snippet(message.text), mine: message.mine, color: message.color || null },
    chatReactFor: null,
    chatWho: null,
  });
  repaint();
  const input = document.getElementById("chat-input");
  if (!input) return;
  input.focus({ preventScroll: true });
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

/** Drops the reply target. The draft stays. */
export function clearReply() {
  if (!state.chatReplyTo) return false;
  put({ chatReplyTo: null });
  repaint();
  return true;
}

function cancelReply() {
  clearReply();
  document.getElementById("chat-input")?.focus({ preventScroll: true });
}

const FLASH_MS = 1600;
let flashTimer = 0;

/** Scrolls the log to a message and lights it up for a moment. Not loaded: nothing happens. */
function jumpToMessage(id) {
  const row = document.querySelector(`.chat-log .chat-msg[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  chatLogAtEnd = false;
  row.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  // Restart the fade if it is already lit.
  chatFlash.value = null;
  paintChatView(host);
  void row.offsetWidth;
  chatFlash.value = id;
  paintChatView(host);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (chatFlash.peek() === id) chatFlash.value = null;
  }, FLASH_MS);
}

const LONG_PRESS_MS = 400;
let pressTimer = 0;
let pressStart = null;
let pressUsedAt = 0;

/** A long-press just fired, so the click that follows it is not a tap. */
function pressConsumed() {
  return Date.now() - pressUsedAt < 700 || Date.now() - swipeUsedAt < 350;
}

/** Touch and pen: hold a message for the reaction bar, or a pill for who reacted. */
function startPress(event, message) {
  if (event.pointerType === "mouse") return;
  const pill = event.target.closest?.(".react-pill");
  // Chrome's touch adjustment can land a press on the row's Delete, so only the bar itself is left alone.
  if (event.target.closest?.(".react-bar, .chat-edit-form")) return;
  clearTimeout(pressTimer);
  pressStart = { x: event.clientX, y: event.clientY };
  pressTimer = setTimeout(() => {
    pressStart = null;
    pressUsedAt = Date.now();
    tick();
    if (pill) put({ chatWho: { id: message.id, emoji: pill.dataset.emoji } });
    else put({ chatReactFor: message.id, chatWho: null });
    repaint();
  }, LONG_PRESS_MS);
}

function movePress(event) {
  if (!pressStart) return;
  if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 8) endPress();
}

function endPress() {
  clearTimeout(pressTimer);
  pressStart = null;
}

const SWIPE_REPLY_PX = 56;
const SWIPE_MAX_PX = 72;
let swipe = null;
/** When a swipe last started a reply. The click its lift may fire is not a tap. */
let swipeUsedAt = 0;

/** Touch: a short swipe right on a message starts a reply. Up or down is a scroll and lets go. */
function startSwipe(event, message) {
  if (event.pointerType === "mouse" || event.target.closest?.(".react-bar, .chat-edit-form")) return;
  swipe = { message, x: event.clientX, y: event.clientY, at: Date.now(), dx: 0, on: false };
}

function moveSwipe(event) {
  if (!swipe) return;
  const dx = event.clientX - swipe.x;
  const dy = event.clientY - swipe.y;
  // A long-press already opened the bar, or the finger went up or down: not a swipe.
  if (pressUsedAt >= swipe.at || Math.abs(dy) > 24 || (!swipe.on && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx))) {
    dropSwipe();
    return;
  }
  if (!swipe.on && dx > 10 && dx > Math.abs(dy) * 1.5) swipe.on = true;
  if (!swipe.on) return;
  swipe.dx = Math.max(0, Math.min(dx, SWIPE_MAX_PX));
  // Only this row repaints: `swiping`, `--swipe` and `swipe-ready` come from its signal.
  swipeSignal(swipe.message.id).value = { dx: swipe.dx, ready: swipe.dx >= SWIPE_REPLY_PX };
}

function endSwipe() {
  const done = swipe;
  dropSwipe();
  if (!done?.on || done.dx < SWIPE_REPLY_PX) return;
  swipeUsedAt = Date.now();
  tick();
  startReply(done.message);
}

function dropSwipe() {
  if (!swipe) return;
  swipeSignal(swipe.message.id).value = null;
  swipe = null;
}

function rowDown(event, message, replyable) {
  startPress(event, message);
  if (replyable) startSwipe(event, message);
}

function rowMove(event) {
  movePress(event);
  moveSwipe(event);
}

function rowUp() {
  endPress();
  endSwipe();
}

function rowCancel() {
  endPress();
  dropSwipe();
}

/** A held finger opens the reaction bar, not the browser's own menu. */
function rowMenu(event) {
  if (prefersTouchUi()) event.preventDefault();
}

function openReactionBar(message) {
  put({ chatReactFor: state.chatReactFor === message.id ? null : message.id, chatWho: null });
  repaint();
  document.querySelector(".react-bar .react-pick")?.focus({ preventScroll: true });
}

/** Puts the bar or the names away without an app render, so the tap that did it still lands. */
export function closeReactUi() {
  if (!state.chatReactFor && !state.chatWho) return false;
  put({ chatReactFor: null, chatWho: null });
  if (host) paintChatView(host);
  return true;
}

/** The + in the bar: opens or closes the full emoji picker under it. */
function togglePicker(message) {
  const open = chatPicker.peek() !== message.id;
  chatPicker.value = open ? message.id : null;
  repaint();
  if (open) host?.querySelector(".react-picker")?.scrollIntoView({ block: "nearest" });
}

/** The <emoji-picker> for one message, loaded the first time anyone taps + (its own chunk, not in app.js). Null if it cannot load. */
async function buildPicker(messageId) {
  try {
    const { createEmojiPicker } = await import("./emoji-picker.js");
    const picker = createEmojiPicker((emoji) => { void reactTo(messageId, emoji); });
    // A phone keeps its keyboard down until the search box is tapped. A mouse or keyboard can type at once.
    if (!prefersTouchUi()) requestAnimationFrame(() => picker.shadowRoot?.getElementById("search")?.focus({ preventScroll: true }));
    return picker;
  } catch {
    chatPicker.value = null;
    state.error = "Couldn't load the emoji list. Try again.";
    scheduleErrorClear();
    render();
    return null;
  }
}

/** Copy from the bar: the plain message text goes to the clipboard (a GIF copies its link) and a short toast says so. */
function copyMessage(message) {
  tick();
  put({ chatReactFor: null, chatWho: null });
  repaint();
  void copyText(message.gif?.url || message.text, "Copied");
}

const GIF_SEARCH_MS = 300;
let gifTimer = 0;
/** Bumped on every lookup, open and close, so a slow answer for an old search never lands on a newer one. */
let gifSeq = 0;
let gifSending = false;

/** Edits the open GIF sheet and paints it. Nothing else on the chat screen is rebuilt. */
function setGif(patch) {
  if (!state.chatGif) return;
  put({ chatGif: { ...state.chatGif, ...patch } });
  if (host) paintChatView(host);
}

/**
 * Opens the GIF sheet. From a message's reaction bar it answers that message; from the composer it answers
 * whatever the composer is already replying to, or nothing. Does nothing while GIFs are off.
 */
function openGif(message) {
  if (!state.meta?.giphy || !state.chat) return;
  const target = message || state.chatReplyTo;
  tick();
  state.chatGif = {
    reply: target ? { id: target.id, name: target.name, mine: Boolean(target.mine) } : null,
    from: message ? "bar" : "composer",
    query: "",
    status: "loading",
    gifs: [],
    message: "",
  };
  put({ chatGif: state.chatGif, chatReactFor: null, chatWho: null });
  // render() so the scroll lock, the Back entry and the focus rules apply like any other sheet.
  render();
  void loadGifs("");
  // Type at once, on a phone too (the keyboard comes up). preventScroll keeps the page and chat log where they are.
  document.getElementById("gif-query")?.focus({ preventScroll: true });
}

export function closeGif() {
  if (!state.chatGif) return false;
  const from = state.chatGif.from;
  clearTimeout(gifTimer);
  gifSeq += 1;
  state.chatGif = null;
  put({ chatGif: null });
  render();
  if (from === "composer") document.querySelector(".chat-gif-btn")?.focus({ preventScroll: true });
  return true;
}

async function loadGifs(query) {
  gifSeq += 1;
  const mine = gifSeq;
  const text = query.trim();
  setGif({ status: "loading", message: "" });
  try {
    const path = text ? `/api/giphy/search?q=${encodeURIComponent(text)}` : "/api/giphy/trending";
    const result = await api(path);
    if (mine !== gifSeq || !state.chatGif) return;
    setGif({ status: "ready", gifs: Array.isArray(result?.gifs) ? result.gifs : [] });
  } catch (error) {
    if (mine !== gifSeq || !state.chatGif || error.status === 401) return;
    setGif({
      status: "error",
      gifs: [],
      message: error.status === 429 ? "Slow down a moment, then try again." : "GIFs are unavailable right now.",
    });
  }
}

/** Typing in the sheet: the box follows every key, the lookup waits for a pause. An empty box is trending again. */
function searchGifs(value) {
  if (!state.chatGif) return;
  setGif({ query: value });
  clearTimeout(gifTimer);
  gifTimer = setTimeout(() => { void loadGifs(value); }, GIF_SEARCH_MS);
}

function retryGifs() {
  if (state.chatGif) void loadGifs(state.chatGif.query);
}

/** Sends the picked GIF, as a reply when the sheet has a target. A failure keeps the sheet open so another pick is one tap. */
async function pickGif(item) {
  const open = state.chatGif;
  if (!open || !state.chat || gifSending || state.chatQueue) return;
  gifSending = true;
  tick();
  const target = { kind: state.chat.kind, id: state.chat.id };
  const replyTo = open.reply?.id || null;
  const gif = { id: item.id, title: item.title || "", width: item.width, height: item.height, url: item.url };
  try {
    const body = replyTo ? { gif, replyTo, appVersion: APP_VERSION } : { gif, appVersion: APP_VERSION };
    const chat = (await api(chatTargetUrl(target), { method: "POST", body })).chat;
    gifSending = false;
    void syncChatAlerts(target);
    if (state.chat && state.chat.kind === target.kind && state.chat.id === target.id) {
      state.chatThread = chat;
      noteRainThread(chat);
    }
    state.statusMessage = "";
    state.chatStick = true;
    sentReply(replyTo);
    closeGif();
  } catch (error) {
    gifSending = false;
    if (error.status === 401) return;
    state.error = error.status === 0 ? "You're offline. Try again in a moment." : "Couldn't send that GIF. Try again.";
    scheduleErrorClear();
    render();
  }
}

async function reactTo(messageId, emoji) {
  const thread = state.chatThread;
  const message = thread?.messages?.find((item) => item.id === messageId);
  if (!message) return;
  const on = !(message.reactions || []).some((item) => item.emoji === emoji && item.mine);
  tick();
  message.reactions = toggledReactions(message.reactions || [], emoji, state.me?.user?.name || "You");
  put({ chatReactFor: null, chatWho: null });
  repaint();
  try {
    const result = await api(`/api/messages/${encodeURIComponent(messageId)}/reactions`, { method: "POST", body: { emoji, on } });
    const current = state.chatThread?.messages?.find((item) => item.id === messageId);
    if (current) current.reactions = result.reactions;
  } catch (error) {
    if (error.status === 401) return;
    state.error = error.message || "Something went wrong. Try again.";
    try {
      if (state.chat) state.chatThread = (await api(chatTargetUrl(state.chat))).chat;
    } catch {
      /* the next refresh catches up */
    }
    scheduleErrorClear();
  }
  render();
}

/** False once someone scrolls the log up (or jumps to a quoted message), so the keyboard does not pull it back down. */
let chatLogAtEnd = true;
let chatLogTop = 0;
/** render() reports where the log was left after it redraws. */
export function setChatLogPlace(atEnd, top) {
  chatLogAtEnd = atEnd;
  chatLogTop = top;
}

function noteChatLog(log) {
  chatLogAtEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  chatLogTop = log.scrollTop;
}

function noteChatLogScroll(event) {
  noteChatLog(event.currentTarget);
}

export function stickChatLog() {
  const log = document.querySelector(".chat-log");
  const bar = document.querySelector(".chat-compose, .chat-closed");
  // A scroll up that has not reported yet counts too.
  if (!log || !chatLogAtEnd || log.scrollTop < chatLogTop - 4) return;
  const view = window.visualViewport;
  const viewBottom = (view?.offsetTop ?? 0) + (view?.height ?? window.innerHeight);
  const limit = Math.min(viewBottom, bar?.getBoundingClientRect().top ?? viewBottom) - 8;
  const last = log.lastElementChild;
  if (!last) return;
  const box = last.getBoundingClientRect();
  if (box.bottom > limit) log.scrollTop += box.bottom - limit;
  chatLogTop = log.scrollTop;
}

function unsentTail(typed, sent) {
  if (!sent || typed === sent) return typed === sent ? "" : typed;
  if (typed.startsWith(sent)) return typed.slice(sent.length).replace(/^\s+/, "");
  return typed;
}

/** The build label rides along so a @Goblin gripe is filed like the feedback form's. */
function chatBody(text, replyTo) {
  return replyTo ? { text, replyTo, appVersion: APP_VERSION } : { text, appVersion: APP_VERSION };
}

async function sendChat(event) {
  event.preventDefault();
  if (!state.chat || state.chatQueue) return;
  const text = state.chatDraft.trim();
  if (!text) return;
  tick();
  const target = { kind: state.chat.kind, id: state.chat.id };
  const replyTo = state.chatReplyTo?.id || null;
  state.chatQueue = { target, text, replyTo };
  try {
    state.chatThread = (await api(chatTargetUrl(target), { method: "POST", body: chatBody(text, replyTo) })).chat;
    if (state.chat?.kind === target.kind && state.chat.id === target.id) noteRainThread(state.chatThread);
    void syncChatAlerts(target);
    state.chatQueue = null;
    state.chatDraft = unsentTail(state.chatDraft, text);
    sentReply(replyTo);
    state.statusMessage = "";
    state.chatStick = true;
  } catch (error) {
    if (error.status === 401) return;
    if (isNetworkFailure(error) || error.status >= 500) {
      noteConnectionProblem(error);
      scheduleOfflineRetry(1000);
    } else {
      state.chatQueue = null;
      state.error = error.message || "Something went wrong";
    }
  }
  render();
}

/** The reply went out, so the preview goes. A newer reply target picked meanwhile stays. */
function sentReply(id) {
  if (id && state.chatReplyTo?.id === id) state.chatReplyTo = null;
}

export async function flushChatQueue() {
  const queued = state.chatQueue;
  if (!queued) return;
  try {
    const body = chatBody(queued.text, queued.replyTo);
    const thread = (await api(chatTargetUrl(queued.target), { method: "POST", body })).chat;
    state.chatQueue = null;
    state.chatDraft = unsentTail(state.chatDraft, queued.text);
    sentReply(queued.replyTo);
    state.statusMessage = "";
    if (state.chat && state.chat.kind === queued.target.kind && state.chat.id === queued.target.id) {
      state.chatThread = thread;
      noteRainThread(thread);
    }
    state.chatStick = true;
    render();
  } catch (error) {
    if (error.status !== 401 && (isNetworkFailure(error) || error.status >= 500)) noteConnectionProblem(error);
  }
}

async function toggleMute() {
  if (!state.chat || !state.chatThread) return;
  const muted = !state.chatThread.muted;
  await run(async () => {
    await api(`/api/chats/${state.chatThread.id}/mute`, { method: "POST", body: { muted } });
    state.chatThread = (await api(chatTargetUrl(state.chat))).chat;
  });
}

/** Opens the message's text in an edit box in place, with the cursor at the end. Your own text messages only. */
function startEdit(message) {
  if (!message.canEdit || state.chatEdit?.busy) return;
  tick();
  put({ chatEdit: { id: message.id, text: message.text, busy: false }, chatReactFor: null, chatWho: null });
  repaint();
  const input = host?.querySelector(".chat-edit-input");
  if (!input) return;
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Drops the edit box and leaves the original message alone. */
export function cancelEdit() {
  if (!state.chatEdit || state.chatEdit.busy) return false;
  put({ chatEdit: null });
  repaint();
  return true;
}

/** Enter saves, Shift+Enter breaks the line, Escape cancels without closing the chat. */
function onEditKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelEdit();
  } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    event.target.form?.requestSubmit();
  }
}

/** Sends the edited text. On success the row shows the new words and the edited mark; on a failure the box stays open. */
async function saveEdit(event) {
  event.preventDefault();
  const edit = state.chatEdit;
  const text = host?.querySelector(".chat-edit-input")?.value.trim() ?? "";
  if (!edit || edit.busy || !text) return;
  if (text === edit.text) {
    cancelEdit();
    return;
  }
  tick();
  state.chatEdit = { ...edit, busy: true };
  try {
    const result = (await api(`/api/messages/${encodeURIComponent(edit.id)}`, { method: "PATCH", body: { text } })).message;
    const message = state.chatThread?.messages?.find((item) => item.id === edit.id);
    if (message) Object.assign(message, { text: result.text, editedAt: result.editedAt });
    state.chatEdit = null;
  } catch (error) {
    state.chatEdit = { ...edit, busy: false };
    if (error.status === 401) return;
    if (error.status === 403 || error.status === 404) state.chatEdit = null;
    state.error = editErrorText(error);
    scheduleErrorClear();
  }
  render();
}

/** The friendly line for a failed save. */
function editErrorText(error) {
  if (error.status === 0) return EDIT_OFFLINE;
  if (error.status === 403 || error.status === 404) return EDIT_GONE;
  return error.status === 400 && error.message ? error.message : EDIT_FAILED;
}

function confirmDeleteMessage(message) {
  state.confirm = {
    title: "Delete this message?",
    body: "It's removed for everyone in the chat.",
    confirmLabel: "Delete",
    action: async () => {
      await run(async () => {
        await api(`/api/messages/${message.id}`, { method: "DELETE" });
        if (state.chat) state.chatThread = (await api(chatTargetUrl(state.chat))).chat;
      });
    },
  };
  render();
}

/** The chat title opens the event's details sheet on top of the chat. A circle chat has none. */
function openDetails() {
  const target = state.chat;
  if (!target || target.kind === "circle" || !target.id) return;
  openEventDetail(target.kind, { id: target.id });
}

/** What the Preact view calls. Everything else in this file stays private to the chat. */
const ACTIONS = {
  closeChat,
  openDetails,
  toggleMute,
  onLogScroll: noteChatLogScroll,
  pressConsumed,
  jumpToMessage,
  reactTo,
  startReply,
  cancelReply,
  rowDown,
  rowMove,
  rowUp,
  rowCancel,
  rowMenu,
  openReactionBar,
  togglePicker,
  buildPicker,
  copyMessage,
  openGif,
  closeGif,
  searchGifs,
  retryGifs,
  pickGif,
  confirmDelete: confirmDeleteMessage,
  startEdit,
  cancelEdit,
  saveEdit,
  onEditKey,
  send: sendChat,
  onInput,
  onKey: onComposerKey,
  onBlur,
  chooseMention,
};

export function chatChip(kind, id) {
  return chatRow(kind, { id });
}

function eventChatMeta(kind, id) {
  return state.chatSummary?.events?.find((row) => row.kind === kind && row.id === id) || null;
}

export function chatRow(kind, item) {
  const id = item.id;
  const unread = eventUnread(kind, id);
  const meta = eventChatMeta(kind, id);
  const preview = (meta?.preview || "").trim();
  const by = (meta?.previewBy || "").trim();
  const previewText = preview
    ? (by ? `${by}: ${preview}` : preview)
    : "Chat";
  return el("button", {
    class: "chat-row",
    type: "button",
    "aria-label": unread ? `Chat, ${unread} unread` : "Chat",
    onclick: (event) => {
      event.stopPropagation();
      state.cardMenu = null;
      void openChat({ kind, id });
    },
  }, [
    icon("chat"),
    el("div", { class: "chat-row-copy" }, [
      el("strong", { text: "Chat" }),
      preview ? el("span", { class: "chat-row-preview", text: previewText }) : el("span", { class: "chat-row-preview muted", text: "Say hi" }),
    ]),
    unread ? el("span", { class: "badge", text: unread > 9 ? "9+" : String(unread) }) : null,
  ]);
}
