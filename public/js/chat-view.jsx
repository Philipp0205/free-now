import { render } from "preact";
import { findMentions, GOBLIN, REACTIONS } from "./mentions.js";
import { clockText, zonedParts } from "./when.js";
import { ICONS } from "./lib.js";
import {
  canReact,
  canReply,
  chatDraft,
  chatFlash,
  chatMeId,
  chatMeName,
  chatMention,
  chatReactFor,
  chatReplyTo,
  chatStatus,
  chatThread,
  chatWho,
  flushChat,
  mentionChoices,
  swipeSignal,
} from "./chat-store.js";

/** The chat actions, handed over by chat.js when the view mounts. They write `state` and the signals. */
let A = null;

/** Mounts the chat screen into the host. The host itself is the `.chat-screen` section, owned by chat.js. */
export function mountChatView(host, actions) {
  A = actions;
  render(<ChatScreen />, host);
  flushChat();
}

/** Paints the signals into the host now. The same component, so nothing remounts. */
export function paintChatView(host) {
  if (A) render(<ChatScreen />, host);
  flushChat();
}

export function unmountChatView(host) {
  render(null, host);
  A = null;
}

const keepFocus = (event) => event.preventDefault();

function Icon({ name }) {
  return <span class="icon" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}

function ChatScreen() {
  const { thread } = chatThread.value;
  const status = chatStatus.value;
  return (
    <>
      {status ? <p class="status-banner" role="status">{status}</p> : null}
      <header class="chat-head">
        <button class="text-btn chat-back" type="button" onClick={() => A.closeChat()}>Back</button>
        <h1>{thread?.title || "Chat"}</h1>
        {thread ? (
          <button class="text-btn" type="button" onClick={() => { void A.toggleMute(); }}>{thread.muted ? "Unmute" : "Mute"}</button>
        ) : null}
      </header>
      <ChatLog />
      {thread?.removed ? (
        <p class="chat-closed">You were removed from this event.</p>
      ) : thread?.closed ? (
        <p class="chat-closed">This chat is closed.</p>
      ) : (
        <Composer />
      )}
    </>
  );
}

function ChatLog() {
  const { thread } = chatThread.value;
  return (
    <div class="chat-log" id="chat-log" onScroll={(event) => A.onLogScroll(event)}>
      {thread
        ? thread.messages.map((message, index) => (
            message.system
              ? <SystemLine key={message.id ?? `i${index}`} message={message} />
              : <MessageRow key={message.id ?? `i${index}`} message={message} />
          ))
        : <p class="help">Loading…</p>}
    </div>
  );
}

function messageWhen(ms) {
  const part = zonedParts(ms);
  const today = zonedParts(Date.now());
  const hm = clockText(part.hour, part.minute);
  if (part.day === today.day) return hm;
  return `${part.day.slice(5)} ${hm}`;
}

function SystemLine({ message }) {
  return (
    <p class="chat-system">
      <span>{message.text}</span>
      <time>{messageWhen(message.at)}</time>
    </p>
  );
}

/** Message text with each @Name of someone in the chat in their colour. Yours is a little stronger. */
function MessageText({ text }) {
  const { thread } = chatThread.value;
  const colors = new Map();
  for (const message of thread?.messages || []) if (message.color && message.name) colors.set(message.name.toLowerCase(), message.color);
  for (const person of thread?.participants || []) colors.set(person.name.toLowerCase(), person.color);
  colors.set(GOBLIN.name.toLowerCase(), GOBLIN.color);
  const hits = findMentions(text, [...colors.keys()]);
  if (!hits.length) return <p>{text}</p>;
  const me = chatMeName.value.trim().toLowerCase();
  const parts = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.start > at) parts.push(text.slice(at, hit.start));
    const key = hit.name.toLowerCase();
    parts.push(
      <span class={key === me ? "mention me" : "mention"} style={`--person:${colors.get(key)}`}>{text.slice(hit.start, hit.end)}</span>,
    );
    at = hit.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <p>{parts}</p>;
}

function Quote({ quote }) {
  if (!quote) return null;
  if (quote.deleted) return <p class="chat-quote gone">Original message deleted</p>;
  const who = quote.mine ? "You" : quote.name;
  return (
    <button
      class="chat-quote"
      type="button"
      style={quote.color ? `--quote:${quote.color}` : undefined}
      aria-label={`Reply to ${quote.mine ? "you" : quote.name}: ${quote.text}. Show message`}
      onClick={() => { if (!A.pressConsumed()) A.jumpToMessage(quote.id); }}
    >
      <strong>{who}</strong>
      <span>{quote.text}</span>
    </button>
  );
}

function ReactionBar({ message, replyable }) {
  return (
    <div class="react-bar" role="toolbar" aria-label="React">
      {REACTIONS.map((emoji) => {
        const mine = (message.reactions || []).some((item) => item.emoji === emoji && item.mine);
        return (
          <button
            key={emoji}
            class={mine ? "react-pick mine" : "react-pick"}
            type="button"
            aria-label={`React ${emoji}`}
            aria-pressed={mine ? "true" : "false"}
            onClick={() => { if (!A.pressConsumed()) void A.reactTo(message.id, emoji); }}
          >{emoji}</button>
        );
      })}
      {replyable ? (
        <button
          class="react-reply"
          type="button"
          onMouseDown={keepFocus}
          onClick={() => { if (!A.pressConsumed()) A.startReply(message); }}
        >Reply</button>
      ) : null}
    </div>
  );
}

function ReactionPills({ message, live }) {
  const list = message.reactions || [];
  if (!list.length) return null;
  const pick = chatWho.value;
  // Reactions are edited in place, so follow every thread sync too, not just a change of props.
  void chatThread.value;
  const who = pick && pick.id === message.id ? list.find((item) => item.emoji === pick.emoji) : null;
  return (
    <div class="chat-reacts">
      {list.map((item) => (
        <button
          key={item.emoji}
          class={item.mine ? "react-pill mine" : "react-pill"}
          type="button"
          data-emoji={item.emoji}
          title={item.names.join(", ")}
          aria-label={`${item.emoji} ${item.count}: ${item.names.join(", ")}`}
          aria-pressed={item.mine ? "true" : "false"}
          disabled={!live}
          onClick={() => { if (!A.pressConsumed()) void A.reactTo(message.id, item.emoji); }}
        >
          <span class="react-emoji">{item.emoji}</span>
          <span class="react-count">{String(item.count)}</span>
        </button>
      ))}
      {who ? <span class="react-who">{who.names.join(", ")}</span> : null}
    </div>
  );
}

function MessageRow({ message }) {
  const accent = message.color || "";
  const live = canReact() && !message.goblin;
  const replyable = canReply() && !message.goblin;
  const barOpen = chatReactFor.value === message.id;
  // Only this row reads its swipe signal, so a drag repaints one row.
  const swipe = swipeSignal(message.id).value;
  let cls = message.mine ? "chat-msg mine" : message.goblin ? "chat-msg goblin" : "chat-msg";
  if (swipe) cls += swipe.ready ? " swiping swipe-ready" : " swiping";
  if (chatFlash.value === message.id) cls += " flash";
  const style = [accent ? `--person:${accent}` : "", swipe ? `--swipe:${swipe.dx}px` : ""].filter(Boolean).join(";");
  return (
    <article
      class={cls}
      data-color={accent || undefined}
      data-id={message.id}
      style={style || undefined}
      onPointerDown={live ? (event) => A.rowDown(event, message, replyable) : undefined}
      onPointerMove={live ? (event) => A.rowMove(event) : undefined}
      onPointerUp={live ? () => A.rowUp() : undefined}
      onPointerCancel={live ? () => A.rowCancel() : undefined}
      onContextMenu={live ? (event) => A.rowMenu(event) : undefined}
    >
      <header>
        <strong>{message.mine ? "You" : message.goblin ? `👺 ${message.name}` : message.name}</strong>
        {live ? (
          <button
            class="chat-react-btn"
            type="button"
            aria-label="React"
            aria-expanded={barOpen ? "true" : "false"}
            onClick={() => A.openReactionBar(message)}
          >☺</button>
        ) : null}
        {replyable ? (
          <button class="chat-reply-btn" type="button" aria-label="Reply" onMouseDown={keepFocus} onClick={() => A.startReply(message)}>
            <Icon name="reply" />
          </button>
        ) : null}
        <time>{messageWhen(message.at)}</time>
      </header>
      <Quote quote={message.replyTo} />
      <MessageText text={message.text} />
      {live && barOpen ? <ReactionBar message={message} replyable={replyable} /> : null}
      <ReactionPills message={message} live={live} />
      {message.canDelete ? (
        <button class="text-btn" type="button" onClick={() => { if (!A.pressConsumed()) A.confirmDelete(message); }}>Delete</button>
      ) : null}
    </article>
  );
}

/** The draft is the textarea's value, not child text. It is set when the box mounts and by chat.js after that. */
function bindInput(node) {
  if (node) node.value = chatDraft.peek();
}

function Composer() {
  return (
    <form class="chat-compose" onSubmit={(event) => A.send(event)}>
      <ReplyPreview />
      <textarea
        id="chat-input"
        class="sheet-control"
        rows="1"
        maxlength="1000"
        placeholder="Message"
        autocomplete="off"
        enterkeyhint="send"
        aria-autocomplete="list"
        aria-controls="mention-list"
        ref={bindInput}
        onInput={(event) => A.onInput(event)}
        onKeyDown={(event) => A.onKey(event)}
        onBlur={(event) => A.onBlur(event)}
      />
      <button class="btn chat-send" type="submit">Send</button>
      <MentionList />
    </form>
  );
}

function ReplyPreview() {
  const reply = chatReplyTo.value;
  if (!reply) return null;
  return (
    <div class="reply-preview" style={reply.color ? `--person:${reply.color}` : undefined}>
      <div class="reply-preview-copy">
        <strong>{reply.mine ? "You" : reply.name}</strong>
        <span>{reply.text}</span>
      </div>
      <button class="reply-cancel" type="button" aria-label="Cancel reply" onMouseDown={keepFocus} onClick={() => A.cancelReply()}>
        <Icon name="close" />
      </button>
    </div>
  );
}

/** Typing only repaints this list, so the composer is never rebuilt under the keyboard. */
function MentionList() {
  const pick = chatMention.value;
  const people = mentionChoices();
  if (!pick || !people.length) return null;
  const index = Math.min(pick.index, people.length - 1);
  return (
    <ul class="mention-list" id="mention-list" role="listbox" aria-label="Mention someone">
      {people.map((person, i) => (
        <li
          key={person.id}
          class={i === index ? "mention-option active" : "mention-option"}
          role="option"
          aria-selected={i === index ? "true" : "false"}
          style={`--person:${person.color}`}
          onMouseDown={keepFocus}
          onClick={() => A.chooseMention(person)}
        >
          {person.id === GOBLIN.id
            ? <span class="goblin-face" aria-hidden="true">👺</span>
            : <span class="mention-dot" aria-hidden="true" />}
          <span>{person.name}</span>
        </li>
      ))}
    </ul>
  );
}
