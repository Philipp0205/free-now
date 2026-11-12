import type { AuthedRouteContext } from "../lib/context.js";
import { HttpError, sendJson } from "../lib/http.js";
import { isMapsLinkInput, looksLikeUrl, resolveMapsLink, reverseLookup, searchPlaces } from "./geocode.js";
import { type PmtilesInfo, createArchiveCheck } from "./pmtiles.js";

export async function handleMapRoutes(ctx: AuthedRouteContext): Promise<boolean> {
  const { res, url, method, pathname } = ctx;
  if (method === "GET" && pathname === "/api/geocode") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    const lat = Number(url.searchParams.get("lat"));
    const lng = Number(url.searchParams.get("lng"));
    if (q) {
      if (isMapsLinkInput(q)) {
        if (q.length > 2000) throw new HttpError(400, "query is too long");
        sendJson(res, 200, { results: await resolveMapsLink(q) });
        return true;
      }
      if (looksLikeUrl(q)) {
        sendJson(res, 200, { results: [] });
        return true;
      }
      if (q.length > 80) throw new HttpError(400, "query is too long");
      const bias = url.searchParams.has("lat") && url.searchParams.has("lng")
        && Number.isFinite(lat) && Number.isFinite(lng)
        ? { lat, lng }
        : null;
      sendJson(res, 200, { results: await searchPlaces(q, bias) });
      return true;
    }
    if (url.searchParams.has("lat") || url.searchParams.has("lng")) {
      sendJson(res, 200, await reverseLookup(lat, lng));
      return true;
    }
    throw new HttpError(400, "query is required");
  }
  return false;
}

const archiveChecks = new WeakMap<PmtilesInfo, ReturnType<typeof createArchiveCheck>>();

/** One cached check per configured archive, so the header is re-read only after the file changed. */
export function archiveCheckFor(info: PmtilesInfo): ReturnType<typeof createArchiveCheck> {
  let check = archiveChecks.get(info);
  if (!check) {
    check = createArchiveCheck(info);
    archiveChecks.set(info, check);
  }
  return check;
}
