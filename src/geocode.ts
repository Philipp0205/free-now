export type PlaceHit = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  distanceM: number | null;
};

export type PlaceCandidate = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  osmKey: string;
  osmValue: string;
  osmId: string;
};

export type SearchBias = { lat: number; lng: number } | null;

const USER_AGENT = "Hangry/1.0 (+https://github.com/Philipp0205/free-now)";
const CACHE_MS = 10 * 60 * 1000;
const PACE_MS = 1100;
const LOCAL_KM = 30;
const RESULT_CAP = 6;
const NEAR_M = 2_000;
const MERGE_M = 300;
const DROP_M = 50_000;
/** Germany extent for a search with no known point. minLon,minLat,maxLon,maxLat. */
const GERMANY_BBOX = "5.8663,47.2701,15.0419,55.0815";

const cache = new Map<string, { at: number; results: PlaceHit[] }>();
let chain: Promise<void> = Promise.resolve();
let nextAt = 0;

type JsonGetter = (url: string) => Promise<unknown>;

function pace(): Promise<void> {
  const job = chain.then(async () => {
    const wait = Math.max(0, nextAt - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    nextAt = Date.now() + PACE_MS;
  });
  chain = job.then(() => {}, () => {});
  return job;
}

export function parsePhoton(payload: unknown): PlaceCandidate[] {
  const record = payload && typeof payload === "object" ? payload as { features?: unknown; geometry?: unknown } : null;
  const features = Array.isArray(record?.features)
    ? record.features
    : record?.geometry
      ? [payload]
      : [];
  const hits: PlaceCandidate[] = [];
  for (const feature of features) {
    const row = feature && typeof feature === "object" ? feature as {
      geometry?: { coordinates?: unknown };
      properties?: Record<string, unknown>;
    } : null;
    const coords = row?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    const props = row?.properties ?? {};
    const named = placeName(props);
    if (!named || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    hits.push({
      name: named.slice(0, 80),
      address: shortAddress(props, named).slice(0, 80),
      lat,
      lng,
      osmKey: text(props.osm_key),
      osmValue: text(props.osm_value),
      osmId: [text(props.osm_type), text(props.osm_id)].filter(Boolean).join(":"),
    });
  }
  return hits;
}

export function parseNominatim(payload: unknown): PlaceCandidate[] {
  if (!Array.isArray(payload)) return [];
  const hits: PlaceCandidate[] = [];
  for (const row of payload) {
    const item = row && typeof row === "object" ? row as {
      lat?: unknown;
      lon?: unknown;
      name?: unknown;
      display_name?: unknown;
      class?: unknown;
      type?: unknown;
      osm_id?: unknown;
      address?: Record<string, unknown>;
    } : null;
    const lat = Number(item?.lat);
    const lng = Number(item?.lon);
    const display = String(item?.display_name ?? "");
    const named = text(item?.name) || display.split(",")[0]?.trim() || "";
    if (!named || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const address = item?.address && typeof item.address === "object" ? item.address : {};
    const street = [text(address.house_number), text(address.road)].filter(Boolean).join(" ");
    const city = text(address.suburb) || text(address.city_district) || text(address.city) || text(address.town) || text(address.village);
    const line = [street, city].filter(Boolean).join(", ")
      || display.split(",").slice(1, 3).join(",").trim();
    hits.push({
      name: named.slice(0, 80),
      address: line.slice(0, 80),
      lat,
      lng,
      osmKey: text(item?.class),
      osmValue: text(item?.type),
      osmId: text(item?.osm_id),
    });
  }
  return hits;
}

function placeName(props: Record<string, unknown>): string {
  return text(props.name) || [text(props.street), text(props.housenumber)].filter(Boolean).join(" ") || text(props.city);
}

function shortAddress(props: Record<string, unknown>, name: string): string {
  const street = [text(props.street), text(props.housenumber)].filter(Boolean).join(" ");
  const area = text(props.district) || text(props.locality) || text(props.city) || text(props.state);
  const city = text(props.city);
  const parts = [
    street && street !== name ? street : "",
    area && area !== name ? area : "",
    city && city !== area && city !== name ? city : "",
  ].filter(Boolean);
  return parts.join(", ");
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

/** Higher means a place a person would meet at, ahead of a street or a region. */
export function poiRank(osmKey: string, osmValue: string): number {
  if (["amenity", "shop", "leisure", "tourism", "craft", "office", "healthcare"].includes(osmKey)) return 3;
  if (osmKey === "building") return 2;
  if (osmKey === "place" && ["square", "neighbourhood", "suburb", "quarter"].includes(osmValue)) return 2;
  if (osmKey === "railway" || osmKey === "public_transport") return 1;
  if (osmKey === "highway" && ["bus_stop", "pedestrian"].includes(osmValue)) return 1;
  if (osmKey === "place" || osmKey === "boundary" || osmKey === "waterway") return 0;
  if (osmKey === "highway") return 0;
  return 1;
}

function nameScore(name: string, query: string): number {
  const left = name.toLocaleLowerCase();
  const right = query.toLocaleLowerCase();
  if (!right) return 0;
  if (left === right) return 3;
  if (left.startsWith(right)) return 2;
  if (left.includes(right)) return 1;
  return 0;
}

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radius = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function sameLocality(a: PlaceCandidate, b: PlaceCandidate): boolean {
  const parts = (address: string) => address.split(",").map((part) => foldName(part.trim())).filter((part) => part.length >= 4);
  const left = parts(a.address);
  const right = parts(b.address);
  return left.some((part) => right.includes(part));
}

function foldName(name: string): string {
  return name
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase();
}

function preferCandidate(current: PlaceCandidate, next: PlaceCandidate, bias: SearchBias): PlaceCandidate {
  const poi = poiRank(next.osmKey, next.osmValue) - poiRank(current.osmKey, current.osmValue);
  if (poi) return poi > 0 ? next : current;
  if (!bias) return current;
  return haversineMeters(bias, next) < haversineMeters(bias, current) ? next : current;
}

export function rankPlaces(candidates: PlaceCandidate[], bias: SearchBias, query: string): PlaceHit[] {
  const pool = bias
    ? candidates.filter((hit) => haversineMeters(bias, hit) <= DROP_M)
    : candidates;
  const kept: PlaceCandidate[] = [];
  for (const hit of pool) {
    const folded = foldName(hit.name);
    const idx = kept.findIndex((prev) => foldName(prev.name) === folded && (
      haversineMeters(prev, hit) <= MERGE_M || (!bias && sameLocality(prev, hit))
    ));
    if (idx === -1) kept.push(hit);
    else kept[idx] = preferCandidate(kept[idx], hit, bias);
  }
  const ranked = kept
    .map((hit) => ({ hit, distance: bias ? haversineMeters(bias, hit) : null }))
    .sort((a, b) => {
      const aNear = a.distance != null && a.distance <= NEAR_M;
      const bNear = b.distance != null && b.distance <= NEAR_M;
      if (aNear !== bNear) return aNear ? -1 : 1;
      if (aNear && bNear && a.distance != null && b.distance != null) {
        if (Math.abs(a.distance - b.distance) > 40) return a.distance - b.distance;
        const poi = poiRank(b.hit.osmKey, b.hit.osmValue) - poiRank(a.hit.osmKey, a.hit.osmValue);
        if (poi) return poi;
        return a.distance - b.distance;
      }
      const poi = poiRank(b.hit.osmKey, b.hit.osmValue) - poiRank(a.hit.osmKey, a.hit.osmValue);
      if (poi) return poi;
      const named = nameScore(b.hit.name, query) - nameScore(a.hit.name, query);
      if (named) return named;
      if (a.distance != null && b.distance != null) return a.distance - b.distance;
      return 0;
    });
  return ranked.slice(0, RESULT_CAP).map(({ hit, distance }) => ({
    name: hit.name,
    address: hit.address,
    lat: hit.lat,
    lng: hit.lng,
    distanceM: distance == null ? null : Math.round(distance),
  }));
}

function bboxAround(lat: number, lng: number, km: number): string {
  const dLat = km / 110.574;
  const dLng = km / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((n) => n.toFixed(4)).join(",");
}

function nominatimViewbox(lat: number, lng: number, km: number): string {
  const dLat = km / 110.574;
  const dLng = km / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat + dLat, lng + dLng, lat - dLat].map((n) => n.toFixed(4)).join(",");
}

function upstreamName(url: string): "photon" | "nominatim" {
  return url.includes("nominatim.openstreetmap.org") ? "nominatim" : "photon";
}

async function getJson(url: string): Promise<unknown> {
  const source = upstreamName(url);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      console.log(`geocode upstream ${source} status=${response.status}`);
      return null;
    }
    return response.json();
  } catch {
    console.log(`geocode upstream ${source} status=timeout`);
    return null;
  }
}

export async function searchPlaces(query: string, bias: SearchBias = null, fetchJson: JsonGetter = getJson): Promise<PlaceHit[]> {
  const q = query.trim().slice(0, 80);
  if (q.length < 2) return [];
  const point = bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng) ? bias : null;
  const key = `${q.toLocaleLowerCase()}|${point ? `${point.lat.toFixed(2)},${point.lng.toFixed(2)}` : "de"}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.results;
  const local = point != null;
  const paced = fetchJson === getJson;
  if (paced) await pace();
  const photonUrl = local
    ? `https://photon.komoot.io/api/?limit=15&q=${encodeURIComponent(q)}&lat=${point.lat}&lon=${point.lng}&location_bias_scale=0.6&bbox=${bboxAround(point.lat, point.lng, LOCAL_KM)}`
    : `https://photon.komoot.io/api/?limit=15&q=${encodeURIComponent(q)}&bbox=${GERMANY_BBOX}`;
  const photon = parsePhoton(await fetchJson(photonUrl).catch(() => null));
  if (paced) await pace();
  const nominatimUrl = local
    ? `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}&viewbox=${nominatimViewbox(point.lat, point.lng, LOCAL_KM)}&bounded=0`
    : `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}&countrycodes=de`;
  const nominatim = parseNominatim(await fetchJson(nominatimUrl).catch(() => null));
  const results = rankPlaces([...photon, ...nominatim], point, q);
  cache.set(key, { at: Date.now(), results });
  return results;
}

const VENUE_KEYS = new Set(["amenity", "shop", "leisure", "tourism", "craft", "office"]);

export function labelNear(lat: number, lng: number, payload: unknown): string {
  const record = payload && typeof payload === "object" ? payload as { features?: unknown; geometry?: unknown; properties?: unknown } : null;
  const feature = Array.isArray(record?.features) ? record.features[0] : record?.geometry ? payload : null;
  const row = feature && typeof feature === "object" ? feature as {
    geometry?: { coordinates?: unknown };
    properties?: Record<string, unknown>;
  } : null;
  const coords = row?.geometry?.coordinates;
  const props = row?.properties ?? {};
  if (!Array.isArray(coords) || coords.length < 2) return "";
  const hitLng = Number(coords[0]);
  const hitLat = Number(coords[1]);
  if (!Number.isFinite(hitLat) || !Number.isFinite(hitLng)) return "";
  const osmKey = text(props.osm_key);
  const osmValue = text(props.osm_value);
  const coarse = osmKey === "boundary"
    || (osmKey === "place" && ["city", "town", "state", "country", "county", "region", "municipality"].includes(osmValue));
  if (coarse) return "";
  const name = text(props.name);
  const distance = haversineMeters({ lat, lng }, { lat: hitLat, lng: hitLng });
  if (name && distance <= 30 && VENUE_KEYS.has(osmKey)) return name.slice(0, 80);
  const street = [text(props.street), text(props.housenumber)].filter(Boolean).join(" ");
  const area = text(props.district) || text(props.city) || text(props.locality);
  if (street) return (area ? `Near ${street}, ${area}` : `Near ${street}`).slice(0, 80);
  return "";
}

export function describeNearby(lat: number, lng: number, photonPayload: unknown, nominatimBody: unknown): string {
  return labelNear(lat, lng, photonPayload) || labelFromNominatim(nominatimBody);
}

function labelFromNominatim(body: unknown): string {
  const row = body && typeof body === "object" ? body as { address?: Record<string, unknown>; name?: unknown } : null;
  const address = row?.address ?? {};
  const street = [text(address.road), text(address.house_number)].filter(Boolean).join(" ");
  const area = text(address.suburb) || text(address.city_district) || text(address.city) || text(address.town);
  if (street) return (area ? `Near ${street}, ${area}` : `Near ${street}`).slice(0, 80);
  const name = text(row?.name);
  if (name && area && foldName(name) !== foldName(area)) return `Near ${name}, ${area}`.slice(0, 80);
  return name ? `Near ${name}`.slice(0, 80) : "";
}

function areaFromPhoton(payload: unknown): string {
  const record = payload && typeof payload === "object" ? payload as { features?: unknown } : null;
  const feature = Array.isArray(record?.features) ? record.features[0] : null;
  const props = feature && typeof feature === "object"
    ? (feature as { properties?: Record<string, unknown> }).properties ?? {}
    : {};
  return text(props.district) || text(props.locality) || text(props.city) || text(props.county) || "";
}

function areaFromNominatim(body: unknown): string {
  const row = body && typeof body === "object" ? body as { address?: Record<string, unknown> } : null;
  const address = row?.address ?? {};
  return text(address.suburb) || text(address.city_district) || text(address.city) || text(address.town) || text(address.county) || "";
}

export async function reverseLookup(lat: number, lng: number, fetchJson: JsonGetter = getJson): Promise<{ place: string; area: string }> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { place: "", area: "" };
  }
  const key = `rev:${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    const hit = cached.results[0];
    return { place: hit?.name ?? "", area: hit?.address ?? "" };
  }
  const paced = fetchJson === getJson;
  if (paced) await pace();
  const photon = await fetchJson(`https://photon.komoot.io/reverse?lon=${encodeURIComponent(String(lng))}&lat=${encodeURIComponent(String(lat))}`).catch(() => null);
  let nominatim: unknown = null;
  if (!labelNear(lat, lng, photon)) {
    if (paced) await pace();
    nominatim = await fetchJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lng))}`).catch(() => null);
  }
  const place = describeNearby(lat, lng, photon, nominatim);
  const area = areaFromPhoton(photon) || areaFromNominatim(nominatim);
  cache.set(key, { at: Date.now(), results: [{ name: place, address: area, lat, lng, distanceM: null }] });
  return { place, area };
}

export async function reversePlace(lat: number, lng: number, fetchJson: JsonGetter = getJson): Promise<string> {
  return (await reverseLookup(lat, lng, fetchJson)).place;
}

const MAPS_LINK_MAX = 2000;
const MAPS_REDIRECTS = 3;
const MAPS_TIMEOUT_MS = 3000;
const GOOGLE_SUFFIX = "(?:[a-z]{2,3}|(?:com|co|org|net|ac|gov|ne)\\.[a-z]{2})";

type RedirectResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body?: { cancel?: () => Promise<void> } | null;
};

export function isMapsLinkInput(value: string): boolean {
  return allowedMapsUrl(value.trim()) != null;
}

/** A Google Maps URL reduced to a pin, or to the place text in /maps/place/. */
export function parseMapsLink(value: string): { lat: number; lng: number; name: string } | { query: string } | null {
  const url = allowedMapsUrl(value.trim());
  if (!url) return null;
  const name = placeText(url);
  const point = mapsPoint(url);
  if (point) return { ...point, name: shortPlaceName(name) };
  if (name) return { query: name.slice(0, 80) };
  return null;
}

export async function resolveMapsLink(
  input: string,
  fetchJson: JsonGetter = getJson,
  fetchImpl: (url: string, init?: RequestInit) => Promise<RedirectResponse> = fetch,
): Promise<PlaceHit[]> {
  const raw = input.trim();
  if (!raw || raw.length > MAPS_LINK_MAX || !isMapsLinkInput(raw)) return [];
  const resolved = await followMaps(raw, fetchImpl);
  if (!resolved) return [];
  const key = `maps:${resolved}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.results;
  const parsed = parseMapsLink(resolved);
  let results: PlaceHit[] = [];
  if (parsed && "lat" in parsed) {
    const name = parsed.name || (await reverseLookup(parsed.lat, parsed.lng, fetchJson)).place || `${parsed.lat}, ${parsed.lng}`;
    results = [{ name: name.slice(0, 80), address: "", lat: parsed.lat, lng: parsed.lng, distanceM: null }];
  } else if (parsed && parsed.query) {
    results = await searchPlaces(parsed.query, null, fetchJson);
  }
  cache.set(key, { at: Date.now(), results });
  return results;
}

function shortPlaceName(text: string): string {
  const name = text.split(",")[0]?.trim() || "";
  return name.slice(0, 80);
}

function placeText(url: URL): string {
  const parts = url.pathname.split("/");
  const idx = parts.findIndex((part) => part === "place");
  if (idx < 0 || !parts[idx + 1]) return "";
  try {
    return decodeURIComponent(parts[idx + 1].replace(/\+/g, " ")).replace(/\s+/g, " ").trim();
  } catch {
    return parts[idx + 1].replace(/\+/g, " ").replace(/\s+/g, " ").trim();
  }
}

function mapsPoint(url: URL): { lat: number; lng: number } | null {
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(url.href);
  if (pin) {
    const point = coordPair(pin[1], pin[2]);
    if (point) return point;
  }
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url.href);
  if (at) {
    const point = coordPair(at[1], at[2]);
    if (point) return point;
  }
  for (const key of ["q", "query", "ll"]) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
    if (!match) continue;
    const point = coordPair(match[1], match[2]);
    if (point) return point;
  }
  return null;
}

function coordPair(latText: string, lngText: string): { lat: number; lng: number } | null {
  const lat = Number(latText);
  const lng = Number(lngText);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function allowedMapsUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const path = url.pathname;
  if (host === "maps.app.goo.gl") return url;
  const mapsPath = path === "/maps" || path.startsWith("/maps/");
  if (!mapsPath) return null;
  if (host === "goo.gl") return url;
  if (new RegExp(`^www\\.google\\.${GOOGLE_SUFFIX}$`).test(host)) return url;
  if (new RegExp(`^maps\\.google\\.${GOOGLE_SUFFIX}$`).test(host)) return url;
  return null;
}

async function followMaps(
  start: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<RedirectResponse>,
): Promise<string | null> {
  let current = start;
  for (let followed = 0; followed <= MAPS_REDIRECTS; followed += 1) {
    if (!allowedMapsUrl(current)) return null;
    if (followed === MAPS_REDIRECTS) return current;
    let response: RedirectResponse;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(MAPS_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    await response.body?.cancel?.().catch(() => {});
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    return current;
  }
  return allowedMapsUrl(current) ? current : null;
}
