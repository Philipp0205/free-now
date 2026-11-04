import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_COLORS, assignChatColors, preferredColor } from "../src/chat-color.js";

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
