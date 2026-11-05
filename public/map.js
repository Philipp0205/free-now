/**
 * Leaflet mount, pin markers, recentering, and the where-picker map.
 * The page keeps state and the screens and passes them in.
 * The functions are the ones that lived in app.js; the rules are unchanged.
 */

export function bindMap({
  state,
  whereTarget,
  collectPins,
  mapCard,
  paintSummary,
  scheduleReverse,
  recentPlace,
  FINDING_PLACE,
}) {
  let leafletPromise = null;
  let liveMap = null;
  let liveMapTimer = 0;
  let liveMarkers = new Map();
  let openMapPin = null;
  let whereLeaflet = null;
  let whereMapTimer = 0;
  const TILE_MAX_ZOOM = 19;
  const PIN_PX = 36;

  function rememberMapCenter(map) {
    const center = map.getCenter();
    if (!center) return;
    state.mapCenter = { lat: center.lat, lng: center.lng };
  }

  function bag() {
    return whereTarget ? whereTarget() : state;
  }

  function pickerSheet() {
    return state.sheet === "free" || state.sheet === "plan" || state.sheet === "admin-edit";
  }

  function pickerFocus() {
    const where = bag().where;
    if (where?.lat != null && where?.lng != null) {
      return { lat: where.lat, lng: where.lng, zoom: 15 };
    }
    if (state.viewerLocation) return { lat: state.viewerLocation.lat, lng: state.viewerLocation.lng, zoom: 15 };
    const recent = recentPlace();
    if (recent) return { lat: recent.lat, lng: recent.lng, zoom: 15 };
    return { lat: 51.1657, lng: 10.4515, zoom: 6 };
  }

  function addMapTiles(L, map) {
    const tileUrl = state.meta?.mapTileUrl
      || "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
    const tileAttribution = state.meta?.mapTileAttribution
      || "Powered by Esri | © Esri, HERE, Garmin, USGS, OpenStreetMap contributors";
    L.tileLayer(tileUrl, {
      attribution: tileAttribution,
      subdomains: tileUrl.includes("{s}") ? "abcd" : "abc",
      detectRetina: tileUrl.includes("{r}"),
      maxZoom: TILE_MAX_ZOOM,
      maxNativeZoom: TILE_MAX_ZOOM,
    }).addTo(map);
  }

  function destroyLiveMap() {
    clearTimeout(liveMapTimer);
    liveMapTimer = 0;
    if (liveMap) liveMap.remove();
    liveMap = null;
    liveMarkers = new Map();
    openMapPin = null;
  }

  function destroyWhereMap() {
    clearTimeout(whereMapTimer);
    whereMapTimer = 0;
    if (!whereLeaflet) return;
    whereLeaflet.remove();
    whereLeaflet = null;
  }

  function scheduleInvalidate(map, stillCurrent) {
    return setTimeout(() => {
      if (!stillCurrent()) return;
      const container = map.getContainer();
      if (!container || !container.isConnected) return;
      map.invalidateSize();
    }, 60);
  }

  function pinKey(pin) {
    return `${pin.kind}:${pin.id}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function pinIcon(L, pin) {
    return L.divIcon({
      className: `pin pin-${pin.kind}`,
      html: `<span class="pin-letter" style="--person:${escapeHtml(pin.color || "")}">${escapeHtml(pin.initial || "")}</span>`,
      iconSize: [PIN_PX, PIN_PX],
      iconAnchor: [PIN_PX / 2, PIN_PX / 2],
    });
  }

  function syncMapMarkers(L, pins) {
    const next = new Set();
    for (const pin of pins) {
      const key = pinKey(pin);
      next.add(key);
      const sig = `${pin.lat},${pin.lng},${pin.initial},${pin.kind},${pin.color}`;
      const existing = liveMarkers.get(key);
      if (existing) {
        if (existing.sig !== sig) {
          existing.marker.setLatLng([pin.lat, pin.lng]);
          existing.marker.setIcon(pinIcon(L, pin));
          existing.sig = sig;
        }
        existing.marker.off("click");
        existing.marker.on("click", () => showMapCard(pin));
        continue;
      }
      const marker = L.marker([pin.lat, pin.lng], { icon: pinIcon(L, pin) });
      marker.on("click", () => showMapCard(pin));
      marker.addTo(liveMap);
      liveMarkers.set(key, { marker, sig });
    }
    for (const [key, entry] of liveMarkers) {
      if (next.has(key)) continue;
      entry.marker.remove();
      liveMarkers.delete(key);
      if (openMapPin === key) {
        openMapPin = null;
        document.getElementById("map-card-host")?.replaceChildren();
      }
    }
  }

  function refreshOpenCard(pins) {
    if (!openMapPin) return;
    const pin = pins.find((item) => pinKey(item) === openMapPin);
    if (!pin) {
      openMapPin = null;
      document.getElementById("map-card-host")?.replaceChildren();
      return;
    }
    showMapCard(pin);
  }

  async function mountWhereMap() {
    const host = document.getElementById("where-map");
    if (!host || !bag().whereMap || !pickerSheet()) return;
    const L = await loadLeaflet();
    if (!host.isConnected || !bag().whereMap || !pickerSheet()) return;
    destroyWhereMap();
    const focus = pickerFocus();
    const map = L.map(host, { zoomControl: false, maxZoom: TILE_MAX_ZOOM });
    map.setView([focus.lat, focus.lng], Math.min(focus.zoom, TILE_MAX_ZOOM));
    addMapTiles(L, map);
    map.on("dragend", () => rememberMapCenter(map));
    const marker = L.marker([focus.lat, focus.lng], {
      draggable: true,
      icon: L.divIcon({
        className: "pin pin-social",
        html: `<span class="pin-letter"></span>`,
        iconSize: [PIN_PX, PIN_PX],
        iconAnchor: [PIN_PX / 2, PIN_PX / 2],
      }),
    }).addTo(map);
    const apply = (ll) => {
      const where = bag();
      where.whereAutofill = false;
      where.where.mode = "place";
      where.where.lat = ll.lat;
      where.where.lng = ll.lng;
      where.where.precise = true;
      where.where.place = FINDING_PLACE;
      where.whereQuery = FINDING_PLACE;
      const label = document.querySelector(".where-v");
      if (label) {
        label.textContent = FINDING_PLACE;
        label.classList.remove("is-placeholder");
      }
      document.querySelector(".where-field")?.classList.add("has-value");
      const query = document.getElementById("where-query");
      if (query) query.value = FINDING_PLACE;
      paintSummary();
      scheduleReverse(ll.lat, ll.lng, true);
    };
    marker.on("dragend", () => apply(marker.getLatLng()));
    map.on("click", (event) => {
      marker.setLatLng(event.latlng);
      apply(event.latlng);
    });
    whereLeaflet = map;
    whereMapTimer = scheduleInvalidate(map, () => whereLeaflet === map);
  }

  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      if (!document.querySelector("link[data-leaflet]")) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/vendor/leaflet/leaflet.css";
        link.dataset.leaflet = "1";
        document.head.append(link);
      }
      const script = document.createElement("script");
      script.src = "/vendor/leaflet/leaflet.js";
      script.onload = () => resolve(window.L);
      script.onerror = () => reject(new Error("map failed to load"));
      document.body.append(script);
    });
    return leafletPromise;
  }

  async function mountMap() {
    const host = document.getElementById("hangry-map");
    if (!host || state.tab !== "map") return;
    const L = await loadLeaflet();
    if (!host.isConnected || state.tab !== "map") return;
    const pins = collectPins();
    if (!pins.length) {
      destroyLiveMap();
      return;
    }
    if (liveMap && liveMap.getContainer() === host) {
      syncMapMarkers(L, pins);
      liveMap.invalidateSize();
      const focus = takeFocusPin(pins);
      if (focus) focusMapPin(liveMap, focus);
      else refreshOpenCard(pins);
      reserveAttribution();
      return;
    }
    if (liveMap) destroyLiveMap();
    const map = L.map(host, { zoomControl: false, maxZoom: TILE_MAX_ZOOM });
    L.control.zoom({ position: "topright" }).addTo(map);
    addMapTiles(L, map);
    liveMap = map;
    watchAttribution(map);
    syncMapMarkers(L, pins);
    const focus = takeFocusPin(pins);
    if (focus) focusMapPin(map, focus);
    else map.fitBounds(pins.map((pin) => [pin.lat, pin.lng]), { padding: [48, 48], maxZoom: 15 });
    rememberMapCenter(map);
    map.on("dragend", () => rememberMapCenter(map));
    liveMapTimer = scheduleInvalidate(map, () => liveMap === map);
  }

  function watchAttribution(map) {
    const attr = map.getContainer()?.querySelector(".leaflet-control-attribution");
    if (!attr || attr.dataset.watched) {
      reserveAttribution();
      return;
    }
    attr.dataset.watched = "1";
    if (window.ResizeObserver) new ResizeObserver(() => reserveAttribution()).observe(attr);
    reserveAttribution();
  }

  /** Keep the pin card above the attribution plate, which wraps on a narrow phone. */
  function reserveAttribution() {
    const mapEl = document.getElementById("hangry-map");
    const attr = mapEl?.querySelector(".leaflet-control-attribution");
    const wrap = document.querySelector(".map-wrap");
    if (!mapEl || !attr || !wrap) return;
    const gap = Math.ceil(mapEl.getBoundingClientRect().bottom - attr.getBoundingClientRect().top) + 8;
    if (gap < 16) return;
    wrap.style.setProperty("--attr-h", `${gap}px`);
  }

  function takeFocusPin(pins) {
    if (!state.focusPin) return null;
    const focus = pins.find((pin) => pinKey(pin) === state.focusPin);
    if (focus) state.focusPin = "";
    return focus || null;
  }

  function focusMapPin(map, pin) {
    map.invalidateSize();
    map.setView([pin.lat, pin.lng], 16, { animate: false });
    showMapCard(pin);
    const card = document.querySelector(".map-card");
    const lift = Math.round((card?.getBoundingClientRect().height ?? 180) / 2 + 16);
    map.panBy([0, lift], { animate: false });
  }

  function showMapCard(pin) {
    openMapPin = pinKey(pin);
    const host = document.getElementById("map-card-host");
    if (!host) return;
    host.replaceChildren(mapCard(pin));
    reserveAttribution();
  }

  return { mountMap, mountWhereMap, destroyLiveMap, destroyWhereMap };
}
