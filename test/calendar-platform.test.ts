import assert from "node:assert/strict";
import test from "node:test";
import { calendarFeedSteps, calendarPlatform } from "../public/calendar-feed.js";

const PIXEL = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const SAMSUNG = "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const FIREFOX_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPADOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

test("Android phones never get the webcal path", () => {
  assert.equal(calendarPlatform(PIXEL), "android");
  assert.equal(calendarPlatform(SAMSUNG), "android");
  assert.equal(calendarPlatform(FIREFOX_ANDROID), "android");
});

test("iPhone, iPadOS (reports as a Mac) and Mac count as Apple", () => {
  assert.equal(calendarPlatform(IPHONE), "apple");
  assert.equal(calendarPlatform(IPADOS), "apple");
});

test("desktops and unknown agents are other", () => {
  assert.equal(calendarPlatform(WINDOWS), "other");
  assert.equal(calendarPlatform(LINUX), "other");
  assert.equal(calendarPlatform(""), "other");
  assert.equal(calendarPlatform(), "other");
});

test("steps are honest about where a feed can be added", () => {
  const android = calendarFeedSteps("android").join(" ");
  assert.match(android, /Google Calendar can only add a feed on a computer/);
  assert.match(android, /From URL/);
  assert.match(android, /Other calendar apps/);
  assert.match(calendarFeedSteps("apple").join(" "), /Add Subscribed Calendar/);
  const other = calendarFeedSteps("other").join(" ");
  assert.match(other, /From URL/);
  assert.match(other, /Subscribe from web/);
  assert.match(other, /Add Subscribed Calendar/);
  for (const platform of ["apple", "android", "other"] as const) {
    for (const line of calendarFeedSteps(platform)) {
      assert.doesNotMatch(line, /automatic|subscribes you|\u2014/i, line);
    }
  }
});
