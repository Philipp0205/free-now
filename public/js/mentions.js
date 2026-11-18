/** Quick reactions, in the order the bar and the pills show them. Same list as REACTIONS in src/chat/chat.ts. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

/** Where `@` starts a mention: the text start, or after anything that is not a letter, digit or underscore. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const NAME_MAX = 24;

/** The Goblin takes gripes in any chat. Not an account, so it is added to the picker here. Same name and color as src/chat/goblin.ts. */
export const GOBLIN = { id: "goblin", name: "Goblin", color: "#4f8410" };

/**
 * Every `@Name` in the text that names one of `names`, case-insensitive. Longest name wins,
 * so "@Alexandra" is never read as "@Alex". Same rule as findMentions in src/chat/chat.ts.
 */
export function findMentions(text, names) {
  const sorted = [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const found = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "@" || (i > 0 && WORD_CHAR.test(text[i - 1]))) {
      i += 1;
      continue;
    }
    const hit = sorted.find((name) => {
      if (!lower.startsWith(name.toLowerCase(), i + 1)) return false;
      const after = text[i + 1 + name.length];
      return after === undefined || !WORD_CHAR.test(after);
    });
    if (!hit) {
      i += 1;
      continue;
    }
    const end = i + 1 + hit.length;
    found.push({ start: i, end, name: hit });
    i = end;
  }
  return found;
}

/** The `@name` being typed right before the caret, or null. */
export function mentionAt(text, caret) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && WORD_CHAR.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > NAME_MAX || /[\n@]/.test(query) || /^\s/.test(query)) return null;
  return { start: at, query };
}

/** People whose name, or a word in it, starts with the query. Never you. */
export function mentionMatches(people, query, selfId, limit = 6) {
  const q = query.toLowerCase();
  return people
    .filter((person) => person.id !== selfId)
    .filter((person) => {
      const name = person.name.toLowerCase();
      return name.startsWith(q) || name.split(/\s+/).some((word) => word.startsWith(q));
    })
    .slice(0, limit);
}

/** Text with `@` replaced by `@Name ` from start to caret. Returns the new text and caret. */
export function insertMention(text, start, caret, name) {
  const tail = text.slice(caret).replace(/^\s+/, "");
  const head = `${text.slice(0, start)}@${name} `;
  return { text: head + tail, caret: head.length };
}

/** Reactions after you tap one emoji: yours flips, the count follows. */
export function toggledReactions(list, emoji, myName) {
  const next = list.map((item) => ({ ...item, names: [...item.names] }));
  const found = next.find((item) => item.emoji === emoji);
  if (found && found.mine) {
    found.mine = false;
    found.count -= 1;
    const at = found.names.indexOf(myName);
    if (at >= 0) found.names.splice(at, 1);
    return next.filter((item) => item.count > 0);
  }
  if (found) {
    found.mine = true;
    found.count += 1;
    found.names.push(myName);
    return next;
  }
  next.push({ emoji, count: 1, mine: true, names: [myName] });
  // The quick six first in their own order; any other emoji after them, in the order they came (the sort is stable).
  const rank = (value) => (REACTIONS.includes(value) ? REACTIONS.indexOf(value) : REACTIONS.length);
  return next.sort((a, b) => rank(a.emoji) - rank(b.emoji));
}
