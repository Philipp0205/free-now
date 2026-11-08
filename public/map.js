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
  /** Photo URLs that did not decode. Those pins keep their initials on every repaint. */
  const brokenPhotos = new Set();

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

  function node(tag, cls, text) {
    const item = document.createElement(tag);
    item.className = cls;
    if (text) item.textContent = text;
    return item;
  }

  /** Initials stay underneath. A photo that fails to load is removed and the initials show. */
  function face(cls, person) {
    const item = node("span", cls, person.initial || "");
    item.style.setProperty("--person", person.color || "");
    if (person.id) item.dataset.person = person.id;
    if (person.photo && !brokenPhotos.has(person.photo)) {
      const img = node("img", "pin-photo");
      img.alt = "";
      img.addEventListener("error", () => {
        brokenPhotos.add(person.photo);
        img.remove();
      }, { once: true });
      img.src = person.photo;
      item.append(img);
    }
    return item;
  }

  /**
   * One marker per pin. The tap target is still the 36px circle. The crowd and the day
   * label hang outside it and let taps through, so they never cover another pin.
   */
  function pinIcon(L, pin) {
    const wrap = node("span", "pin-body");
    wrap.append(face("pin-letter", { id: pin.personId, initial: pin.initial, color: pin.color, photo: pin.photo }));
    if (pin.faces?.length || pin.more) {
      const crowd = node("span", "pin-crowd");
      for (const person of pin.faces || []) crowd.append(face("pin-face", person));
      if (pin.more) crowd.append(node("span", "pin-more", `+${pin.more}`));
      wrap.append(crowd);
    }
    if (pin.label) wrap.append(node("span", "pin-when", pin.label));
    const classes = ["pin", `pin-${pin.kind}`];
    if (pin.now) classes.push("pin-now");
    return L.divIcon({
      className: classes.join(" "),
      html: wrap,
      iconSize: [PIN_PX, PIN_PX],
      iconAnchor: [PIN_PX / 2, PIN_PX / 2],
    });
  }

  function pinSig(pin) {
    const faces = (pin.faces || []).map((person) => `${person.id}:${person.initial}:${person.color}:${person.photo || ""}`).join("|");
    return `${pin.lat},${pin.lng},${pin.initial},${pin.kind},${pin.color},${pin.photo || ""},${pin.now ? 1 : 0},${pin.label || ""},${faces},${pin.more || 0}`;
  }

  /** Live buzzers stay above everything else on the map. */
  function pinZ(pin) {
    return pin.now ? 10000 : 0;
  }

  function syncMapMarkers(L, pins) {
    const next = new Set();
    for (const pin of pins) {
      const key = pinKey(pin);
      next.add(key);
      const sig = pinSig(pin);
      const existing = liveMarkers.get(key);
      if (existing) {
        if (existing.sig !== sig) {
          existing.marker.setLatLng([pin.lat, pin.lng]);
          existing.marker.setIcon(pinIcon(L, pin));
          existing.marker.setZIndexOffset(pinZ(pin));
          existing.sig = sig;
        }
        existing.marker.off("click");
        existing.marker.on("click", () => showMapCard(pin));
        continue;
      }
      const marker = L.marker([pin.lat, pin.lng], { icon: pinIcon(L, pin), zIndexOffset: pinZ(pin) });
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

  /** Repaint pins only (a buzzer that just started, a photo that just loaded). The open card is left alone. */
  function refreshPins() {
    if (!liveMap || !window.L || state.tab !== "map") return;
    const container = liveMap.getContainer();
    if (!container || !container.isConnected) return;
    const pins = collectPins();
    if (!pins.length) return;
    syncMapMarkers(window.L, pins);
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

  return { mountMap, mountWhereMap, destroyLiveMap, destroyWhereMap, refreshPins };
}
