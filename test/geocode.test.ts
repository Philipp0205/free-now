import assert from "node:assert/strict";
import test from "node:test";
import { parseNominatim, parsePhoton } from "../src/geocode.js";

test("place search parses Photon and Nominatim hits", () => {
  const photon = parsePhoton({
    features: [{
      geometry: { coordinates: [13.404954, 52.520008] },
      properties: { name: "Café Einstein", street: "Unter den Linden", city: "Berlin" },
    }],
  });
  assert.deepEqual(photon, [{ name: "Café Einstein, Unter den Linden, Berlin", lat: 52.520008, lng: 13.404954 }]);

  const nominatim = parseNominatim([{
    lat: "52.5163",
    lon: "13.3777",
    display_name: "Brandenburg Gate, Pariser Platz, Berlin, Germany",
  }]);
  assert.equal(nominatim[0].name, "Brandenburg Gate, Pariser Platz, Berlin");
  assert.equal(nominatim[0].lat, 52.5163);
  assert.equal(nominatim[0].lng, 13.3777);
  assert.deepEqual(parseNominatim({ display_name: "nope" }), []);
});