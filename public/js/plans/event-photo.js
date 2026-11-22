import { state } from "../state.js";
import { PHOTO_COPY } from "./event-photo-copy.js";
import { releaseDraft } from "./event-photo-draft.js";

/** Blob URLs for event photos, by `${kind}:${id}:${rev}`. A string is ready, a Promise is loading, null failed. */
export const photoUrls = new Map();

/** The cache key for an event's photo, or "" when it has none. kind is "social" or "plan". */
export function photoKey(kind, item) {
  return item?.id && item.photoRev ? `${kind}:${item.id}:${item.photoRev}` : "";
}

function photoPath(kind, id) {
  return `/api/${kind}s/${encodeURIComponent(id)}/photo`;
}

/** Photos need the Bearer token, so <img src> cannot fetch them. Fetch once per revision, keep a blob URL. */
export function loadEventPhoto(kind, item) {
  const key = photoKey(kind, item);
  if (!key) return Promise.resolve(null);
  if (photoUrls.has(key)) return photoUrls.get(key);
  const token = state.token;
  const job = fetch(`${photoPath(kind, item.id)}?v=${encodeURIComponent(item.photoRev)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
    .then((response) => (response.ok ? response.blob() : null))
    .then((blob) => {
      const url = blob && blob.size ? URL.createObjectURL(blob) : null;
      photoUrls.set(key, url);
      return url;
    })
    .catch(() => {
      // Offline: forget the failure so the next render tries again.
      photoUrls.delete(key);
      return null;
    });
  photoUrls.set(key, job);
  return job;
}

/** Sign-out: give every blob URL back. */
export function forgetEventPhotos() {
  for (const value of photoUrls.values()) if (typeof value === "string") URL.revokeObjectURL(value);
  photoUrls.clear();
}

async function sendRequest(kind, id, method, blob) {
  const headers = { authorization: `Bearer ${state.token}` };
  if (blob) headers["content-type"] = blob.type;
  const response = await fetch(photoPath(kind, id), { method, headers, body: blob || undefined });
  if (!response.ok) throw new Error(`photo ${method} ${response.status}`);
  return response.json().catch(() => ({}));
}

/** Uploads the staged photo or removes the current one, as the draft says. Returns "" or a message to show. */
export async function savePhotoDraft(kind, id, draft) {
  if (!id) return "";
  try {
    if (draft.blob) {
      const { photoRev } = await sendRequest(kind, id, "PUT", draft.blob);
      // The bytes we just sent are the photo. No need to fetch them back.
      if (photoRev) photoUrls.set(`${kind}:${id}:${photoRev}`, URL.createObjectURL(draft.blob));
    } else if (draft.remove) {
      await sendRequest(kind, id, "DELETE", null);
    }
  } catch {
    return draft.blob ? PHOTO_COPY.uploadFailed : PHOTO_COPY.removeFailed;
  } finally {
    releaseDraft(draft);
    draft.remove = false;
  }
  return "";
}
