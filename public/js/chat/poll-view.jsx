import { ICONS } from "../lib.js";
import { chatPoll } from "../chat-store.js";
import {
  POLL_ADD_OPTION,
  POLL_CANCEL,
  POLL_HELP,
  POLL_OPTION_PLACEHOLDER,
  POLL_POST,
  POLL_POSTING,
  POLL_QUESTION_LABEL,
  POLL_QUESTION_PLACEHOLDER,
  POLL_REMOVE_OPTION,
  POLL_SHEET_TITLE,
  POLL_YOUR_VOTE,
} from "./poll-copy.js";
import { canAddPollOption, pollPayload, votePercent, votesLabel } from "./poll-logic.js";

const keepFocus = (event) => event.preventDefault();

/** The poll as it reads in the thread: the question, then one tappable row per option with its count and voters. */
export function PollBody({ message, live, A }) {
  const poll = message.poll;
  return (
    <div class="chat-poll" role="group" aria-label={poll.question}>
      <p class="chat-poll-question">{poll.question}</p>
      <ul class="chat-poll-options">
        {poll.options.map((option) => (
          <PollOption key={option.index} message={message} option={option} total={poll.total} live={live} A={A} />
        ))}
      </ul>
      <p class="chat-poll-total">{votesLabel(poll.total)}</p>
    </div>
  );
}

function PollOption({ message, option, total, live, A }) {
  const percent = votePercent(option.count, total);
  return (
    <li class={option.mine ? "chat-poll-option mine" : "chat-poll-option"} style={`--share:${percent}%`}>
      <button
        class="chat-poll-pick"
        type="button"
        aria-pressed={option.mine ? "true" : "false"}
        disabled={!live}
        onClick={() => { if (!A.pressConsumed()) void A.voteFor(message, option.index); }}
      >
        <span class="chat-poll-text">{option.text}</span>
        {option.mine ? <span class="chat-poll-you">{POLL_YOUR_VOTE}</span> : null}
        <span class="chat-poll-count">{String(option.count)}</span>
      </button>
      {option.names.length ? <p class="chat-poll-who">{option.names.join(", ")}</p> : null}
    </li>
  );
}

/** The new-poll sheet: a question, 2 to 6 options, Post or Cancel. Same shape as the GIF sheet. */
export function PollSheet({ A }) {
  const draft = chatPoll.value;
  if (!draft) return null;
  const ready = Boolean(pollPayload(draft)) && !draft.busy;
  return (
    <>
      <button class="scrim gif-scrim" type="button" aria-label={POLL_CANCEL} onClick={() => A.closePoll()} />
      <form class="sheet gif-sheet poll-sheet" role="dialog" aria-modal="true" aria-label={POLL_SHEET_TITLE} onSubmit={(event) => A.submitPoll(event)}>
        <div class="sheet-head">
          <div class="grabber" />
          <div class="sheet-intro">
            <h2>{POLL_SHEET_TITLE}</h2>
            <p class="help">{POLL_HELP}</p>
          </div>
        </div>
        <div class="sheet-scroll poll-scroll">
          <label class="sheet-label" for="poll-question">{POLL_QUESTION_LABEL}</label>
          <input
            id="poll-question"
            class="sheet-control"
            type="text"
            maxlength="200"
            autocomplete="off"
            placeholder={POLL_QUESTION_PLACEHOLDER}
            value={draft.question}
            onInput={(event) => A.editQuestion(event.target.value)}
          />
          <PollFields draft={draft} A={A} />
          {draft.message ? <p class="help poll-note" role="alert">{draft.message}</p> : null}
        </div>
        <div class="sheet-dock poll-dock">
          <button class="btn ghost" type="button" onMouseDown={keepFocus} onClick={() => A.closePoll()}>{POLL_CANCEL}</button>
          <button class="btn poll-post" type="submit" disabled={!ready}>{draft.busy ? POLL_POSTING : POLL_POST}</button>
        </div>
      </form>
    </>
  );
}

function PollFields({ draft, A }) {
  const removable = draft.options.length > 2;
  return (
    <>
      {draft.options.map((text, index) => (
        <div class="poll-option-row" key={index}>
          <input
            class="sheet-control poll-option-input"
            type="text"
            maxlength="80"
            autocomplete="off"
            aria-label={`${POLL_OPTION_PLACEHOLDER} ${index + 1}`}
            placeholder={`${POLL_OPTION_PLACEHOLDER} ${index + 1}`}
            value={text}
            onInput={(event) => A.editOption(index, event.target.value)}
          />
          {removable ? (
            <button class="poll-option-remove" type="button" aria-label={`${POLL_REMOVE_OPTION} ${index + 1}`} onClick={() => A.removeOption(index)}>
              <span class="icon" dangerouslySetInnerHTML={{ __html: ICONS.close }} />
            </button>
          ) : null}
        </div>
      ))}
      {canAddPollOption(draft) ? (
        <button class="text-btn poll-add" type="button" onClick={() => A.addOption()}>{POLL_ADD_OPTION}</button>
      ) : null}
    </>
  );
}
