import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RAIN, HURRICANE_COUNT, HURRICANE_WINDOW_MS, RAIN_CATCHUP_MS, RAIN_PLAYED_KEY, RAIN_PLAYED_MAX, firstEmoji, forgetRain, hurricaneEnd, noteRainThread, rainFor, rainStyle, readPlayed } from "../../public/js/emoji-rain.js";

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

/* The taco hurricane. */

/** Like note(), but a hurricane shows up as "🌮 hurricane" so it can be told from a normal rain. */
function noteKinds(t: ReturnType<typeof thread>, storage: ReturnType<typeof fakeStorage>) {
  const rains: string[] = [];
  noteRainThread(t, { now: NOW, storage, start: (emoji: string, hurricane?: boolean) => { rains.push(hurricane ? `${emoji} hurricane` : emoji); return true; } });
  return rains;
}
const SEC = 1000;

test("the hurricane rule is 3 taco messages within 60 seconds", () => {
  assert.equal(HURRICANE_COUNT, 3);
  assert.equal(HURRICANE_WINDOW_MS, 60_000);
});

test("hurricaneEnd: threshold, window and since", () => {
  const t = (ago: number) => NOW - ago;
  assert.equal(hurricaneEnd([t(20 * SEC), t(10 * SEC)], [t(10 * SEC)]), null, "two are not enough");
  assert.equal(hurricaneEnd([t(20 * SEC), t(10 * SEC), t(0)], [t(0)]), t(0), "three are");
  assert.equal(hurricaneEnd([t(70 * SEC), t(35 * SEC), t(0)], [t(0)]), null, "too far apart");
  assert.equal(hurricaneEnd([t(60 * SEC), t(30 * SEC), t(0)], [t(0)]), t(0), "exactly the window apart still counts");
  assert.equal(hurricaneEnd([t(20 * SEC), t(10 * SEC), t(0)], []), null, "nothing new, nothing to play");
  assert.equal(hurricaneEnd([t(20 * SEC), t(10 * SEC), t(0)], [t(0)], t(15 * SEC)), null, "messages before `since` are ignored");
  assert.equal(hurricaneEnd(undefined, undefined), null);
});

test("two taco messages in the window rain normally, the third plays one hurricane", () => {
  forgetRain();
  const storage = fakeStorage();
  const one = msg("a", "taco", 30 * SEC);
  const two = msg("b", "tacos please", 20 * SEC);
  const three = msg("c", "TACO", 10 * SEC);
  assert.deepEqual(noteKinds(thread([msg("h", "Hi all", 5 * MIN)]), storage), []);
  assert.deepEqual(noteKinds(thread([msg("h", "Hi all", 5 * MIN), one]), storage), ["🌮"]);
  assert.deepEqual(noteKinds(thread([msg("h", "Hi all", 5 * MIN), one, two]), storage), ["🌮"], "two still rain normally");
  assert.deepEqual(noteKinds(thread([msg("h", "Hi all", 5 * MIN), one, two, three]), storage), ["🌮 hurricane"], "the third is the hurricane, not another rain");
  assert.deepEqual(noteKinds(thread([msg("h", "Hi all", 5 * MIN), one, two, three]), storage), [], "a later poll does not replay it");
});

test("three taco messages spread wider than the window do not hurricane, three inside it do", () => {
  forgetRain();
  const storage = fakeStorage();
  note(thread([msg("h", "Hi all", 20 * MIN)]), storage);
  const wide = [msg("h", "Hi all", 20 * MIN), msg("a", "taco", 3 * MIN), msg("b", "taco", 2 * MIN)];
  assert.deepEqual(noteKinds(thread(wide), storage), ["🌮"]);
  assert.deepEqual(noteKinds(thread([...wide, msg("c", "taco", 0)]), storage), ["🌮"], "the third is more than a minute after the first");
  forgetRain();
  const close = fakeStorage();
  note(thread([msg("h", "Hi all", 20 * MIN)]), close);
  const near = [msg("h", "Hi all", 20 * MIN), msg("a", "taco", 50 * SEC), msg("b", "taco", 25 * SEC), msg("c", "taco", 0)];
  assert.deepEqual(noteKinds(thread(near), close), ["🌮 hurricane"]);
});

test("messages from different senders count, other rains, GIF, system and Goblin lines do not", () => {
  forgetRain();
  const storage = fakeStorage();
  note(thread([msg("h", "Hi all", 20 * MIN)]), storage);
  const people = [
    { ...msg("a", "taco", 30 * SEC), sender: "alex" },
    { ...msg("b", "tacos!", 20 * SEC), sender: "bea" },
    { ...msg("c", "/makeitrain", 10 * SEC), sender: "cy" },
  ];
  assert.deepEqual(noteKinds(thread([msg("h", "Hi all", 20 * MIN), ...people]), storage), ["🌮 hurricane"], "three people, one burst");

  forgetRain();
  const other = fakeStorage();
  note(thread([msg("h", "Hi all", 20 * MIN)]), other);
  const noise = [
    msg("h", "Hi all", 20 * MIN),
    msg("a", "taco", 40 * SEC),
    msg("e", "/makeitrain 🥚", 35 * SEC),
    { ...msg("g", "taco", 30 * SEC), gif: { id: "1" } },
    { ...msg("s", "taco", 25 * SEC), system: true },
    { ...msg("o", "taco", 20 * SEC), goblin: true },
    msg("t", "tacotruck", 15 * SEC),
    msg("l", "🌮", 12 * SEC),
    msg("b", "taco", 10 * SEC),
  ];
  assert.deepEqual(noteKinds(thread(noise), other), ["🌮"], "two real taco messages are not a hurricane");
});

test("a burst plays one hurricane: a fourth taco in the window does not start another, a later burst can", () => {
  forgetRain();
  const storage = fakeStorage();
  const hi = msg("h", "Hi all", 30 * MIN);
  note(thread([hi]), storage);
  const burst = [hi, msg("a", "taco", 20 * MIN), msg("b", "taco", 20 * MIN - 10 * SEC), msg("c", "taco", 20 * MIN - 20 * SEC)];
  assert.deepEqual(noteKinds(thread(burst), storage), ["🌮 hurricane"]);
  const fourth = [...burst, msg("d", "taco", 20 * MIN - 40 * SEC)];
  assert.deepEqual(noteKinds(thread(fourth), storage), ["🌮"], "the fourth is a normal rain, not a second hurricane");
  const fifth = [...fourth, msg("e", "taco", 20 * MIN - 50 * SEC)];
  assert.deepEqual(noteKinds(thread(fifth), storage), ["🌮"], "still the same burst");
  // A fresh set after the window can hurricane again.
  const later = [...fifth, msg("f", "taco", 10 * MIN), msg("g", "taco", 10 * MIN - 10 * SEC)];
  assert.deepEqual(noteKinds(thread(later), storage), ["🌮"], "two are not a new burst yet");
  const again = [...later, msg("i", "taco", 10 * MIN - 20 * SEC)];
  assert.deepEqual(noteKinds(thread(again), storage), ["🌮 hurricane"], "a new burst hurricanes again");
});

test("opening a chat with 3 unplayed taco messages in the window plays one hurricane and marks them played", () => {
  forgetRain();
  const storage = fakeStorage();
  const missed = [msg("a", "taco", 20 * MIN), msg("b", "taco", 20 * MIN - 15 * SEC), msg("c", "taco", 20 * MIN - 30 * SEC), msg("z", "ok", MIN)];
  assert.deepEqual(noteKinds(thread(missed), storage), ["🌮 hurricane"]);
  assert.deepEqual([...readPlayed(storage, NOW).keys()].sort(), ["a", "b", "c"]);
  assert.deepEqual(noteKinds(thread(missed), storage), [], "the same thread again");
  forgetRain();
  assert.deepEqual(noteKinds(thread(missed), storage), [], "a reopen with the same played store");
  forgetRain();
  assert.deepEqual(noteKinds(thread([...missed, msg("d", "taco", 20 * MIN - 45 * SEC)]), storage), ["🌮"], "a fourth in the same burst is only a normal rain");
});

test("a catch-up with two missed taco messages is a normal rain, and older than the catch-up window plays nothing", () => {
  forgetRain();
  assert.deepEqual(noteKinds(thread([msg("a", "taco", 20 * MIN), msg("b", "taco", 20 * MIN - 5 * SEC)]), fakeStorage()), ["🌮"]);
  forgetRain();
  const old = RAIN_CATCHUP_MS + MIN;
  assert.deepEqual(noteKinds(thread([msg("a", "taco", old), msg("b", "taco", old - 5 * SEC), msg("c", "taco", old - 10 * SEC)]), fakeStorage()), []);
});

test("a hurricane style is bigger than the rain, and gentler without spin or shake under reduced motion", () => {
  const rain = rainStyle(false);
  const full = rainStyle(false, true);
  assert.ok(full.drops > rain.drops && full.hurricane && full.spin && full.shake);
  assert.ok(full.cleanupMs! > 3500 + 1000, "it lasts longer than the usual rain");
  const gentle = rainStyle(true, true);
  assert.ok(gentle.drops > 0 && gentle.drops < full.drops && gentle.drops < 200);
  assert.equal(gentle.spin, false);
  assert.equal(gentle.shake, false);
  assert.deepEqual(rainStyle(true), { drops: 40, spin: false });
});
