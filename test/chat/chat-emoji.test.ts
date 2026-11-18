import assert from "node:assert/strict";
import test from "node:test";
import { EMOJI_MAX_UNITS, isSingleEmoji } from "../../src/chat/emoji.js";
import { REACTIONS } from "../../src/chat/chat.js";
import { toggledReactions, REACTIONS as CLIENT_REACTIONS } from "../../public/js/mentions.js";

test("one emoji grapheme is accepted: quick set, pictographs, skin tones, flags, keycaps, ZWJ sequences", () => {
  for (const ok of [...REACTIONS, "🎉", "👋", "🫠", "🙂", "👍🏽", "🇩🇪", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "1️⃣", "#️⃣", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🧑🏽‍🤝‍🧑🏿", "⌚", "❤️‍🔥"]) {
    assert.equal(isSingleEmoji(ok), true, JSON.stringify(ok));
    assert.ok(ok.length <= EMOJI_MAX_UNITS, ok);
  }
});

test("empty, plain text, digits, several emoji, whitespace and stray joiners are rejected", () => {
  for (const bad of ["", " ", "a", "A", "1", "#", "*", "hello", "👍a", "a👍", "👍 ", " 👍", "👍👍", "🎉🎉", "👍🏽👍🏽", "🇩🇪🇫🇷", "\u200d", "\u{1F3FD}x", "\ufe0f", "👍\n", "<b>", "©", "™"]) {
    assert.equal(isSingleEmoji(bad), false, JSON.stringify(bad));
  }
});

test("non-strings, indexes and overlong values are rejected", () => {
  for (const bad of [0, 1, 5, -1, NaN, true, false, null, undefined, {}, [], ["👍"], { emoji: "👍" }, Symbol.iterator]) {
    assert.equal(isSingleEmoji(bad), false, String(bad));
  }
  assert.equal(isSingleEmoji("👍".repeat(EMOJI_MAX_UNITS)), false);
  // One grapheme joined past the bound: a ZWJ chain of many people is not a real emoji.
  const soup = Array.from({ length: 30 }, () => "👩").join("\u200d");
  assert.ok(soup.length > EMOJI_MAX_UNITS);
  assert.equal(isSingleEmoji(soup), false);
  assert.equal(isSingleEmoji("x".repeat(10_000)), false);
});

test("the client quick list matches the server's, so pills sort the same on both sides", () => {
  assert.deepEqual([...CLIENT_REACTIONS], [...REACTIONS]);
});

test("toggledReactions keeps the quick six first in order and puts other emoji after them in the order they came", () => {
  const me = "Ada";
  let list = toggledReactions([], "🎉", me);
  assert.deepEqual(list, [{ emoji: "🎉", count: 1, mine: true, names: ["Ada"] }]);
  list = toggledReactions(list, "👋", me);
  list = toggledReactions(list, "🔥", me);
  list = toggledReactions(list, "👍", me);
  assert.deepEqual(list.map((item) => item.emoji), ["👍", "🔥", "🎉", "👋"]);
  // Taking one back removes the pill; another person's count on a custom emoji goes up and down.
  const others = [{ emoji: "🎉", count: 1, mine: false, names: ["Nia"] }];
  const joined = toggledReactions(others, "🎉", me);
  assert.deepEqual(joined, [{ emoji: "🎉", count: 2, mine: true, names: ["Nia", "Ada"] }]);
  assert.deepEqual(toggledReactions(joined, "🎉", me), others);
  assert.deepEqual(toggledReactions(toggledReactions([], "👋", me), "👋", me), []);
  // The input is not changed.
  assert.deepEqual(others, [{ emoji: "🎉", count: 1, mine: false, names: ["Nia"] }]);
});
