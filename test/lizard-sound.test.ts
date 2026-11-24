import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { staticHeaders } from "../src/lib/static.js";
import { LIZARD_SRC, createLizard, installLizardUnlock, playLizard } from "../public/js/buzzer/lizard-sound.js";
import { withApp } from "./http.js";

type Clip = { play: () => unknown; pause?: () => void; currentTime?: number; paused?: boolean };

/** A document that only records listeners, so a test can fire a gesture by name. */
function fakeDoc() {
  const listeners = new Map<string, Array<() => void>>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (type: string, fn: () => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener: (type: string, fn: () => void) => { listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)); },
  };
  const fire = (type: string) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(); };
  const count = (type: string) => (listeners.get(type) ?? []).length;
  return { doc, fire, count };
}

test("playLizard builds the clip once and calls play on it", () => {
  const calls: string[] = [];
  const lizard = createLizard({ make: () => ({ play: () => { calls.push("play"); return Promise.resolve(); } }) as Clip, doc: null });
  lizard.play();
  assert.deepEqual(calls, ["play"]);
});

test("one shared element plays every buzz, rewound to the start, and is built only once", () => {
  let made = 0;
  const clip: Clip = { currentTime: 3, play: () => Promise.resolve() };
  const lizard = createLizard({ make: () => { made += 1; return clip; }, doc: null });
  lizard.play();
  clip.currentTime = 0.5;
  lizard.play();
  assert.equal(made, 1);
  assert.equal(clip.currentTime, 0);
});

test("the first gesture unlocks the shared clip: play, pause, rewind, then the buzz reuses that element", () => {
  const { doc, fire, count } = fakeDoc();
  const calls: string[] = [];
  let made = 0;
  const clip: Clip = {
    currentTime: 0.4,
    play: () => { calls.push("play"); return Promise.resolve(); },
    pause: () => { calls.push("pause"); },
  };
  const lizard = createLizard({ make: () => { made += 1; return clip; }, doc });
  lizard.install();
  lizard.install();
  for (const type of ["click", "touchend", "keydown"]) assert.equal(count(type), 1, `${type} is listened to once`);
  fire("touchend");
  assert.deepEqual(calls, ["play", "pause"]);
  assert.equal(clip.currentTime, 0);
  for (const type of ["click", "touchend", "keydown"]) assert.equal(count(type), 0, `${type} is released after the unlock`);
  fire("click");
  assert.deepEqual(calls, ["play", "pause"], "later taps do not play again");
  lizard.play();
  assert.deepEqual(calls, ["play", "pause", "play"]);
  assert.equal(made, 1, "the buzz used the unlocked element");
});

test("coming back to the app unlocks again on the next gesture, and a blocked buzz asks for it too", async () => {
  const { doc, fire, count } = fakeDoc();
  const calls: string[] = [];
  let blocked = false;
  const clip: Clip = {
    play: () => { calls.push("play"); return blocked ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve(); },
    pause: () => { calls.push("pause"); },
  };
  const lizard = createLizard({ make: () => clip, doc });
  lizard.install();
  fire("click");
  assert.equal(count("click"), 0);
  fire("visibilitychange");
  assert.equal(count("click"), 1, "visible again: wait for a gesture");
  doc.visibilityState = "hidden";
  fire("click");
  fire("visibilitychange");
  doc.visibilityState = "visible";
  blocked = true;
  lizard.play();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(count("click"), 1, "a rejected play() re-arms the unlock");
});

test("an unlock leaves a clip that is sounding alone", () => {
  const { doc, fire } = fakeDoc();
  const calls: string[] = [];
  const clip: Clip = { paused: false, play: () => { calls.push("play"); }, pause: () => { calls.push("pause"); } };
  const lizard = createLizard({ make: () => clip, doc });
  lizard.install();
  fire("click");
  assert.deepEqual(calls, []);
});

test("installLizardUnlock is a no-op without a document, and a second call is harmless", () => {
  assert.equal(typeof document, "undefined");
  assert.doesNotThrow(() => installLizardUnlock());
  assert.doesNotThrow(() => installLizardUnlock());
  assert.doesNotThrow(() => playLizard());
});

test("playLizard does not throw or leak a rejection when play() is blocked", async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const lizard = createLizard({ make: () => ({ play: () => Promise.reject(new Error("NotAllowedError")) }) as Clip, doc: null });
    assert.doesNotThrow(() => lizard.play());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a blocked or failing unlock throws nothing and leaks no rejection", async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const make of [
      () => ({ play: () => Promise.reject(new Error("NotAllowedError")), pause: () => {} }),
      () => ({ play: () => { throw new Error("nope"); }, pause: () => {} }),
      () => { throw new Error("no Audio"); },
    ]) {
      const { doc, fire } = fakeDoc();
      const lizard = createLizard({ make: make as () => Clip, doc });
      lizard.install();
      assert.doesNotThrow(() => fire("click"));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("playLizard survives a play() that throws, a play() with no promise, and a failing constructor", () => {
  assert.doesNotThrow(() => createLizard({ make: () => ({ play: () => { throw new Error("nope"); } }) as Clip, doc: null }).play());
  assert.doesNotThrow(() => createLizard({ make: () => ({ play: () => undefined }) as Clip, doc: null }).play());
  assert.doesNotThrow(() => createLizard({ make: () => { throw new Error("no Audio"); }, doc: null }).play());
});

test("the clip is a small file the server labels audio/mp4", () => {
  const file = new URL(`../public${LIZARD_SRC}`, import.meta.url);
  assert.ok(fs.statSync(file).size < 256 * 1024);
  assert.equal(staticHeaders(".m4a", 1)["content-type"], "audio/mp4");
});

test("GET /sounds/lizard.m4a answers the whole file without Range, a 206 slice with one, and a 416 out of range", async () => {
  await withApp(async ({ port }) => {
    const url = `http://127.0.0.1:${port}${LIZARD_SRC}`;
    const size = fs.statSync(new URL(`../public${LIZARD_SRC}`, import.meta.url)).size;

    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "audio/mp4");
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.equal(whole.headers.get("cache-control"), "no-cache");
    assert.equal((await whole.arrayBuffer()).byteLength, size);

    const slice = await fetch(url, { headers: { range: "bytes=0-1" } });
    assert.equal(slice.status, 206);
    assert.equal(slice.headers.get("content-type"), "audio/mp4");
    assert.equal(slice.headers.get("accept-ranges"), "bytes");
    assert.equal(slice.headers.get("cache-control"), "no-cache");
    assert.ok(slice.headers.get("content-range")?.startsWith("bytes 0-1/"), slice.headers.get("content-range") ?? "");
    assert.equal(slice.headers.get("content-range"), `bytes 0-1/${size}`);
    assert.equal((await slice.arrayBuffer()).byteLength, 2);

    const tail = await fetch(url, { headers: { range: "bytes=-4" } });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get("content-range"), `bytes ${size - 4}-${size - 1}/${size}`);

    const bad = await fetch(url, { headers: { range: `bytes=${size + 10}-` } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), `bytes */${size}`);
    await bad.arrayBuffer();

    const head = await fetch(url, { method: "HEAD", headers: { range: "bytes=0-1" } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get("content-length"), "2");
  });
});

test("other static files still ignore Range and send 200", async () => {
  await withApp(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/whats-new.json`, { headers: { range: "bytes=0-1" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-range"), null);
    await response.arrayBuffer();
  });
});
