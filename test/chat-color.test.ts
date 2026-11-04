import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_COLORS, assignChatColors, chooseColor, preferredColor } from "../src/chat-color.js";

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

test("a tied hue prefers a free slot with free neighbours", () => {
  function nearest(candidate: number, used: Set<number>): number {
    let best = CHAT_COLORS.length;
    for (const taken of used) {
      const delta = Math.abs(candidate - taken);
      best = Math.min(best, delta, CHAT_COLORS.length - delta);
    }
    return best;
  }
  function freeNeighbours(index: number, used: Set<number>): number {
    const size = CHAT_COLORS.length;
    return (used.has((index - 1 + size) % size) ? 0 : 1) + (used.has((index + 1) % size) ? 0 : 1);
  }
  let found = false;
  for (let mask = 1; mask < 2 ** CHAT_COLORS.length && !found; mask += 1) {
    const used = new Set<number>();
    for (let index = 0; index < CHAT_COLORS.length; index += 1) {
      if (mask & (1 << index)) used.add(index);
    }
    if (used.size === 0 || used.size >= CHAT_COLORS.length - 1) continue;
    const farthest = Math.max(...[...Array(CHAT_COLORS.length).keys()].filter((index) => !used.has(index)).map((index) => nearest(index, used)));
    const best = [...Array(CHAT_COLORS.length).keys()].filter((index) => !used.has(index) && nearest(index, used) === farthest);
    if (best.length < 2) continue;
    const roomiest = Math.max(...best.map((index) => freeNeighbours(index, used)));
    const lowest = best[0];
    if (freeNeighbours(lowest, used) === roomiest) continue;
    for (let n = 0; n < 400; n += 1) {
      const id = `tie-${mask}-${n}`;
      if (best.includes(preferredColor(id))) continue;
      const chosen = chooseColor(id, used);
      assert.ok(best.includes(chosen), `${id} left the farthest set`);
      assert.equal(freeNeighbours(chosen, used), roomiest);
      assert.ok(freeNeighbours(chosen, used) > freeNeighbours(lowest, used));
      const prior = new Map<string, number>([["kept", lowest]]);
      const assigned = assignChatColors(["kept", id], prior);
      assert.equal(assigned.get("kept"), lowest);
      found = true;
      break;
    }
  }
  assert.equal(found, true);
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
