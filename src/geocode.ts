export type PlaceHit = { name: string; lat: number; lng: number };

const USER_AGENT = "Hangry/1.0 (+https://github.com/Philipp0205/free-now)";
const CACHE_MS = 10 * 60 * 1000;
const PACE_MS = 1100;

const cache = new Map<string, { at: number; results: PlaceHit[] }>();
let chain: Promise<void> = Promise.resolve();
let nextAt = 0;

function pace(): Promise<void> {
  const job = chain.then(async () => {
    const wait = Math.max(0, nextAt - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    nextAt = Date.now() + PACE_MS;
  });
  chain = job.then(() => {}, () => {});
  return job;
}

export function parsePhoton(payload: unknown): PlaceHit[] {
  const record = payload && typeof payload === "object" ? payload as { features?: unknown; geometry?: unknown } : null;
  const features = Array.isArray(record?.features)
    ? record.features
    : record?.geometry
      ? [payload]
      : [];
  const hits: PlaceHit[] = [];
  for (const feature of features) {
    const row = feature && typeof feature === "object" ? feature as {
      geometry?: { coordinates?: unknown };
      properties?: Record<string, unknown>;
    } : null;
    const coords = row?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    const name = photonLabel(row?.properties ?? {}).slice(0, 80);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    hits.push({ name, lat, lng });
    if (hits.length === 5) break;
  }
  return hits;
}

export function parseNominatim(payload: unknown): PlaceHit[] {
  if (!Array.isArray(payload)) return [];
  const hits: PlaceHit[] = [];
  for (const row of payload) {
    const item = row && typeof row === "object" ? row as { lat?: unknown; lon?: unknown; display_name?: unknown } : null;
    const lat = Number(item?.lat);
    const lng = Number(item?.lon);
    const name = String(item?.display_name ?? "").split(",").slice(0, 3).join(",").trim().slice(0, 80);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    hits.push({ name, lat, lng });
    if (hits.length === 5) break;
  }
  return hits;
}

function photonLabel(props: Record<string, unknown>): string {
  const name = text(props.name);
  const street = text(props.street);
  const city = text(props.city) || text(props.state);
  const parts = [name, street && street !== name ? street : "", city].filter(Boolean);
  return parts.join(", ") || text(props.country);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) return null;
  return response.json();
}

export async function searchPlaces(query: string): Promise<PlaceHit[]> {
  const q = query.trim().slice(0, 80);
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.results;
  await pace();
  const photon = parsePhoton(await getJson(`https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(q)}`).catch(() => null));
  const results = photon.length
    ? photon
    : parseNominatim(await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`).catch(() => null));
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
  cache.set(key, { at: Date.now(), results: name ? [{ name, lat, lng }] : [] });
  return name;
}
