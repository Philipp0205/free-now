import { mentionMatches, mentionAt, insertMention, findMentions, REACTIONS, toggledReactions } from "./mentions.js";
import { zonedParts, clockText } from "./when.js";
import { state } from "./state.js";
import { api, isNetworkFailure, noteConnectionProblem, scheduleOfflineRetry } from "./session.js";
import { prefersTouchUi } from "./keyboard-ui.js";
import { render } from "./render.js";
import { chatTargetUrl, eventUnread, forgetOpenUnread, syncChatAlerts } from "./alerts.js";
import { tick } from "./replies.js";
import { el, icon, run, scheduleErrorClear } from "./lib.js";

export async function openChat(target) {
  state.chatReturn = state.tab;
  state.chat = target;
  state.chatStick = true;
  state.chatReplyTo = null;
  forgetOpenUnread(target);
  // Event chats show their screen (Loading…) at once. The thread fills in when the GET lands, or on the next poll.
  // The circle Chat tab keeps the tab bar while it loads, so a later tab tap wins.
  if (target.kind !== "circle") render();
  await run(async () => {
    const chat = (await api(chatTargetUrl(target))).chat;
    // Another tab was tapped while this loaded; that tap wins.
    if (state.chat === target) state.chatThread = chat;
    void syncChatAlerts(target);
  });
}

export function closeChat() {
  state.chat = null;
  state.chatThread = null;
  state.chatDraft = "";
  state.chatMention = null;
  state.chatReactFor = null;
  state.chatWho = null;
  state.chatReplyTo = null;
  state.tab = state.chatReturn || "home";
  render();
}

export function chatScreen() {
  const thread = state.chatThread;
  const title = thread?.title || "Chat";
  const me = thread?.participants?.find((person) => person.id === state.me?.user?.id);
  return     el("section", { class: "chat-screen", "aria-label": title, style: me ? `--me:${me.color}` : null }, [
    state.statusMessage ? el("p", { class: "status-banner", role: "status", text: state.statusMessage }) : null,
    el("header", { class: "chat-head" }, [
      el("button", { class: "text-btn chat-back", type: "button", text: "Back", onclick: closeChat }),
      el("h1", { text: title }),
      thread
        ? el("button", {
            class: "text-btn",
            type: "button",
            text: thread.muted ? "Unmute" : "Mute",
            onclick: () => { void toggleMute(); },
          })
        : null,
    ]),
    el("div", { class: "chat-log", id: "chat-log", onscroll: noteChatLogScroll }, thread
      ? thread.messages.map((message) => message.system ? systemLine(message) : messageRow(message))
      : [el("p", { class: "help", text: "Loading…" })]),
    thread?.removed
      ? el("p", { class: "chat-closed", text: "You were removed from this event." })
      : thread?.closed
      ? el("p", { class: "chat-closed", text: "This chat is closed." })
      : el("form", { class: "chat-compose", onsubmit: sendChat }, [
          replyPreview(),
          withDraft(el("textarea", {
            id: "chat-input",
            class: "sheet-control",
            rows: "1",
            maxlength: "1000",
            placeholder: "Message",
            autocomplete: "off",
            enterkeyhint: "send",
            "aria-autocomplete": "list",
            "aria-controls": "mention-list",
            oninput: (event) => {
              state.chatDraft = event.target.value;
              growComposer(event.target);
              noteMentionTyping(event.target);
            },
            onkeydown: onComposerKey,
            onblur: (event) => {
              if (!event.target.isConnected || !state.chatMention) return;
              state.chatMention = null;
              paintMentions();
            },
          })),
          el("button", { class: "btn chat-send", type: "submit", text: "Send" }),
          mentionPicker(),
        ]),
  ]);
}

/** Who can be tagged: the chat's people, never you. */
function mentionChoices() {
  const pick = state.chatMention;
  if (!pick) return [];
  return mentionMatches(state.chatThread?.participants || [], pick.query, state.me?.user?.id);
}

function mentionPicker() {
  const people = mentionChoices();
  if (!people.length) return null;
  const index = Math.min(state.chatMention.index, people.length - 1);
  return el("ul", { class: "mention-list", id: "mention-list", role: "listbox", "aria-label": "Mention someone" }, people.map((person, i) =>
    el("li", {
      class: i === index ? "mention-option active" : "mention-option",
      role: "option",
      "aria-selected": i === index ? "true" : "false",
      style: `--person:${person.color}`,
      // Keeps focus (and the keyboard) on the composer.
      onmousedown: (event) => event.preventDefault(),
      onclick: () => chooseMention(person),
    }, [el("span", { class: "mention-dot", "aria-hidden": "true" }), el("span", { text: person.name })])));
}

/** Swaps the list in place, so typing never rebuilds the composer under the keyboard. */
function paintMentions() {
  const form = document.querySelector(".chat-compose");
  if (!form) return;
  form.querySelector(".mention-list")?.remove();
  const next = mentionPicker();
  if (next) form.append(next);
}

function noteMentionTyping(input) {
  const found = mentionAt(input.value, input.selectionStart ?? input.value.length);
  const before = state.chatMention;
  state.chatMention = found ? { ...found, index: before && before.start === found.start ? before.index : 0 } : null;
  paintMentions();
}

const COMPOSER_MAX = 136;

/** The draft is the textarea's value, not child text, so it never reads as page text. */
function withDraft(input) {
  input.value = state.chatDraft;
  return input;
}

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
    pick.index = (Math.min(pick.index, people.length - 1) + step + people.length) % people.length;
    paintMentions();
  } else if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    chooseMention(people[Math.min(pick.index, people.length - 1)]);
  } else if (event.key === "Escape") {
    // Only the list closes; the chat stays open.
    event.preventDefault();
    event.stopPropagation();
    state.chatMention = null;
    paintMentions();
  }
}

function chooseMention(person) {
  const input = document.getElementById("chat-input");
  const pick = state.chatMention;
  if (!input || !pick) return;
  const next = insertMention(input.value, pick.start, input.selectionStart ?? input.value.length, person.name);
  input.value = next.text;
  growComposer(input);
  state.chatDraft = next.text;
  state.chatMention = null;
  paintMentions();
  input.focus({ preventScroll: true });
  input.setSelectionRange(next.caret, next.caret);
}

/** Message text with each @Name of someone in the chat in their colour. Yours is a little stronger. */
function messageText(text) {
  const thread = state.chatThread;
  const colors = new Map();
  for (const message of thread?.messages || []) if (message.color && message.name) colors.set(message.name.toLowerCase(), message.color);
  for (const person of thread?.participants || []) colors.set(person.name.toLowerCase(), person.color);
  const hits = findMentions(text, [...colors.keys()]);
  if (!hits.length) return el("p", { text });
  const me = (state.me?.user?.name || "").trim().toLowerCase();
  const parts = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.start > at) parts.push(text.slice(at, hit.start));
    const key = hit.name.toLowerCase();
    parts.push(el("span", {
      class: key === me ? "mention me" : "mention",
      style: `--person:${colors.get(key)}`,
      text: text.slice(hit.start, hit.end),
    }));
    at = hit.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return el("p", {}, parts);
}

/** You can react once you are one of the chat's people and were not removed. */
function canReact() {
  const thread = state.chatThread;
  if (!thread || thread.removed) return false;
  return (thread.participants || []).some((person) => person.id === state.me?.user?.id);
}

/** Reply needs an open composer too, so a closed chat only takes reactions. */
function canReply() {
  return canReact() && !state.chatThread?.closed;
}

function reactionBar(message) {
  return el("div", { class: "react-bar", role: "toolbar", "aria-label": "React" }, [
    ...REACTIONS.map((emoji) => {
      const mine = (message.reactions || []).some((item) => item.emoji === emoji && item.mine);
      return el("button", {
        class: mine ? "react-pick mine" : "react-pick",
        type: "button",
        "aria-label": `React ${emoji}`,
        "aria-pressed": mine ? "true" : "false",
        text: emoji,
        onclick: () => { if (!pressConsumed()) void reactTo(message.id, emoji); },
      });
    }),
    canReply() && el("button", {
      class: "react-reply",
      type: "button",
      text: "Reply",
      // Keeps focus (and the keyboard) on the composer.
      onmousedown: (event) => event.preventDefault(),
      onclick: () => { if (!pressConsumed()) startReply(message); },
    }),
  ]);
}

/** One line of a message, for a quote. */
function snippet(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** Puts the composer in reply mode for this message, with the keyboard up. */
function startReply(message) {
  state.chatReplyTo = { id: message.id, name: message.name, text: snippet(message.text), mine: message.mine, color: message.color || null };
  state.chatReactFor = null;
  state.chatWho = null;
  render();
  const input = document.getElementById("chat-input");
  if (!input) return;
  input.focus({ preventScroll: true });
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

/** Drops the reply target. The draft stays. */
export function clearReply() {
  if (!state.chatReplyTo) return false;
  state.chatReplyTo = null;
  render();
  return true;
}

function replyPreview() {
  const reply = state.chatReplyTo;
  if (!reply) return null;
  return el("div", { class: "reply-preview", style: reply.color ? `--person:${reply.color}` : null }, [
    el("div", { class: "reply-preview-copy" }, [
      el("strong", { text: reply.mine ? "You" : reply.name }),
      el("span", { text: reply.text }),
    ]),
    el("button", {
      class: "reply-cancel",
      type: "button",
      "aria-label": "Cancel reply",
      onmousedown: (event) => event.preventDefault(),
      onclick: () => {
        clearReply();
        document.getElementById("chat-input")?.focus({ preventScroll: true });
      },
    }, [icon("close")]),
  ]);
}

/** The message a reply answers, one line. A deleted one says so and goes nowhere. */
function replyQuote(quote) {
  if (!quote) return null;
  if (quote.deleted) return el("p", { class: "chat-quote gone", text: "Original message deleted" });
  return el("button", {
    class: "chat-quote",
    type: "button",
    style: quote.color ? `--quote:${quote.color}` : null,
    "aria-label": `Reply to ${quote.mine ? "you" : quote.name}: ${quote.text}. Show message`,
    onclick: () => { if (!pressConsumed()) jumpToMessage(quote.id); },
  }, [
    el("strong", { text: quote.mine ? "You" : quote.name }),
    el("span", { text: quote.text }),
  ]);
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
  document.querySelectorAll(".chat-msg.flash").forEach((node) => node.classList.remove("flash"));
  // Restart the fade if it is already lit.
  void row.offsetWidth;
  row.classList.add("flash");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => row.classList.remove("flash"), FLASH_MS);
}

function reactionPills(message, live) {
  const list = message.reactions || [];
  if (!list.length) return null;
  const who = state.chatWho && state.chatWho.id === message.id
    ? list.find((item) => item.emoji === state.chatWho.emoji)
    : null;
  return el("div", { class: "chat-reacts" }, [
    ...list.map((item) => el("button", {
      class: item.mine ? "react-pill mine" : "react-pill",
      type: "button",
      "data-emoji": item.emoji,
      title: item.names.join(", "),
      "aria-label": `${item.emoji} ${item.count}: ${item.names.join(", ")}`,
      "aria-pressed": item.mine ? "true" : "false",
      disabled: !live,
      onclick: () => { if (!pressConsumed()) void reactTo(message.id, item.emoji); },
    }, [el("span", { class: "react-emoji", text: item.emoji }), el("span", { class: "react-count", text: String(item.count) })])),
    who ? el("span", { class: "react-who", text: who.names.join(", ") }) : null,
  ]);
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
  if (event.target.closest?.(".react-bar")) return;
  clearTimeout(pressTimer);
  pressStart = { x: event.clientX, y: event.clientY };
  pressTimer = setTimeout(() => {
    pressStart = null;
    pressUsedAt = Date.now();
    tick();
    if (pill) state.chatWho = { id: message.id, emoji: pill.dataset.emoji };
    else {
      state.chatReactFor = message.id;
      state.chatWho = null;
    }
    render();
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
function startSwipe(event, row, message) {
  if (event.pointerType === "mouse" || event.target.closest?.(".react-bar")) return;
  swipe = { row, message, x: event.clientX, y: event.clientY, at: Date.now(), dx: 0, on: false };
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
  swipe.row.classList.add("swiping");
  swipe.row.style.setProperty("--swipe", `${swipe.dx}px`);
  swipe.row.classList.toggle("swipe-ready", swipe.dx >= SWIPE_REPLY_PX);
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
  swipe.row.classList.remove("swiping", "swipe-ready");
  swipe.row.style.removeProperty("--swipe");
  swipe = null;
}

function openReactionBar(message) {
  state.chatReactFor = state.chatReactFor === message.id ? null : message.id;
  state.chatWho = null;
  render();
  document.querySelector(".react-bar .react-pick")?.focus({ preventScroll: true });
}

/** Puts the bar or the names away without a re-render, so the tap that did it still lands. */
export function closeReactUi() {
  if (!state.chatReactFor && !state.chatWho) return false;
  state.chatReactFor = null;
  state.chatWho = null;
  document.querySelectorAll(".react-bar, .react-who").forEach((node) => node.remove());
  document.querySelectorAll('.chat-react-btn[aria-expanded="true"]').forEach((node) => node.setAttribute("aria-expanded", "false"));
  return true;
}

async function reactTo(messageId, emoji) {
  const thread = state.chatThread;
  const message = thread?.messages?.find((item) => item.id === messageId);
  if (!message) return;
  const on = !(message.reactions || []).some((item) => item.emoji === emoji && item.mine);
  tick();
  message.reactions = toggledReactions(message.reactions || [], emoji, state.me?.user?.name || "You");
  state.chatReactFor = null;
  state.chatWho = null;
  render();
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

function systemLine(message) {
  return el("p", { class: "chat-system" }, [
    el("span", { text: message.text }),
    el("time", { text: messageWhen(message.at) }),
  ]);
}

function messageRow(message) {
  const accent = message.system ? "" : message.color || "";
  const live = canReact();
  const replyable = canReply();
  return el("article", {
    class: message.mine ? "chat-msg mine" : "chat-msg",
    "data-color": accent || null,
    "data-id": message.id,
    style: accent ? `--person:${accent}` : null,
    onpointerdown: live ? (event) => { startPress(event, message); if (replyable) startSwipe(event, event.currentTarget, message); } : null,
    onpointermove: live ? (event) => { movePress(event); moveSwipe(event); } : null,
    onpointerup: live ? () => { endPress(); endSwipe(); } : null,
    onpointercancel: live ? () => { endPress(); dropSwipe(); } : null,
    // A held finger opens the reaction bar, not the browser's own menu.
    oncontextmenu: live ? (event) => { if (prefersTouchUi()) event.preventDefault(); } : null,
  }, [
    el("header", {}, [
      el("strong", { text: message.mine ? "You" : message.name }),
      live
        ? el("button", {
            class: "chat-react-btn",
            type: "button",
            "aria-label": "React",
            "aria-expanded": state.chatReactFor === message.id ? "true" : "false",
            text: "☺",
            onclick: () => openReactionBar(message),
          })
        : null,
      replyable
        ? el("button", {
            class: "chat-reply-btn",
            type: "button",
            "aria-label": "Reply",
            onmousedown: (event) => event.preventDefault(),
            onclick: () => startReply(message),
          }, [icon("reply")])
        : null,
      el("time", { text: messageWhen(message.at) }),
    ]),
    replyQuote(message.replyTo),
    messageText(message.text),
    live && state.chatReactFor === message.id ? reactionBar(message) : null,
    reactionPills(message, live),
    message.canDelete
      ? el("button", { class: "text-btn", type: "button", text: "Delete", onclick: () => { if (!pressConsumed()) confirmDeleteMessage(message); } })
      : null,
  ]);
}

function messageWhen(ms) {
  const part = zonedParts(ms);
  const today = zonedParts(Date.now());
  const hm = clockText(part.hour, part.minute);
  if (part.day === today.day) return hm;
  return `${part.day.slice(5)} ${hm}`;
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
    state.chatThread = (await api(chatTargetUrl(target), { method: "POST", body: replyTo ? { text, replyTo } : { text } })).chat;
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
    const body = queued.replyTo ? { text: queued.text, replyTo: queued.replyTo } : { text: queued.text };
    const thread = (await api(chatTargetUrl(queued.target), { method: "POST", body })).chat;
    state.chatQueue = null;
    state.chatDraft = unsentTail(state.chatDraft, queued.text);
    sentReply(queued.replyTo);
    state.statusMessage = "";
    if (state.chat && state.chat.kind === queued.target.kind && state.chat.id === queued.target.id) {
      state.chatThread = thread;
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
