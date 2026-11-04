import assert from "node:assert/strict";
import test from "node:test";
import { parseNominatim, parsePhoton, rankPlaces, resolveMapsLink, reversePlace, searchPlaces, type PlaceCandidate } from "../src/geocode.js";

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
  assert.equal(ratto.length, 1);
  assert.equal(ratto[0].name, "RATTO Bistrobar");
  assert.ok((ratto[0].distanceM ?? 99999) < 5000);

  const platz = rankPlaces(candidates.filter((hit) => hit.name === "Schlossplatz"), STUTTGART, "Schlossplatz");
  assert.equal(platz.length, 1);
  assert.equal(platz[0].address, "the square");
});

test("Schlossplatz keeps the square 20 m away and merges the duplicate spellings", () => {
  const hits = rankPlaces([
    { name: "Schloßplatz", address: "Neuhausen auf den Fildern", lat: 48.6831, lng: 9.2776, osmKey: "leisure", osmValue: "park", osmId: "park" },
    { name: "Schlossplatz", address: "Stuttgart-Mitte", lat: 48.77855, lng: 9.17995, osmKey: "place", osmValue: "square", osmId: "square" },
    { name: "Schlossplatz", address: "Stuttgart-Mitte", lat: 48.7782, lng: 9.1802, osmKey: "highway", osmValue: "path", osmId: "path" },
    { name: "Schlossplatz", address: "Stuttgart-Mitte", lat: 48.779, lng: 9.179, osmKey: "railway", osmValue: "stop", osmId: "stop" },
    { name: "Schloßplatz", address: "Stuttgart-Mitte", lat: 48.7786, lng: 9.18, osmKey: "highway", osmValue: "bus_stop", osmId: "bus" },
  ], STUTTGART, "Schlossplatz");
  assert.equal(hits[0].address, "Stuttgart-Mitte");
  assert.ok((hits[0].distanceM ?? 999) < 100);
  assert.equal(hits.filter((hit) => hit.address === "Stuttgart-Mitte").length, 1);
  assert.equal(hits[1]?.address, "Neuhausen auf den Fildern");
  assert.ok((hits[1]?.distanceM ?? 0) > 10_000);
  assert.ok(hits.every((hit) => (hit.distanceM ?? 0) <= 50_000));
});

test("a known location drops places more than 50 km away", () => {
  const hits = rankPlaces([
    { name: "RATTO Bistrobar", address: "Cottastraße 4, Stuttgart-Süd", lat: 48.7674, lng: 9.1708, osmKey: "amenity", osmValue: "bar", osmId: "bar" },
    { name: "Ratto", address: "Borbona, Rieti", lat: 42.5124, lng: 13.1644, osmKey: "waterway", osmValue: "river", osmId: "river" },
    { name: "Ratto", address: "Khamanon Tahsil, Fatehgarh Sahib", lat: 30.8614, lng: 76.3688, osmKey: "place", osmValue: "village", osmId: "village" },
  ], STUTTGART, "Ratto");
  assert.deepEqual(hits.map((hit) => hit.name), ["RATTO Bistrobar"]);
});

test("without a location the search only applies a Germany bias", async () => {
  const urls: string[] = [];
  const hits = await searchPlaces("Ratto", null, async (url) => {
    urls.push(url);
    if (url.includes("photon")) {
      return { features: [{ geometry: { coordinates: [9.17, 48.77] }, properties: { name: "RATTO Bistrobar", city: "Stuttgart", osm_key: "amenity", osm_value: "bar" } }] };
    }
    return [{ lat: "48.77", lon: "9.17", name: "RATTO Bistrobar", display_name: "RATTO Bistrobar, Stuttgart", class: "amenity", type: "bar", address: { city: "Stuttgart" } }];
  });
  assert.match(urls[0], /bbox=5\.8663,47\.2701,15\.0419,55\.0815/);
  assert.doesNotMatch(urls[0], /[?&]lat=/);
  assert.match(urls[1], /countrycodes=de/);
  assert.doesNotMatch(urls[1], /viewbox=/);
  assert.equal(hits[0].name, "RATTO Bistrobar");
  assert.equal(hits[0].distanceM, null);
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
  assert.deepEqual(hits.map((hit) => hit.name), ["RATTO Bistrobar"]);
});

test("reverse geocoding keeps a Photon venue and falls back to Nominatim", async () => {
  const venueUrls: string[] = [];
  const venue = await reversePlace(48.76741, 9.17085, async (url) => {
    venueUrls.push(url);
    return {
      features: [{
        geometry: { coordinates: [9.17085, 48.76741] },
        properties: { name: "RATTO Bistrobar", osm_key: "amenity", osm_value: "bar" },
      }],
    };
  });
  assert.equal(venue, "RATTO Bistrobar");
  assert.deepEqual(venueUrls, ["https://photon.komoot.io/reverse?lon=9.17085&lat=48.76741"]);

  const streetUrls: string[] = [];
  const street = await reversePlace(52.52001, 13.40495, async (url) => {
    streetUrls.push(url);
    if (url.includes("photon.komoot.io")) return { features: [] };
    return { address: { road: "Schlossplatz", suburb: "Stuttgart-Mitte", city: "Stuttgart" } };
  });
  assert.equal(street, "Near Schlossplatz, Stuttgart-Mitte");
  assert.deepEqual(streetUrls, [
    "https://photon.komoot.io/reverse?lon=13.40495&lat=52.52001",
    "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=52.52001&lon=13.40495",
  ]);
});

const BAGEL = "https://www.google.com/maps/place/jomi+Bagel+Deli,+Johannesstra%C3%9Fe+65/";
const BAGEL_DE = "https://www.google.de/maps/place/jomi+Bagel+Deli,+Johannesstra%C3%9Fe+65/";
const CONSENT = `https://consent.google.com/m?continue=${encodeURIComponent(BAGEL)}&gl=DE`;

test("maps links resolve a short link, coordinates, and reject other hosts", async () => {
  const fetched: string[] = [];
  const searched: string[] = [];
  const fetchImpl = async (url: string) => {
    fetched.push(url);
    if (url === "https://maps.app.goo.gl/L9qMNeDJHDcZEnRs8") {
      return {
        status: 302,
        headers: { get: (name: string) => (name.toLowerCase() === "location" ? BAGEL_DE : null) },
        body: { cancel: async () => {}, text: async () => { throw new Error("body was read"); } },
      };
    }
    if (url === "https://maps.app.goo.gl/consent") {
      return {
        status: 302,
        headers: { get: (name: string) => (name.toLowerCase() === "location" ? CONSENT : null) },
        body: { cancel: async () => {} },
      };
    }
    if (url.includes("consent.google.com") || url.includes("/maps")) {
      return {
        status: 302,
        headers: { get: (name: string) => (name.toLowerCase() === "location" ? CONSENT : null) },
        body: { cancel: async () => {} },
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const fetchJson = async (url: string) => {
    searched.push(url);
    if (url.includes("photon.komoot.io/reverse")) {
      return { features: [{ geometry: { coordinates: [9.18, 48.7784] }, properties: { name: "Schlossplatz", osm_key: "amenity", osm_value: "cafe" } }] };
    }
    if (url.includes("photon.komoot.io")) {
      return { features: [{ geometry: { coordinates: [9.183, 48.775] }, properties: { name: "jomi Bagel Deli", city: "Stuttgart", osm_key: "amenity", osm_value: "cafe" } }] };
    }
    return [];
  };

  const bagel = await resolveMapsLink("https://maps.app.goo.gl/L9qMNeDJHDcZEnRs8", fetchJson, fetchImpl);
  assert.equal(bagel[0]?.name, "jomi Bagel Deli");
  assert.ok(searched.some((url) => decodeURIComponent(url).includes("jomi Bagel Deli")));
  assert.deepEqual(fetched, ["https://maps.app.goo.gl/L9qMNeDJHDcZEnRs8"]);

  const consent = await resolveMapsLink("https://maps.app.goo.gl/consent", fetchJson, fetchImpl);
  assert.equal(consent[0]?.name, "jomi Bagel Deli");
  assert.deepEqual(fetched.filter((url) => url.includes("consent.google")), []);

  searched.length = 0;
  const again = await resolveMapsLink("https://maps.app.goo.gl/L9qMNeDJHDcZEnRs8", fetchJson, fetchImpl);
  assert.equal(again[0]?.name, "jomi Bagel Deli");
  assert.equal(searched.length, 0);

  const fetchesBeforePins = fetched.length;
  const at = await resolveMapsLink("https://www.google.com/maps/@48.7784,9.18,17z", fetchJson, fetchImpl);
  assert.equal(at.length, 1);
  assert.equal(at[0].lat, 48.7784);
  assert.equal(at[0].lng, 9.18);
  assert.equal(at[0].name, "Schlossplatz");

  const pin = await resolveMapsLink("https://www.google.com/maps/place/Cafe+Ada/@48.1,9.1,17z/data=!3d48.7674!4d9.1708", fetchJson, fetchImpl);
  assert.equal(pin.length, 1);
  assert.equal(pin[0].name, "Cafe Ada");
  assert.equal(pin[0].lat, 48.7674);
  assert.equal(pin[0].lng, 9.1708);
  assert.equal(fetched.length, fetchesBeforePins);

  const de = await resolveMapsLink("https://www.google.de/maps/@52.52,13.405,15z", fetchJson, fetchImpl);
  assert.equal(de[0]?.lat, 52.52);
  assert.equal(fetched.length, fetchesBeforePins);

  const before = fetched.length;
  const rejected = await resolveMapsLink("https://evil.example/maps/place/Secret", fetchJson, fetchImpl);
  assert.deepEqual(rejected, []);
  assert.equal(fetched.length, before);
  assert.deepEqual(await resolveMapsLink("http://www.google.com/maps/place/Cafe", fetchJson, fetchImpl), []);
  assert.deepEqual(await resolveMapsLink("https://goo.gl/not-maps", fetchJson, fetchImpl), []);
  assert.deepEqual(await resolveMapsLink("https://www.google.evil/maps/place/Cafe", fetchJson, fetchImpl), []);
});

test("geocode logs the upstream status and not the query", async () => {
  const logs: string[] = [];
  const previous = console.log;
  const original = globalThis.fetch;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("photon")) return new Response("nope", { status: 503 });
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  }) as typeof fetch;
  try {
    await searchPlaces("Cafe Secret Name", null);
  } finally {
    console.log = previous;
    globalThis.fetch = original;
  }
  assert.ok(logs.includes("geocode upstream photon status=503"));
  assert.ok(logs.includes("geocode upstream nominatim status=timeout"));
  assert.ok(logs.every((line) => !line.includes("Secret") && !line.includes("Cafe")));
});
