import assert from "node:assert/strict";
import test from "node:test";
import { describeBuzzRequest, readBuzzPoint } from "../../src/social/buzz-location.js";

const read = (body: Record<string, unknown> = {}, query = "", headers: Record<string, string | string[] | undefined> = {}) =>
  readBuzzPoint(body, new URLSearchParams(query), headers);

test("body lat/lng and latitude/longitude are read and rounded to about 100 m", () => {
  assert.deepEqual(read({ lat: 52.52049, lng: 13.40512 }), { lat: 52.52, lng: 13.405 });
  assert.deepEqual(read({ latitude: "52.5204", longitude: "13.4051" }), { lat: 52.52, lng: 13.405 });
});

test("body location as an object or a lat,lng string", () => {
  assert.deepEqual(read({ location: { lat: 48.1, lng: 11.5 } }), { lat: 48.1, lng: 11.5 });
  assert.deepEqual(read({ location: { latitude: 48.1, longitude: 11.5 } }), { lat: 48.1, lng: 11.5 });
  assert.deepEqual(read({ location: "48.1374, 11.5755" }), { lat: 48.137, lng: 11.576 });
});

test("query params lat/lng and latitude/longitude", () => {
  assert.deepEqual(read({}, "lat=48.1&lng=11.5"), { lat: 48.1, lng: 11.5 });
  assert.deepEqual(read({}, "press=single&latitude=48.1&longitude=-11.5"), { lat: 48.1, lng: -11.5 });
});

test("headers: pairs, combined location or gps, and x- and flic- prefixes", () => {
  assert.deepEqual(read({}, "", { latitude: "48.1", longitude: "11.5" }), { lat: 48.1, lng: 11.5 });
  assert.deepEqual(read({}, "", { lat: "48.1", lng: "11.5" }), { lat: 48.1, lng: 11.5 });
  assert.deepEqual(read({}, "", { location: "48.1,11.5" }), { lat: 48.1, lng: 11.5 });
  assert.deepEqual(read({}, "", { gps: "48.1,11.5" }), { lat: 48.1, lng: 11.5 });
  assert.deepEqual(read({}, "", { "x-latitude": "48.1", "x-longitude": "11.5" }), { lat: 48.1, lng: 11.5 });
  assert.deepEqual(read({}, "", { "flic-location": "48.1,11.5" }), { lat: 48.1, lng: 11.5 });
  assert.deepEqual(read({}, "", { "x-flic-gps": "48.1,11.5" }), { lat: 48.1, lng: 11.5 });
  assert.deepEqual(read({}, "", { "x-location": ["48.1,11.5"] }), { lat: 48.1, lng: 11.5 });
});

test("the body wins over the query, and the query over headers", () => {
  assert.deepEqual(read({ lat: 1, lng: 2 }, "lat=3&lng=4", { lat: "5", lng: "6" }), { lat: 1, lng: 2 });
  assert.deepEqual(read({}, "lat=3&lng=4", { lat: "5", lng: "6" }), { lat: 3, lng: 4 });
});

test("junk, partial and out of range values are ignored, never thrown", () => {
  assert.equal(read(), null);
  assert.equal(read({}, "lat=48.1"), null);
  assert.equal(read({}, "", { latitude: "48.1" }), null);
  assert.equal(read({}, "", { latitude: "abc", longitude: "11.5" }), null);
  assert.equal(read({}, "", { latitude: "", longitude: "" }), null);
  assert.equal(read({}, "", { location: "somewhere" }), null);
  assert.equal(read({}, "", { location: "1,2,3" }), null);
  assert.equal(read({}, "", { latitude: "95", longitude: "11.5" }), null);
  assert.equal(read({ location: 5 }), null);
  assert.equal(read({ lat: "x", lng: "y" }), null);
});

test("a bad header does not hide a good query", () => {
  assert.deepEqual(read({}, "lat=48.1&lng=11.5", { location: "junk" }), { lat: 48.1, lng: 11.5 });
});

test("the log line names headers and body keys only, never values", () => {
  const line = describeBuzzRequest({ note: "secret note" }, { "button-name": "Kitchen", timestamp: "123" });
  assert.equal(line, "flic press without location headers=[button-name,timestamp] body=[note]");
  assert.ok(!line.includes("Kitchen") && !line.includes("secret"));
});
