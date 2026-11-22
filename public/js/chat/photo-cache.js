import { signal } from "@preact/signals";
import { state } from "../state.js";

/**
 * Chat photos need the Bearer token, so <img src> cannot fetch them. Each message gets one signal:
 * undefined while loading, a blob URL when ready, null when the server has no picture for it.
 */
const photos = new Map();

/** The signal for a photo message. The first call starts the fetch; later calls reuse it. */
export function chatPhotoSignal(id) {
  let sig = photos.get(id);
  if (!sig) {
    sig = signal(undefined);
    photos.set(id, sig);
    void fetchPhoto(id, sig);
  }
  return sig;
}

async function fetchPhoto(id, sig) {
  try {
    const response = await fetch(`/api/messages/${encodeURIComponent(id)}/photo`, {
      headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
    });
    const blob = response.ok ? await response.blob() : null;
    sig.value = blob && blob.size ? URL.createObjectURL(blob) : null;
  } catch {
    // Offline: forget it, so the next paint of the thread asks again.
    if (photos.get(id) === sig) photos.delete(id);
  }
}

/** Gives every blob URL back. Called when the chat screen is dropped and on sign-out. */
export function forgetChatPhotos() {
  for (const sig of photos.values()) if (typeof sig.peek() === "string") URL.revokeObjectURL(sig.peek());
  photos.clear();
}
