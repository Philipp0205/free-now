import type { Config } from "../config.js";

/** The HTTP client for Giphy. Tests pass a stub, so nothing here needs the network. */
export type GiphyFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** What the picker and a sent message carry. Never the key, never Giphy's query strings. */
export type Gif = { id: string; title: string; width: number; height: number; url: string };
export type GifResult = Gif & { preview: string };

export const GIPHY_API = "https://api.giphy.com/v1/gifs";
export const GIPHY_LIMIT = 24;
export const GIPHY_TIMEOUT_MS = 5_000;
export const GIPHY_QUERY_MAX = 50;
export const GIPHY_UNAVAILABLE = "GIFs are unavailable right now.";

const ID = /^[A-Za-z0-9_-]{1,40}$/;
/** media.giphy.com, media0 to media9 and so on, and i.giphy.com. Nothing else is ever stored or shown. */
const MEDIA_HOST = /^(?:media\d*|i)\.giphy\.com$/;
const URL_MAX = 300;
const TITLE_MAX = 120;
const SIDE_MAX = 4000;

export class GiphyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** An https Giphy media URL, rebuilt without credentials, port, query or hash. Null for anything else. */
export function cleanGifUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!MEDIA_HOST.test(url.hostname)) return null;
  if (url.pathname.length < 2 || /[\s"'<>\\]/.test(url.pathname)) return null;
  return `https://${url.hostname}${url.pathname}`;
}

function side(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= SIDE_MAX ? n : null;
}

function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
}

/** One GIF as stored in a message: id, title, size and one Giphy URL. Null if any part is not acceptable. */
export function cleanGif(raw: unknown): Gif | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const id = typeof input.id === "string" && ID.test(input.id) ? input.id : null;
  const url = cleanGifUrl(input.url);
  const width = side(input.width);
  const height = side(input.height);
  if (!id || !url || !width || !height) return null;
  return { id, title: cleanTitle(input.title), width, height, url };
}

/** The stored message body, read back. Anything that no longer passes is null, so it renders as plain "GIF". */
export function readGifBody(body: string): Gif | null {
  try {
    return cleanGif(JSON.parse(body));
  } catch {
    return null;
  }
}

export function gifBody(gif: Gif): string {
  return JSON.stringify({ id: gif.id, title: gif.title, width: gif.width, height: gif.height, url: gif.url });
}

/** A search phrase: control characters out, spaces collapsed, at most 50 characters. Empty when nothing is left. */
export function cleanQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, GIPHY_QUERY_MAX).join("").trim();
}

type Variant = { url?: unknown; width?: unknown; height?: unknown };

function pick(images: Record<string, Variant>, names: string[]): { url: string; width: number; height: number } | null {
  for (const name of names) {
    const found = images[name];
    if (!found || typeof found !== "object") continue;
    const url = cleanGifUrl(found.url);
    const width = side(found.width);
    const height = side(found.height);
    if (url && width && height) return { url, width, height };
  }
  return null;
}

function toResult(raw: unknown): GifResult | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as { id?: unknown; title?: unknown; images?: unknown };
  if (typeof item.id !== "string" || !ID.test(item.id)) return null;
  if (!item.images || typeof item.images !== "object") return null;
  const images = item.images as Record<string, Variant>;
  const send = pick(images, ["fixed_width", "downsized", "original"]);
  const preview = pick(images, ["fixed_width_small", "fixed_width"]);
  if (!send || !preview) return null;
  return { id: item.id, title: cleanTitle(item.title), width: send.width, height: send.height, url: send.url, preview: preview.url };
}

/** Trending, or a search when `query` is set. The key and rating are added here and go no further than Giphy. */
export async function listGifs(
  config: Pick<Config, "giphyApiKey" | "giphyRating">,
  fetcher: GiphyFetch,
  query: string | null,
): Promise<GifResult[]> {
  if (!config.giphyApiKey) throw new GiphyError(404, "not found");
  const params = new URLSearchParams({
    api_key: config.giphyApiKey,
    rating: config.giphyRating,
    limit: String(GIPHY_LIMIT),
  });
  if (query != null) params.set("q", query);
  const url = `${GIPHY_API}/${query != null ? "search" : "trending"}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GIPHY_TIMEOUT_MS);
  try {
    const res = await fetcher(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new GiphyError(502, GIPHY_UNAVAILABLE);
    const data = (await res.json()) as { data?: unknown };
    if (!data || !Array.isArray(data.data)) throw new GiphyError(502, GIPHY_UNAVAILABLE);
    const out: GifResult[] = [];
    for (const entry of data.data) {
      const gif = toResult(entry);
      if (gif) out.push(gif);
      if (out.length >= GIPHY_LIMIT) break;
    }
    return out;
  } catch (error) {
    if (error instanceof GiphyError) throw error;
    // The error text can carry the request URL, and the URL carries the key. Only the name is logged.
    console.error("giphy request failed", error instanceof Error ? error.name : "error");
    throw new GiphyError(502, GIPHY_UNAVAILABLE);
  } finally {
    clearTimeout(timer);
  }
}

/** Real fetch, narrowed to what listGifs uses. */
export const realGiphyFetch: GiphyFetch = (url, init) => fetch(url, init);
