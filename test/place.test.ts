import assert from "node:assert/strict";
import test from "node:test";
import { audiencePlace, formatDistance, haversine, isMapsLink, looksLikeUrl } from "../public/place.js";

test("near you reads as nearby", () => {
  assert.equal(audiencePlace("near you"), "nearby");
  assert.equal(audiencePlace("Near you"), "nearby");
  assert.equal(audiencePlace(" near you "), "nearby");
  assert.equal(audiencePlace("Near Schlossplatz, Stuttgart-Mitte"), "Near Schlossplatz, Stuttgart-Mitte");
});

test("distance labels never step down at the kilometre threshold", () => {
  assert.equal(formatDistance(0), "10 m");
  assert.equal(formatDistance(944), "940 m");
  assert.equal(formatDistance(945), "950 m");
  assert.equal(formatDistance(949), "950 m");
  // Round to the 10 m step first, then switch to km only at 1000.
  assert.equal(formatDistance(950), "950 m");
  assert.equal(formatDistance(951), "950 m");
  assert.equal(formatDistance(994), "990 m");
  assert.equal(formatDistance(995), "1.0 km");
  assert.equal(formatDistance(996), "1.0 km");
  assert.equal(formatDistance(1000), "1.0 km");
  assert.equal(formatDistance(9999), "10.0 km");
  assert.equal(formatDistance(10000), "10 km");
  assert.equal(formatDistance(10499), "10 km");
  assert.equal(formatDistance(10500), "11 km");
  assert.equal(formatDistance(100000), "100 km");
});

test("haversine matches one degree of latitude", () => {
  // Mean earth radius 6371000 m. One degree of latitude is R * π / 180.
  const equator = { lat: 0, lng: 0 };
  const oneDegreeNorth = { lat: 1, lng: 0 };
  assert.equal(haversine(equator, oneDegreeNorth), 111194.92664455874);
  assert.equal(haversine(oneDegreeNorth, equator), 111194.92664455874);
});

test("the client knows a Google Maps link from any other URL", () => {
  for (const link of [
    "https://www.google.com/maps/place/Cafe+Ada/",
    "https://google.com/maps/place/Cafe+Ada/",
    "https://google.co.uk/maps/@51.5,-0.12,15z",
    "https://maps.google.com/?q=48.7674,9.1708",
    "https://maps.google.de/maps/place/Cafe",
    "https://maps.app.goo.gl/L9qMNeDJHDcZEnRs8",
    "https://goo.gl/maps/abc",
    "  https://google.com/maps  ",
  ]) {
    assert.equal(isMapsLink(link), true, link);
  }
  for (const other of [
    "https://example.com/maps/place/Cafe",
    "https://google.com/search?q=cafe",
    "https://notgoogle.com/maps/place/Cafe",
    "http://google.com/maps/place/Cafe",
    "https://goo.gl/not-maps",
    "google.com/maps",
    "Cafe Ada",
  ]) {
    assert.equal(isMapsLink(other), false, other);
  }
});

test("anything starting with http or https looks like a URL", () => {
  assert.equal(looksLikeUrl("https://example.com"), true);
  assert.equal(looksLikeUrl("http://example.com"), true);
  assert.equal(looksLikeUrl("  HTTPS://Example.com "), true);
  assert.equal(looksLikeUrl("Cafe Ada"), false);
  assert.equal(looksLikeUrl("www.example.com"), false);
  assert.equal(looksLikeUrl(""), false);
  assert.equal(looksLikeUrl(null), false);
});
