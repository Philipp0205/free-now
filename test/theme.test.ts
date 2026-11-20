import assert from "node:assert/strict";
import test from "node:test";
import { SCHEME_ATTR, THEME_KEY, parseTheme, readTheme, schemeFor, writeTheme } from "../public/js/app-meta/theme.js";
import { applyTheme } from "../public/js/app-meta/theme-apply.js";
import { THEME_COPY } from "../public/js/app-meta/theme-copy.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
  };
}

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    removeAttribute: (name: string) => { attrs.delete(name); },
  };
}

function fakeKit() {
  const calls: unknown[] = [];
  return { calls, start: (options: unknown) => { calls.push(options); } };
}

test("the key and the attribute are the ones the page and the kit read", () => {
  assert.equal(THEME_KEY, "fn_theme");
  assert.equal(SCHEME_ATTR, "data-ak-scheme");
});

test("missing or invalid storage is System", () => {
  assert.equal(readTheme(fakeStorage()), "system");
  assert.equal(readTheme(null), "system");
  for (const bad of ["", "DARK", "auto", "1", " light", "null", "undefined"]) {
    assert.equal(readTheme(fakeStorage({ [THEME_KEY]: bad })), "system", `"${bad}"`);
    assert.equal(parseTheme(bad), "system");
  }
  assert.equal(parseTheme(null), "system");
  assert.equal(parseTheme(undefined), "system");
  assert.equal(parseTheme(7), "system");
  const broken = { getItem: () => { throw new Error("denied"); } };
  assert.equal(readTheme(broken as never), "system");
});

test("a choice is saved and read back, and a bad one is saved as System", () => {
  const store = fakeStorage();
  for (const choice of ["dark", "light", "system"]) {
    writeTheme(choice, store);
    assert.equal(store.data.get(THEME_KEY), choice);
    assert.equal(readTheme(store), choice);
  }
  writeTheme("neon", store);
  assert.equal(store.data.get(THEME_KEY), "system");
  assert.doesNotThrow(() => writeTheme("dark", { setItem: () => { throw new Error("full"); } } as never));
});

test("System forces nothing, Dark and Light force their own scheme", () => {
  assert.equal(schemeFor("system"), null);
  assert.equal(schemeFor("dark"), "dark");
  assert.equal(schemeFor("light"), "light");
  assert.equal(schemeFor("junk"), null);
  assert.equal(schemeFor(undefined), null);
});

test("applying System leaves data-ak-scheme unset", () => {
  const root = fakeRoot();
  applyTheme("system", root as never, fakeKit());
  assert.equal(root.attrs.has(SCHEME_ATTR), false);
});

test("applying Dark or Light sets the matching attribute", () => {
  const root = fakeRoot();
  applyTheme("dark", root as never, fakeKit());
  assert.equal(root.attrs.get(SCHEME_ATTR), "dark");
  applyTheme("light", root as never, fakeKit());
  assert.equal(root.attrs.get(SCHEME_ATTR), "light");
});

test("applying System after a forced value clears the attribute", () => {
  const root = fakeRoot();
  for (const forced of ["dark", "light"]) {
    applyTheme(forced, root as never, fakeKit());
    assert.equal(root.attrs.get(SCHEME_ATTR), forced);
    applyTheme("system", root as never, fakeKit());
    assert.equal(root.attrs.has(SCHEME_ATTR), false, `after ${forced}`);
  }
});

test("a change asks the kit to read the browser bar colour again, for the phone width", () => {
  const root = fakeRoot();
  const kit = fakeKit();
  applyTheme("light", root as never, kit);
  applyTheme("system", root as never, kit);
  assert.deepEqual(kit.calls, [{ media: ["(max-width: 719px)"] }, { media: ["(max-width: 719px)"] }]);
  assert.doesNotThrow(() => applyTheme("dark", root as never, undefined));
});

test("the words for the three choices", () => {
  assert.deepEqual(THEME_COPY.options, { system: "System", dark: "Dark", light: "Light" });
  for (const text of [THEME_COPY.section, THEME_COPY.heading, THEME_COPY.help, ...Object.values(THEME_COPY.options)]) {
    assert.ok(!text.includes("\u2014"), text);
  }
});
