import assert from "node:assert/strict";
import test from "node:test";
import { extractBuzzSecret, humanCode } from "../src/code.js";
import { describeNearby, labelNear, rankPlaces } from "../src/geocode.js";
import { freePushBody } from "../src/notify.js";

test("recovery codes are short and a pasted curl or URL still yields the secret", () => {
  const code = humanCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(extractBuzzSecret(code.replace(/-/g, "")), code);
  assert.equal(extractBuzzSecret(`  ${code.toLowerCase()}  `), code);
  assert.equal(
    extractBuzzSecret("curl -X POST https://hangry.example/api/buzz/ABCD-EFGH-JKLM -H 'content-type: application/json'"),
    "ABCD-EFGH-JKLM",
  );
  assert.equal(extractBuzzSecret("https://hangry.example/api/buzz/legacysecret"), "legacysecret");
});

test("reverse geocoding names a nearby venue, otherwise a street", () => {
  const venue = labelNear(48.7784, 9.18, {
    features: [{
      geometry: { coordinates: [9.1801, 48.77845] },
      properties: { name: "RATTO Bistrobar", osm_key: "amenity", osm_value: "bar", street: "Cottastraße", housenumber: "4", district: "Stuttgart-Süd" },
    }],
  });
  assert.equal(venue, "RATTO Bistrobar");
  const street = labelNear(48.7784, 9.18, {
    features: [{
      geometry: { coordinates: [9.182, 48.779] },
      properties: { name: "Somewhere", osm_key: "highway", osm_value: "residential", street: "Cottastraße", housenumber: "4", district: "Stuttgart-Süd" },
    }],
  });
  assert.equal(street, "Near Cottastraße 4, Stuttgart-Süd");
  const city = labelNear(48.7784, 9.18, {
    features: [{
      geometry: { coordinates: [9.1800132, 48.7784485] },
      properties: {
        name: "Stuttgart",
        osm_key: "place",
        osm_value: "city",
        street: "Königstraße",
        housenumber: "1",
        district: "Stuttgart-Mitte",
      },
    }],
  });
  assert.equal(city, "");
  const photonCity = {
    features: [{
      geometry: { coordinates: [9.1800132, 48.7784485] },
      properties: { name: "Stuttgart", osm_key: "place", osm_value: "city" },
    }],
  };
  assert.equal(describeNearby(48.7784, 9.18, photonCity, {
    name: "",
    address: { road: "Schlossplatz", suburb: "Stuttgart-Mitte", city: "Stuttgart" },
  }), "Near Schlossplatz, Stuttgart-Mitte");
  assert.equal(describeNearby(48.7784, 9.18, photonCity, {
    name: "Schlossplatz",
    address: { suburb: "Stuttgart-Mitte", city: "Stuttgart" },
  }), "Near Schlossplatz, Stuttgart-Mitte");
});

test("a fallback place is nearby in a friend's push, not near you", () => {
  assert.equal(freePushBody("Bea", "near you"), "Bea is free nearby");
  assert.equal(freePushBody("Bea", ""), "Bea is free now");
  assert.equal(freePushBody("Bea", "Near Schlossplatz, Stuttgart-Mitte"), "Bea is free near Schlossplatz, Stuttgart-Mitte");
});

test("without a location, the same name in one locality collapses", () => {
  const hits = rankPlaces([
    { name: "Ratte", address: "Narsdorf, Geithain", lat: 51.01, lng: 12.71, osmKey: "place", osmValue: "village", osmId: "a" },
    { name: "Ratte", address: "Narsdorf, Geithain", lat: 51.02, lng: 12.74, osmKey: "place", osmValue: "hamlet", osmId: "b" },
    { name: "Ratte", address: "Narsdorf, Geithain", lat: 51.03, lng: 12.78, osmKey: "highway", osmValue: "residential", osmId: "c" },
  ], null, "Ratte");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "Ratte");
});
