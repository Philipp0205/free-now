/** Chat links: which parts of a message are http(s) URLs. No DOM and no Preact, so tests can import it. */

/** Up to the first space or a character that could break out of an attribute or a tag. */
const CANDIDATE = /https?:\/\/[^\s<>"`\\^{}|]+/gi;
/** Sentence punctuation that follows a URL in prose and is not part of it. */
const TRAILING = ".,;:!?'";
const CLOSERS = { ")": "(", "]": "[" };
const WORD = /[A-Za-z0-9_]/;

function count(text, char) {
  let n = 0;
  for (const c of text) if (c === char) n += 1;
  return n;
}

/** Where the URL ends once trailing punctuation and a closing bracket that has no opener inside the URL are dropped. */
function urlEnd(raw) {
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1];
    if (TRAILING.includes(last)) {
      end -= 1;
      continue;
    }
    const open = CLOSERS[last];
    if (open && count(raw.slice(0, end), last) > count(raw.slice(0, end), open)) {
      end -= 1;
      continue;
    }
    break;
  }
  return end;
}

function isWebUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && /[\p{L}\p{N}]/u.test(url.hostname);
  } catch {
    return false;
  }
}

/** Every http or https URL in the text: `{ start, end, url }`, in order. `url` is exactly `text.slice(start, end)`. */
export function findLinks(text) {
  const found = [];
  const source = String(text ?? "");
  for (const hit of source.matchAll(CANDIDATE)) {
    if (hit.index > 0 && WORD.test(source[hit.index - 1])) continue;
    const url = hit[0].slice(0, urlEnd(hit[0]));
    if (!isWebUrl(url)) continue;
    found.push({ start: hit.index, end: hit.index + url.length, url });
  }
  return found;
}

/**
 * The message cut into `{ type: "text" | "mention" | "link", text }` pieces, in order, with `name` on a mention
 * and `url` on a link. `mentions` are `{ start, end, name }` from findMentions. A mention inside a URL stays part of it.
 */
export function messageParts(text, mentions = []) {
  const source = String(text ?? "");
  const links = findLinks(source);
  const marks = [
    ...links.map((link) => ({ type: "link", start: link.start, end: link.end, url: link.url })),
    ...mentions
      .filter((mention) => !links.some((link) => mention.start < link.end && mention.end > link.start))
      .map((mention) => ({ type: "mention", start: mention.start, end: mention.end, name: mention.name })),
  ].sort((a, b) => a.start - b.start);
  const parts = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.start > at) parts.push({ type: "text", text: source.slice(at, mark.start) });
    const piece = { ...mark, text: source.slice(mark.start, mark.end) };
    delete piece.start;
    delete piece.end;
    parts.push(piece);
    at = mark.end;
  }
  if (at < source.length) parts.push({ type: "text", text: source.slice(at) });
  return parts;
}
