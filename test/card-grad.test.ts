import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { GRADIENT_COUNT, compactTone, gradientClass, gradientIndex, isCardColor, planGradientClass } from "../public/js/card-grad.js";
import { type Rgb, contrast, hex, over } from "./contrast.js";

const CSS = fs.readFileSync(new URL("../public/css/styles.css", import.meta.url), "utf8");

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

/** The compact row tint percentages for a scheme, read from styles.css (light is the prefers-color-scheme override, also forced by data-ak-scheme). */
function tints(scheme: "dark" | "light"): { plan: number; social: number } {
  const dark = /\.compact-row \{ --tint: (\d+)%; --tint-social: (\d+)%;/.exec(CSS);
  const light = /@media \(prefers-color-scheme: light\) \{\n  :root:not\(\[data-ak-scheme="dark"\]\) \.compact-row \{ --tint: (\d+)%; --tint-social: (\d+)%; \}/.exec(CSS);
  const forced = /html\[data-ak-scheme="light"\] \.compact-row \{ --tint: (\d+)%; --tint-social: (\d+)%; \}/.exec(CSS);
  assert.deepEqual(forced?.slice(1), light?.slice(1), "forcing Light tints the rows like a light phone");
  const hit = scheme === "dark" ? dark : light;
  assert.ok(hit, `${scheme} compact tint`);
  return { plan: Number(hit[1]) / 100, social: Number(hit[2]) / 100 };
}

/** --row-sub in styles.css is --muted mixed 75% with --text; the date and +N use it. */
const sub = (muted: Rgb, text: Rgb): Rgb => over(muted, 0.75, text);
const SURFACES = {
  dark: { lift: hex("#1c1c1e"), text: hex("#ffffff"), muted: sub(hex("#8e8e93"), hex("#ffffff")) },
  light: { lift: hex("#f2f2f7"), text: hex("#000000"), muted: sub(hex("#636366"), hex("#000000")) },
};
const PINK = hex("#ff2d78");
const ORANGE = hex("#ff6e28");

test("a compact row is a social or a plan tone, and a plan keeps its card's grad-N", () => {
  assert.equal(compactTone("plan", "abc"), `compact-plan ${gradientClass("abc")}`);
  assert.equal(compactTone("social", "abc"), "compact-social");
  assert.doesNotMatch(compactTone("social", "abc"), /card-now|grad-/);
  assert.notEqual(compactTone("plan", "plan-0"), compactTone("plan", "plan-1"));
});

test("a picked cardColor wins, and no pick or a bad value falls back to the id hash", () => {
  const id = "4f0c2b8e-6f1a-4c55-9d0e-8a7b3c2d1e0f";
  for (let slot = 0; slot < GRADIENT_COUNT; slot += 1) {
    assert.equal(planGradientClass({ id, cardColor: slot }), `grad-${slot}`);
    assert.equal(compactTone("plan", id, slot), `compact-plan grad-${slot}`, "the compact row follows the same slot");
  }
  const hash = gradientClass(id);
  for (const bad of [null, undefined, -1, GRADIENT_COUNT, 99, 1.5, "3", NaN, true, {}]) {
    assert.equal(planGradientClass({ id, cardColor: bad }), hash, `${String(bad)} falls back`);
    assert.equal(compactTone("plan", id, bad as number), `compact-plan ${hash}`);
    assert.equal(isCardColor(bad), false);
  }
  assert.equal(planGradientClass({ id }), hash, "a plan with no cardColor field");
  assert.equal(planGradientClass(undefined), gradientClass(undefined));
  assert.equal(compactTone("plan", id), `compact-plan ${hash}`, "the default call is unchanged");
  assert.equal(compactTone("social", id, 3), "compact-social", "a social never takes a plan color");
  assert.equal(isCardColor(0), true);
  assert.equal(isCardColor(GRADIENT_COUNT - 1), true);
});

test("compact title, date and +N stay AA on every tinted row, with and without the now wash, in dark and light", () => {
  const rows = stops();
  assert.equal(rows.filter(Boolean).length, GRADIENT_COUNT);
  for (const scheme of ["dark", "light"] as const) {
    const { lift, text, muted } = SURFACES[scheme];
    const tint = tints(scheme);
    const bases: Array<[string, Rgb]> = [["social start", over(PINK, tint.social, lift)], ["social end", over(ORANGE, tint.social, lift)]];
    for (const [slot, [g1, g2]] of rows.entries()) {
      bases.push([`grad-${slot} start`, over(g1, tint.plan, lift)], [`grad-${slot} end`, over(g2, tint.plan, lift)]);
    }
    for (const [name, base] of bases) {
      for (const [state, bg] of [["", base], [" happening now", over(PINK, 0.12, base)]] as Array<[string, Rgb]>) {
        for (const [what, fg] of [["title", text], ["date and +N", muted]] as Array<[string, Rgb]>) {
          const ratio = contrast(fg, bg);
          assert.ok(ratio >= 4.5, `${scheme} ${name}${state} ${what}: ${ratio.toFixed(2)}`);
        }
      }
    }
  }
});

test("light compact rows paint paper, and title, date and +N stay AA on every paper stop, with and without the now wash", () => {
  const rows = stops();
  const ink = hex("#16120f");
  const sub = hex("#5a534d");
  const mix = (colour: Rgb, share: number, base: string) => over(colour, share, hex(base));
  const papers: Array<[string, Rgb, Rgb]> = [["social", PINK, ORANGE]];
  for (const [slot, [g1, g2]] of rows.entries()) papers.push([`grad-${slot}`, g1, g2]);
  for (const [name, g1, g2] of papers) {
    for (const [at, paper] of [["start", mix(g1, 0.1, "#fdfbf9")], ["end", mix(g2, 0.13, "#f7f4f1")]] as Array<[string, Rgb]>) {
      for (const [state, bg] of [["", paper], [" happening now", over(hex("#e0115f"), 0.08, paper)]] as Array<[string, Rgb]>) {
        for (const [what, fg] of [["title", ink], ["date and +N", sub]] as Array<[string, Rgb]>) {
          const ratio = contrast(fg, bg);
          assert.ok(ratio >= 4.5, `light paper ${name} ${at}${state} ${what}: ${ratio.toFixed(2)}`);
        }
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
