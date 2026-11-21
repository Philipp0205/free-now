import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { staticHeaders } from "../src/lib/static.js";
import { LIZARD_SRC, playLizard } from "../public/js/buzzer/lizard-sound.js";
import { isFromOtherMember } from "../public/js/buzzer/lizard-rules.js";

test("playLizard builds the clip and calls play on it", () => {
  const calls: string[] = [];
  playLizard(() => ({ play: () => { calls.push("play"); return Promise.resolve(); } }));
  assert.deepEqual(calls, ["play"]);
});

test("playLizard does not throw or leak a rejection when play() is blocked", async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const blocked = () => ({ play: () => Promise.reject(new Error("NotAllowedError")) });
    assert.doesNotThrow(() => playLizard(blocked));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("playLizard survives a play() that throws, a play() with no promise, and a failing constructor", () => {
  assert.doesNotThrow(() => playLizard(() => ({ play: () => { throw new Error("nope"); } })));
  assert.doesNotThrow(() => playLizard(() => ({ play: () => undefined })));
  assert.doesNotThrow(() => playLizard(() => { throw new Error("no Audio"); }));
});

test("isFromOtherMember is true for another member and false for the signed-in user", () => {
  assert.equal(isFromOtherMember({ creator: { id: "u-mia" } }, "u-noa"), true);
  assert.equal(isFromOtherMember({ creator: { id: "u-noa" } }, "u-noa"), false);
});

test("isFromOtherMember is false when an id is missing", () => {
  assert.equal(isFromOtherMember({ creator: { id: "u-mia" } }, undefined), false);
  assert.equal(isFromOtherMember({ creator: {} }, "u-noa"), false);
  assert.equal(isFromOtherMember({}, "u-noa"), false);
  assert.equal(isFromOtherMember(null, "u-noa"), false);
});

test("the clip is a small file the server labels audio/mp4", () => {
  const file = new URL(`../public${LIZARD_SRC}`, import.meta.url);
  assert.ok(fs.statSync(file).size < 30 * 1024);
  assert.equal(staticHeaders(".m4a", 1)["content-type"], "audio/mp4");
});
