import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { GRADIENT_COUNT, gradientClass, gradientIndex } from "../public/js/card-grad.js";

const CSS = fs.readFileSync(new URL("../public/css/styles.css", import.meta.url), "utf8");

type Rgb = [number, number, number];

function hex(value: string): Rgb {
  return [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16)) as Rgb;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** rgba(fg, alpha) painted over an opaque bg. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as Rgb;
}

/** Palette stops, read straight from styles.css. Plan cards are dark art in both schemes, so there is only one set. */
function stops(): Rgb[][] {
  const start = CSS.indexOf("/* Plan colours");
  assert.ok(start > 0, "plan colours block");
  const out: Rgb[][] = [];
  for (const match of CSS.slice(start, start + 2000).matchAll(/\.grad-(\d+) \{ --g1: (#[0-9a-f]{6}); --g2: (#[0-9a-f]{6}); \}/g)) {
    out[Number(match[1])] = [hex(match[2]), hex(match[3])];
  }
  return out;
}

const WHITE: Rgb = [255, 255, 255];
const PILL: Rgb = [28, 28, 30];

test("the gradient pick is stable and spreads across the palette", () => {
  assert.equal(GRADIENT_COUNT, 14);
  const id = "4f0c2b8e-6f1a-4c55-9d0e-8a7b3c2d1e0f";
  assert.equal(gradientIndex(id), gradientIndex(id));
  assert.equal(gradientClass(id), `grad-${gradientIndex(id)}`);
  assert.equal(gradientIndex(""), gradientIndex(""));

  const counts = new Array(GRADIENT_COUNT).fill(0);
  let sameAsPrevious = 0;
  let previous = -1;
  const total = 7000;
  for (let n = 0; n < total; n += 1) {
    const pick = gradientIndex(crypto.randomUUID());
    assert.ok(Number.isInteger(pick) && pick >= 0 && pick < GRADIENT_COUNT);
    counts[pick] += 1;
    if (pick === previous) sameAsPrevious += 1;
    previous = pick;
  }
  const fair = total / GRADIENT_COUNT;
  for (const [slot, count] of counts.entries()) {
    assert.ok(count > fair * 0.75 && count < fair * 1.25, `slot ${slot} got ${count} of ~${fair}`);
  }
  // Neighbours match about 1 in 14 times, never much more.
  assert.ok(sameAsPrevious / total < 0.1, `neighbours match ${sameAsPrevious}/${total}`);

  // Sequential, near-identical ids still spread.
  const seq = new Set(Array.from({ length: 28 }, (_, n) => gradientIndex(`plan-${n}`)));
  assert.ok(seq.size >= 10, `only ${seq.size} slots for plan-0..27`);
});

test("card text, chat row, badge, In toggle and ⋯ stay AA on every stop", () => {
  const rows = stops();
  const scheme = "dark";
  {
    assert.equal(rows.filter(Boolean).length, GRADIENT_COUNT, `${scheme} has ${GRADIENT_COUNT} gradients`);
    for (const [slot, pair] of rows.entries()) {
      for (const stop of pair) {
        const pill = over(PILL, 0.72, stop);
        const checks: Array<[string, Rgb, Rgb]> = [
          ["title / description / place / In toggle", WHITE, stop],
          ["meta line (82%)", over(WHITE, 0.82, stop), stop],
          ["circles / time / removed note (70%)", over(WHITE, 0.7, stop), stop],
          ["reply line #d1d1d6", hex("#d1d1d6"), stop],
          ["chat row title / ⋯ icon", WHITE, pill],
          ["chat preview (72%)", over(WHITE, 0.72, pill), pill],
          ["chat 'Say hi' (60%)", over(WHITE, 0.6, pill), pill],
          ["unread badge", WHITE, hex("#9f1239")],
          ["In ✓ (on)", hex("#111111"), WHITE],
        ];
        for (const [what, fg, bg] of checks) {
          const ratio = contrast(fg, bg);
          assert.ok(ratio >= 4.5, `${scheme} grad-${slot} ${what}: ${ratio.toFixed(2)}`);
        }
        // The In toggle outline is a non-text UI edge: 3:1.
        assert.ok(contrast(over(WHITE, 0.85, stop), stop) >= 3, `${scheme} grad-${slot} toggle ring`);
      }
    }
  }
});

test("the palette has a good hue spread, not one colour family", () => {
  const hue = ([r, g, b]: Rgb) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const scheme = "dark";
  {
    const sectors = new Set(stops().map(([first]) => Math.floor(hue(first) / 30)));
    assert.ok(sectors.size >= 8, `${scheme} covers ${sectors.size} of 12 hue sectors`);
  }
});
