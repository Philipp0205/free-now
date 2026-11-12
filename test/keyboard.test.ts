import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { keyboardIsOpen, keyboardOffset, tabbarOverlapsKeyboard } from "../public/js/keyboard.js";

test("keyboard offset is innerHeight minus visual height minus offsetTop", () => {
  assert.equal(keyboardOffset(800, 500, 0), 300);
  assert.equal(keyboardOffset(800, 500, 40), 260);
  assert.equal(keyboardOffset(800, 500.4, 0.4), 299);
  assert.equal(keyboardOffset(800, 820, 0), 0);
  assert.equal(keyboardOffset(800, 500, 400), 0);
  assert.equal(keyboardOffset(Number.NaN, 500, 0), 0);
});

test("a shrunken touch viewport counts as a keyboard only while typing", () => {
  const shrunk = { offset: 0, restingHeight: 900, viewportHeight: 520, virtualKeyboardHeight: 0 };
  assert.equal(keyboardIsOpen({ ...shrunk, focused: true, touchUi: true }), true);
  assert.equal(keyboardIsOpen({ ...shrunk, focused: false, touchUi: true }), false);
  assert.equal(keyboardIsOpen({ ...shrunk, focused: true, touchUi: false }), false);
  assert.equal(keyboardIsOpen({ offset: 300, focused: false, restingHeight: 900, viewportHeight: 600, touchUi: false }), true);
});

test("virtual keyboard height is optional and ignored on desktop", () => {
  assert.equal(keyboardIsOpen({
    offset: 0,
    focused: true,
    restingHeight: 800,
    viewportHeight: 800,
    virtualKeyboardHeight: 320,
    touchUi: false,
  }), false);
  assert.equal(keyboardIsOpen({
    offset: 0,
    focused: true,
    restingHeight: 800,
    viewportHeight: 800,
    virtualKeyboardHeight: 320,
    touchUi: true,
  }), true);
  assert.equal(keyboardIsOpen({
    offset: 0,
    focused: true,
    restingHeight: 800,
    viewportHeight: 800,
    virtualKeyboardHeight: 0,
    touchUi: true,
  }), false);
});

test("bottom nav hides only when the keyboard overlaps it", () => {
  assert.equal(tabbarOverlapsKeyboard({
    barTop: 760,
    barBottom: 844,
    layoutHeight: 844,
    offset: 320,
    shrunk: 320,
  }), true);
  assert.equal(tabbarOverlapsKeyboard({
    barTop: 760,
    barBottom: 844,
    layoutHeight: 844,
    offset: 0,
    shrunk: 0,
  }), false);
  assert.equal(tabbarOverlapsKeyboard({
    barTop: 456,
    barBottom: 520,
    layoutHeight: 520,
    offset: 0,
    shrunk: 380,
  }), true);
  assert.equal(tabbarOverlapsKeyboard({
    barTop: 100,
    barBottom: 164,
    layoutHeight: 520,
    offset: 0,
    shrunk: 380,
  }), false);
  assert.equal(tabbarOverlapsKeyboard({
    barTop: 760,
    barBottom: 844,
    layoutHeight: 844,
    offset: 0,
    shrunk: 0,
    virtualKeyboardTop: 500,
    virtualKeyboardBottom: 844,
  }), true);
  assert.equal(tabbarOverlapsKeyboard({
    barTop: 0,
    barBottom: 64,
    layoutHeight: 844,
    offset: 0,
    shrunk: 0,
    virtualKeyboardTop: 500,
    virtualKeyboardBottom: 844,
  }), false);
});

test("viewport meta and sheet css opt into the keyboard inset", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../public/css/styles.css", import.meta.url), "utf8");
  assert.match(html, /name="viewport"[^>]*interactive-widget=resizes-content/);
  assert.match(css, /--kb-offset/);
  assert.match(css, /100dvh/);
  assert.match(css, /100svh/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(css, /\b100vh\b/);
});
