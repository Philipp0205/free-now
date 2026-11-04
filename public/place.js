/**
 * Pure place and distance helpers. The page passes the spot and the coordinates;
 * this file does not touch app state, so the wording can be tested.
 */

export function audiencePlace(place) {
  const spot = typeof place === "string" ? place.trim() : "";
  return /^near you$/i.test(spot) ? "nearby" : spot;
}

export function haversine(a, b) {
  const radius = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(meters) {
  const rounded = Math.max(10, Math.round(meters / 10) * 10);
  if (rounded < 1000) return `${rounded} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}
