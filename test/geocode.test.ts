import assert from "node:assert/strict";
import test from "node:test";
import { parseNominatim, parsePhoton, rankPlaces, searchPlaces, type PlaceCandidate } from "../src/geocode.js";

const STUTTGART = { lat: 48.7784, lng: 9.18 };

test("place search parses Photon and Nominatim hits", () => {
  const photon = parsePhoton({
    features: [{
      geometry: { coordinates: [13.404954, 52.520008] },
      properties: { name: "Café Einstein", street: "Unter den Linden", city: "Berlin", osm_key: "amenity", osm_value: "cafe" },
    }],
  });
  assert.equal(photon[0].name, "Café Einstein");
  assert.equal(photon[0].address, "Unter den Linden, Berlin");
  assert.equal(photon[0].lat, 52.520008);
  assert.equal(photon[0].osmKey, "amenity");

  const nominatim = parseNominatim([{
    lat: "52.5163",
    lon: "13.3777",
    name: "Brandenburg Gate",
    display_name: "Brandenburg Gate, Pariser Platz, Berlin, Germany",
    class: "tourism",
    type: "attraction",
  }]);
  assert.equal(nominatim[0].name, "Brandenburg Gate");
  assert.equal(nominatim[0].address, "Pariser Platz, Berlin");
  assert.equal(nominatim[0].lat, 52.5163);
  assert.equal(nominatim[0].lng, 13.3777);
  assert.deepEqual(parseNominatim({ display_name: "nope" }), []);
});

test("nearby bars outrank same-name villages", () => {
  const candidates: PlaceCandidate[] = [
    { name: "Ratto", address: "Punjab", lat: 30.8614, lng: 76.3688, osmKey: "place", osmValue: "village", osmId: "village" },
    { name: "RATTO Bistrobar", address: "Cottastraße 4, Stuttgart-Süd", lat: 48.7674, lng: 9.1708, osmKey: "amenity", osmValue: "bar", osmId: "bar" },
    { name: "Schlossplatz", address: "the path", lat: 48.7784, lng: 9.18, osmKey: "highway", osmValue: "path", osmId: "path" },
    { name: "Schlossplatz", address: "the square", lat: 48.7784, lng: 9.1801, osmKey: "place", osmValue: "square", osmId: "square" },
  ];
  const ratto = rankPlaces(candidates.filter((hit) => /ratto/i.test(hit.name)), STUTTGART, "Ratto");
  assert.equal(ratto[0].name, "RATTO Bistrobar");
  assert.ok((ratto[0].distanceM ?? 99999) < 5000);
  assert.equal(ratto[1].name, "Ratto");

  const platz = rankPlaces(candidates.filter((hit) => hit.name === "Schlossplatz"), STUTTGART, "Schlossplatz");
  assert.equal(platz.length, 1);
  assert.equal(platz[0].address, "the square");
});

test("Ratto with a Stuttgart centre comes back as the local bar", async () => {
  const urls: string[] = [];
  const hits = await searchPlaces("Ratto", STUTTGART, async (url) => {
    urls.push(url);
    if (url.includes("photon.komoot.io")) {
      return {
        features: [{
          geometry: { coordinates: [9.1708506, 48.7674143] },
          properties: {
            name: "RATTO Bistrobar",
            osm_key: "amenity",
            osm_value: "bar",
            osm_type: "node",
            osm_id: 42,
            street: "Cottastraße",
            housenumber: "4",
            district: "Stuttgart-Süd",
            city: "Stuttgart",
          },
        }],
      };
    }
    return [
      {
        lat: "48.7674143",
        lon: "9.1708506",
        name: "RATTO Bistrobar",
        class: "amenity",
        type: "bar",
        osm_id: 42,
        display_name: "RATTO Bistrobar, 4, Cottastraße, Stuttgart",
        address: { house_number: "4", road: "Cottastraße", city_district: "Stuttgart-Süd", city: "Stuttgart" },
      },
      {
        lat: "30.861366",
        lon: "76.368766",
        name: "Ratto",
        class: "place",
        type: "village",
        osm_id: 7,
        display_name: "Ratto, Punjab, India",
        address: { village: "Ratto", state: "Punjab" },
      },
    ];
  });
  assert.match(urls[0], /bbox=/);
  assert.match(urls[0], /lat=48\.7784/);
  assert.match(urls[0], /location_bias_scale=/);
  assert.match(urls[1], /viewbox=/);
  assert.match(urls[1], /bounded=0/);
  assert.equal(hits[0].name, "RATTO Bistrobar");
  assert.match(hits[0].address, /Cottastraße/);
  assert.match(hits[0].address, /Stuttgart/);
  assert.ok(hits[0].lat > 48.7 && hits[0].lat < 48.8);
  assert.ok((hits[0].distanceM ?? 0) > 0 && (hits[0].distanceM ?? 99999) < 5000);
  assert.equal(hits.at(-1)?.name, "Ratto");
  assert.ok(hits.length <= 6);
});
