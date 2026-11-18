import type { AuthedRouteContext } from "../lib/context.js";
import { HttpError, sendJson } from "../lib/http.js";
import { cleanQuery, GiphyError, listGifs, realGiphyFetch } from "./giphy.js";

/** Per person. The picker types a search at a time, so this is roomy for people and tight for a script. */
export const GIPHY_LIMIT_PER_MIN = { limit: 60, windowMs: 60_000 };

/**
 * GET /api/giphy/trending and GET /api/giphy/search?q=. The server holds the Giphy key and the rating,
 * so the browser never sees either. With no GIPHY_API_KEY these paths are not there at all (404).
 */
export async function handleGiphyRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { res, deps, limits, method, pathname, url, me } = ctx;
  if (method !== "GET" || (pathname !== "/api/giphy/trending" && pathname !== "/api/giphy/search")) return false;
  if (!deps.config.giphyApiKey) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  if (!limits.giphy.hit(me.id, deps.now())) throw new HttpError(429, "too many requests");
  let query: string | null = null;
  if (pathname === "/api/giphy/search") {
    query = cleanQuery(url.searchParams.get("q"));
    if (!query) throw new HttpError(400, "Type something to search for.");
  }
  try {
    const gifs = await listGifs(deps.config, deps.giphyFetch ?? realGiphyFetch, query);
    sendJson(res, 200, { gifs });
  } catch (error) {
    if (error instanceof GiphyError) throw new HttpError(error.status, error.message);
    throw error;
  }
  return true;
}
