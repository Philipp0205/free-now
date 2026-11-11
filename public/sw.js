const CACHE = "hangry-v87";
/** Wait before each ack retry. One first try, then up to three more. */
const ACK_DELAYS = [1000, 3000, 9000];
const SHELL = ["/", "/styles.css", "/app.js", "/keyboard.js", "/install-guide.js", "/when.js", "/place.js", "/push-sheet.js", "/whats-new.js", "/card-grad.js", "/calendar-feed.js", "/calendar-month.js", "/freebusy.js", "/status.js", "/mentions.js", "/whats-new.json", "/map.js", "/map-pin.js", "/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css", "/vendor/protomaps-leaflet/protomaps-leaflet.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-192.png", "/icons/icon-maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") return;
  // Calendar feeds carry a private token and plan details: never cache them.
  if (url.pathname.startsWith("/cal/")) return;
  // Search Console checks this file and the privacy page: a failed fetch must never answer with the app shell.
  if (url.pathname === "/googlee48df27048aaa965.html" || url.pathname === "/privacy" || url.pathname === "/privacy/") return;
  // Basemap archives are read in byte ranges: never cache them (a 206 cannot go in the Cache API).
  if (url.pathname.startsWith("/tiles/") || event.request.headers.has("range")) return;
  // Share pages carry a plan title: never keep them, fall back to the app shell offline.
  if (url.pathname.startsWith("/p/")) {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))),
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Hangry", body: "Someone is free", url: "/", tag: "hangry", id: "" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* keep the fallback copy */
  }
  // Ack only a notification that was actually shown. A rejected show sends nothing.
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: data.tag,
      data: { url: data.url || "/" },
    }).then(() => ackPush(data.id)),
  );
});

function ackPush(id) {
  if (!id) return Promise.resolve("skipped");
  const send = () => fetch("/api/push/ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return retryAck(send, (ms) => new Promise((resolve) => setTimeout(resolve, ms)), ACK_DELAYS);
}

/**
 * Retry on a network error or a 5xx, never on a 4xx. Never rejects.
 * Resolves "ok", "rejected" (4xx), or "gave_up" after the last delay.
 */
async function retryAck(send, wait, delays) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await send();
      if (response.status < 400) return "ok";
      if (response.status < 500) return "rejected";
    } catch {
      /* offline or dropped. Try again. */
    }
    if (attempt >= delays.length) return "gave_up";
    await wait(delays[attempt]);
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          if ("navigate" in client) client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
