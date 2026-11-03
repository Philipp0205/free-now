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
    const idx = kept.findIndex((prev) => foldName(prev.name) === folded && haversineMeters(prev, hit) <= MERGE_M);
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

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) return null;
  return response.json();
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

export async function reversePlace(lat: number, lng: number): Promise<string> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return "";
  const key = `rev:${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.results[0]?.name ?? "";
  await pace();
  const photon = parsePhoton(await getJson(`https://photon.komoot.io/reverse?lon=${encodeURIComponent(String(lng))}&lat=${encodeURIComponent(String(lat))}`).catch(() => null));
  let name = photon[0]?.name ?? "";
  if (!name) {
    const body = await getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lng))}`).catch(() => null);
    const display = body && typeof body === "object" ? (body as { display_name?: unknown }).display_name : "";
    name = String(display ?? "").split(",").slice(0, 2).join(",").trim().slice(0, 80);
  }
  cache.set(key, { at: Date.now(), results: name ? [{ name, address: "", lat, lng, distanceM: null }] : [] });
  return name;
}
