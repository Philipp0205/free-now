import assert from "node:assert/strict";
import test from "node:test";
import { extractBuzzSecret, humanCode } from "../src/code.js";
import { labelNear } from "../src/geocode.js";

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
});
