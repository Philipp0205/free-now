import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RAIN, RAIN_CATCHUP_MS, RAIN_PLAYED_KEY, RAIN_PLAYED_MAX, firstEmoji, forgetRain, noteRainThread, rainFor, rainStyle, readPlayed } from "../../public/js/emoji-rain.js";

test("the rain keeps 200 spinning drops by default and a lighter, spin-free rain under reduced motion", () => {
  assert.deepEqual(rainStyle(false), { drops: 200, spin: true });
  const reduced = rainStyle(true);
  assert.equal(reduced.spin, false);
  assert.ok(reduced.drops > 0 && reduced.drops < 200, "some drops, fewer than usual");
});

test("the word taco rains tacos, any case, with punctuation around it", () => {
  for (const text of ["taco", "tacos", "Taco!", "TACOS", "who wants tacos?", "(taco)", "free-taco night", "taco, taco, taco", "I like Tacos.\nA lot"]) {
    assert.equal(rainFor(text), DEFAULT_RAIN, text);
  }
  assert.equal(DEFAULT_RAIN, "🌮");
});

test("taco inside another word does not rain", () => {
  for (const text of ["tacotruck", "tacoma", "mistacos", "taco_truck", "tac0", "tacoss", "", "hello", "🌮"]) {
    assert.equal(rainFor(text), "", text);
  }
  assert.equal(rainFor(undefined), "");
  assert.equal(rainFor(null), "");
});

test("/makeitrain rains the first emoji of its argument", () => {
  assert.equal(rainFor("/makeitrain 🥚"), "🥚");
  assert.equal(rainFor("/makeitrain🥚"), "🥚");
  assert.equal(rainFor("  /MakeItRain   🎉 and 🥚"), "🎉");
  assert.equal(rainFor("/makeitrain please 🥚"), "🥚");
});

test("/makeitrain keeps flags, skin tones, ZWJ sequences and keycaps whole", () => {
  for (const emoji of ["🇩🇪", "👍🏽", "👨‍👩‍👧‍👦", "🏳️‍🌈", "❤️‍🔥", "1️⃣"]) {
    assert.equal(rainFor(`/makeitrain ${emoji}`), emoji, emoji);
    assert.equal(rainFor(`/makeitrain ${emoji}${emoji}`), emoji, `${emoji} twice`);
  }
});

test("/makeitrain with no valid emoji rains tacos", () => {
  for (const text of ["/makeitrain", "/makeitrain ", "/makeitrain nothing", "/makeitrain 123", "/makeitrain #", "/makeitrain \u200d"]) {
    assert.equal(rainFor(text), DEFAULT_RAIN, JSON.stringify(text));
  }
});

test("only a message that starts with the command is a command", () => {
  assert.equal(rainFor("hey /makeitrain 🥚"), "");
  assert.equal(rainFor("/makeitrains 🥚"), "");
  assert.equal(rainFor("/makeitrainy"), "");
  // The word taco still counts when the command is not first.
  assert.equal(rainFor("hey /makeitrain 🥚 taco"), DEFAULT_RAIN);
});

test("firstEmoji picks the first emoji grapheme and ignores text", () => {
  assert.equal(firstEmoji("go 🇫🇷 now 🥚"), "🇫🇷");
  assert.equal(firstEmoji("none here"), "");
  assert.equal(firstEmoji(""), "");
  assert.equal(firstEmoji(7), "");
});

/* Catch-up and replay. A fake storage and a fake start keep these out of the browser. */

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

type Msg = { id: string; text: string; at: number; gif?: unknown; system?: boolean; goblin?: boolean };
const msg = (id: string, text: string, ago: number): Msg => ({ id, text, at: NOW - ago });
const thread = (messages: Msg[], id = "chat-1") => ({ id, messages });

function note(t: ReturnType<typeof thread>, storage: ReturnType<typeof fakeStorage>) {
  const rains: string[] = [];
  noteRainThread(t, { now: NOW, storage, start: (emoji: string) => { rains.push(emoji); return true; } });
  return rains;
}

test("a recent trigger missed while the chat was closed rains on the first open", () => {
  forgetRain();
  const storage = fakeStorage();
  const rains = note(thread([msg("a", "Hi all", 20 * MIN), msg("b", "who wants a taco", 10 * MIN), msg("c", "see you", 5 * MIN)]), storage);
  assert.deepEqual(rains, ["🌮"]);
  assert.deepEqual([...readPlayed(storage, NOW).keys()], ["b"]);
});

test("history that is not a trigger rains nothing on open", () => {
  forgetRain();
  assert.deepEqual(note(thread([msg("a", "Hi all", MIN), msg("b", "tacotruck", MIN)]), fakeStorage()), []);
});

test("a played trigger never rains again: same thread, a poll, or a later open", () => {
  forgetRain();
  const storage = fakeStorage();
  const t = thread([msg("b", "taco", 10 * MIN)]);
  assert.deepEqual(note(t, storage), ["🌮"]);
  assert.deepEqual(note(t, storage), [], "the same thread again");
  forgetRain();
  assert.deepEqual(note(t, storage), [], "a later open on this device");
  forgetRain();
  assert.deepEqual(note(thread([msg("b", "taco", 10 * MIN), msg("z", "hey", MIN)]), storage), [], "a later open with more messages");
});

test("a trigger older than the window does not rain on open", () => {
  forgetRain();
  const storage = fakeStorage();
  assert.deepEqual(note(thread([msg("old", "taco", RAIN_CATCHUP_MS + MIN)]), storage), []);
  forgetRain();
  assert.deepEqual(note(thread([msg("edge", "taco", RAIN_CATCHUP_MS - MIN)]), storage), ["🌮"], "just inside the window");
});

test("several recent missed triggers rain once, from the newest message", () => {
  forgetRain();
  const storage = fakeStorage();
  const rains = note(thread([msg("a", "taco", 40 * MIN), msg("b", "/makeitrain 🥚", 30 * MIN), msg("c", "/makeitrain 🇩🇪", 20 * MIN), msg("d", "ok", MIN)]), storage);
  assert.deepEqual(rains, ["🇩🇪"]);
  assert.deepEqual([...readPlayed(storage, NOW).keys()].sort(), ["a", "b", "c"], "all of them are marked played");
  forgetRain();
  assert.deepEqual(note(thread([msg("a", "taco", 40 * MIN), msg("b", "/makeitrain 🥚", 30 * MIN), msg("c", "/makeitrain 🇩🇪", 20 * MIN)]), storage), []);
});

test("GIF, system and Goblin lines never rain, even with taco in their text", () => {
  forgetRain();
  const odd = [{ ...msg("g", "taco", MIN), gif: { id: "1" } }, { ...msg("s", "taco", MIN), system: true }, { ...msg("o", "taco", MIN), goblin: true }];
  assert.deepEqual(note(thread(odd), fakeStorage()), []);
});

test("live messages after the first thread rain once, and older pages prepended later do not", () => {
  forgetRain();
  const storage = fakeStorage();
  assert.deepEqual(note(thread([msg("a", "Hi all", 30 * MIN)]), storage), []);
  const live = [msg("a", "Hi all", 30 * MIN), msg("n", "taco", 1000)];
  assert.deepEqual(note(thread(live), storage), ["🌮"]);
  assert.deepEqual(note(thread(live), storage), [], "the next poll");
  // An older page lands in front: its trigger is older than what the chat already showed.
  assert.deepEqual(note(thread([msg("p", "taco", 50 * MIN), ...live]), storage), []);
});

test("a live trigger is marked played, so reopening the chat does not replay it", () => {
  forgetRain();
  const storage = fakeStorage();
  note(thread([msg("a", "Hi all", 30 * MIN)]), storage);
  const live = [msg("a", "Hi all", 30 * MIN), msg("n", "/makeitrain 🥚", 1000)];
  assert.deepEqual(note(thread(live), storage), ["🥚"]);
  forgetRain();
  assert.deepEqual(note(thread(live), storage), []);
});

test("a different chat is a first thread again", () => {
  forgetRain();
  const storage = fakeStorage();
  note(thread([msg("a", "Hi all", MIN)], "chat-1"), storage);
  assert.deepEqual(note(thread([msg("x", "taco", MIN)], "chat-2"), storage), ["🌮"]);
});

test("the played store drops ids older than the window and keeps only the newest ones", () => {
  const stored: Record<string, number> = { stale: NOW - RAIN_CATCHUP_MS - MIN, fresh: NOW - MIN };
  const storage = fakeStorage({ [RAIN_PLAYED_KEY]: JSON.stringify(stored) });
  assert.deepEqual([...readPlayed(storage, NOW).keys()], ["fresh"]);

  forgetRain();
  const many: Msg[] = Array.from({ length: RAIN_PLAYED_MAX + 20 }, (_, i) => msg(`m${i}`, "taco", (i + 1) * 1000));
  note(thread(many), storage);
  const kept = JSON.parse(storage.getItem(RAIN_PLAYED_KEY)!);
  assert.equal(Object.keys(kept).length, RAIN_PLAYED_MAX);
  assert.ok("m0" in kept && !(`m${RAIN_PLAYED_MAX + 19}` in kept), "the newest ids stay");
  assert.ok(!("stale" in kept), "stale ids are gone after a write");
});

test("an unreadable or missing store is treated as empty and never throws", () => {
  assert.equal(readPlayed(fakeStorage({ [RAIN_PLAYED_KEY]: "{not json" }), NOW).size, 0);
  assert.equal(readPlayed(fakeStorage({ [RAIN_PLAYED_KEY]: "[1,2]" }), NOW).size, 0);
  assert.equal(readPlayed(null, NOW).size, 0);
  forgetRain();
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
  const rains: string[] = [];
  noteRainThread(thread([msg("b", "taco", MIN)]), { now: NOW, storage: broken as never, start: (emoji: string) => { rains.push(emoji); return true; } });
  assert.deepEqual(rains, ["🌮"]);
});
