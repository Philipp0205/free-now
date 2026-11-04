import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_COLORS, assignChatColors, chooseColor, longestOccupiedRun, preferredColor } from "../src/chat-color.js";

function channel(hex: string, index: number): number {
  const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

function contrast(hex: string, against: string): number {
  const a = luminance(hex);
  const b = luminance(against);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("chat colors are AA on black and white, and a circle does not share one", () => {
  assert.equal(CHAT_COLORS.length, 12);
  for (const hex of CHAT_COLORS) {
    assert.ok(contrast(hex, "#000000") >= 4.5, `${hex} on black`);
    assert.ok(contrast(hex, "#ffffff") >= 4.5, `${hex} on white`);
  }
  let pair: [string, string] | null = null;
  const first = new Map<number, string>();
  for (let n = 0; n < 800 && !pair; n += 1) {
    const id = `person-${n}`;
    const color = preferredColor(id);
    const earlier = first.get(color);
    if (earlier) pair = [earlier, id];
    else first.set(color, id);
  }
  assert.ok(pair);
  const extra: string[] = [];
  for (let n = 0; extra.length < 4; n += 1) {
    const id = `more-${n}`;
    if (preferredColor(id) !== preferredColor(pair[0])) extra.push(id);
  }
  const assigned = assignChatColors([pair[1], ...extra, pair[0]]);
  const values = [...assigned.values()];
  assert.equal(new Set(values).size, values.length);
  const again = assignChatColors([...extra, ...pair]);
  assert.equal(again.get(pair[0]), assigned.get(pair[0]));
  assert.equal(again.get(pair[1]), assigned.get(pair[1]));
  assert.notEqual(assigned.get(pair[0]), assigned.get(pair[1]));
  const span = Math.abs((assigned.get(pair[0]) ?? 0) - (assigned.get(pair[1]) ?? 0));
  const distance = Math.min(span, CHAT_COLORS.length - span);
  assert.ok(distance > 1, `collision landed on adjacent hues ${assigned.get(pair[0])} and ${assigned.get(pair[1])}`);
});

/** Shortest longest-run any placement of `count` hues can have on this palette. */
function minimumAchievableRun(count: number): number {
  const slots = CHAT_COLORS.length;
  if (count <= 0) return 0;
  if (count >= slots) return slots;
  const gaps = slots - count;
  return gaps >= count ? 1 : Math.ceil(count / gaps);
}

/** Shortest longest-run still available without moving colors already stored. */
function bestFreeSlotRun(used: ReadonlySet<number>): number {
  let best = CHAT_COLORS.length;
  for (let slot = 0; slot < CHAT_COLORS.length; slot += 1) {
    if (used.has(slot)) continue;
    const next = new Set(used);
    next.add(slot);
    best = Math.min(best, longestOccupiedRun(next));
  }
  return best;
}

test("sequential joins keep the longest adjacent run at the minimum still achievable", () => {
  assert.equal(minimumAchievableRun(7), 2);
  const seen: string[] = [];
  let prior = new Map<string, number>();
  const runs: number[] = [];
  for (let n = 0; n < CHAT_COLORS.length; n += 1) {
    const id = `join-${n}`;
    const before = new Set(prior.values());
    const assigned = assignChatColors([...seen, id], prior);
    for (const old of seen) assert.equal(assigned.get(old), prior.get(old), old);
    const color = assigned.get(id);
    assert.equal(typeof color, "number");
    const after = new Set<number>(assigned.values());
    const run = longestOccupiedRun(after);
    assert.equal(run, bestFreeSlotRun(before), `member ${n + 1} run ${run} slots ${[...after].sort((a, b) => a - b).join(",")}`);
    runs.push(run);
    prior = assigned;
    seen.push(id);
  }
  assert.equal(runs[6], minimumAchievableRun(7));
  assert.ok(runs[6] < 3, `7 members formed a run of ${runs[6]}`);
  assert.equal(new Set(prior.values()).size, CHAT_COLORS.length);
});

test("a new member skips a slot that would make three neighbouring hues", () => {
  const used = new Set([4, 10, 1, 7, 0, 5]);
  for (let n = 0; n < 24; n += 1) {
    const chosen = chooseColor(`seventh-${n}`, used);
    const next = new Set(used);
    next.add(chosen);
    assert.equal(longestOccupiedRun(next), 2, `chose ${chosen}`);
    assert.ok(chosen === 8 || chosen === 9, `chose ${chosen}`);
  }
  const prior = new Map<string, number>([
    ["a", 4], ["b", 10], ["c", 1], ["d", 7], ["e", 0], ["f", 5],
  ]);
  const assigned = assignChatColors([...prior.keys(), "g"], prior);
  for (const [id, color] of prior) assert.equal(assigned.get(id), color);
});

test("every fresh circle of seven stays off a run of three", () => {
  for (let trial = 0; trial < 36; trial += 1) {
    const seen: string[] = [];
    let prior = new Map<string, number>();
    for (let n = 0; n < 8; n += 1) {
      const id = `cohort-${trial}-member-${n}`;
      const assigned = assignChatColors([...seen, id], prior);
      for (const old of seen) assert.equal(assigned.get(old), prior.get(old), old);
      const run = longestOccupiedRun(new Set(assigned.values()));
      if (n + 1 <= 8) assert.ok(run < 3, `trial ${trial} at ${n + 1} run ${run}`);
      if (n + 1 === 7) assert.equal(run, minimumAchievableRun(7));
      prior = assigned;
      seen.push(id);
    }
  }
});

test("joining people does not change colors already given out", () => {
  const seen: string[] = [];
  let prior = new Map<string, number>();
  for (let n = 0; n < 12; n += 1) {
    const id = `join-${n}`;
    const assigned = assignChatColors([...seen, id], prior);
    for (const old of seen) assert.equal(assigned.get(old), prior.get(old), old);
    assert.equal(typeof assigned.get(id), "number");
    prior = assigned;
    seen.push(id);
  }
  assert.equal(new Set(prior.values()).size, seen.length);
});
