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
  keepCardOnMapTap = () => false,
  FINDING_PLACE,
}) {
  let leafletPromise = null;
  let vectorPromise = null;
  /** The archive once its header is read. Kept for the page, so a new map draws vector at once. */
  let vectorReady = null;
  /** The archive head (header and directories) read ahead in one request: { url, data, etag } or null. */
  let headPromise = null;
  let warmed = false;
  /** Once the archive fails (gone, cut short, unreachable) every map on this page stays raster. */
  let vectorBroken = false;
  const brokenListeners = new Set();
  let liveMap = null;
  let liveMapTimer = 0;
  let liveMarkers = new Map();
  let openMapPin = null;
  let whereLeaflet = null;
  let whereMapTimer = 0;
  const TILE_MAX_ZOOM = 19;
  const PIN_PX = 36;
  const PMTILES_ATTRIBUTION =
    '<a href="https://protomaps.com">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
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

  function rasterLayer(L) {
    const tileUrl = state.meta?.mapTileUrl
      || "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
    const tileAttribution = state.meta?.mapTileAttribution
      || "Powered by Esri | © Esri, HERE, Garmin, USGS, OpenStreetMap contributors";
    return L.tileLayer(tileUrl, {
      attribution: tileAttribution,
      subdomains: tileUrl.includes("{s}") ? "abcd" : "abc",
      detectRetina: tileUrl.includes("{r}"),
      maxZoom: TILE_MAX_ZOOM,
      maxNativeZoom: TILE_MAX_ZOOM,
    });
  }

  /**
   * Where the server's archive has data: its header bounds and zoom range. Null without one.
   * A full-detail archive (data to z15) is drawn past its last level up to the map's max zoom;
   * a shallower one stops where its data stops.
   */
  function vectorCoverage(meta) {
    const bounds = meta?.mapPmtilesBounds;
    if (!meta?.mapPmtilesUrl || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return null;
    const [west, south, east, north] = bounds;
    if (!(west < east && south < north)) return null;
    const min = Number.isFinite(meta.mapPmtilesMinZoom) ? meta.mapPmtilesMinZoom : 0;
    const dataMax = Number.isFinite(meta.mapPmtilesMaxZoom) ? meta.mapPmtilesMaxZoom : 15;
    return { url: meta.mapPmtilesUrl, west, south, east, north, min, dataMax, max: dataMax >= 15 ? TILE_MAX_ZOOM : dataMax };
  }

  /**
   * The archive is used while the map's center is inside its bounds and the zoom is in its range
   * (max already allows overzoom). The edges of the view may stick out past the archive.
   */
  function insideCoverage(map, cover) {
    const zoom = map.getZoom();
    if (!(zoom >= cover.min && zoom <= cover.max)) return false;
    const center = map.getCenter();
    if (!center) return false;
    return center.lng >= cover.west && center.lng <= cover.east
      && center.lat >= cover.south && center.lat <= cover.north;
  }

  /**
   * Dark vector tiles while the view is centered on the archive, the raster tiles everywhere else.
   * Decided once the view is set and again after every move or zoom. A swap adds the new layer
   * on top and drops the old one when the new one has drawn, so the map never goes blank.
   * The view never changes here, so a swap cannot trigger another one.
   * While the archive is not ready yet the map stays on its dark background, no tiles.
   */
  function addMapTiles(L, map) {
    const cover = vectorCoverage(state.meta);
    if (!cover) {
      rasterLayer(L).addTo(map);
      return;
    }
    let gone = false;
    let archive = vectorReady;
    let loading = false;
    let shown = null;
    let next = null;
    let swapTimer = 0;

    const build = (mode) => (mode === "raster" ? rasterLayer(L) : window.protomapsL.leafletLayer({
      url: archive,
      flavor: "dark",
      lang: "de",
      attribution: state.meta?.mapPmtilesAttribution || PMTILES_ATTRIBUTION,
      maxZoom: TILE_MAX_ZOOM,
      maxDataZoom: cover.dataMax,
      bounds: [[cover.south, cover.west], [cover.north, cover.east]],
    }));

    const finishSwap = (layer) => {
      clearTimeout(swapTimer);
      if (gone || next?.layer !== layer) return;
      shown?.layer.remove();
      shown = next;
      next = null;
    };

    const show = (mode) => {
      const layer = build(mode);
      if (!shown) {
        shown = { mode, layer };
        layer.addTo(map);
        return;
      }
      next = { mode, layer };
      layer.once("load", () => finishSwap(layer));
      // A vector tile that is skipped mid-zoom never reports back. Do not wait on it forever.
      swapTimer = setTimeout(() => finishSwap(layer), 2500);
      layer.addTo(map);
    };

    const settle = () => {
      if (gone) return;
      const mode = !vectorBroken && insideCoverage(map, cover) ? "vector" : "raster";
      if (mode === "vector" && !archive) {
        if (!loading) {
          loading = true;
          // No light raster tiles in the meantime: they would flash before the dark map.
          loadVectorArchive(cover.url).then(
            (ready) => { archive = ready; },
            (error) => markVectorBroken(error),
          ).finally(() => {
            loading = false;
            settle();
          });
        }
        return;
      }
      if ((next || shown)?.mode === mode) return;
      if (next) {
        clearTimeout(swapTimer);
        next.layer.remove();
        next = null;
        if (shown?.mode === mode) return;
      }
      show(mode);
    };

    brokenListeners.add(settle);
    map.once("unload", () => {
      gone = true;
      brokenListeners.delete(settle);
      clearTimeout(swapTimer);
    });
    map.whenReady(settle);
    map.on("moveend zoomend", settle);
  }

  function markVectorBroken(error) {
    if (vectorBroken) return;
    vectorBroken = true;
    console.warn("vector basemap unavailable, using raster tiles", error);
    for (const listener of [...brokenListeners]) listener();
  }

  /**
   * The archive, header already read. Reads inside the prefetched head come from memory. Every
   * other read after the header is watched: a failure that is not our own cancel (a 404 or 503,
   * a cut connection, offline) gives up on vector tiles for this page. A failed vector tile
   * would otherwise stay an empty dark square. Kept for the page: a new map reuses it.
   */
  function loadVectorArchive(url) {
    if (!vectorPromise) {
      vectorPromise = Promise.all([loadProtomaps(), readHead(url)]).then(async ([protomapsL, head]) => {
        const archive = new protomapsL.PmtilesSource(url, true).p;
        const source = archive.source;
        const getBytes = source.getBytes.bind(source);
        let watch = false;
        source.getBytes = async (offset, length, signal, etag) => {
          if (head && offset + length <= head.data.byteLength) {
            return { data: head.data.slice(offset, offset + length), etag: head.etag };
          }
          try {
            return await getBytes(offset, length, signal, etag);
          } catch (error) {
            // The archive may have been replaced on the server: read the header fresh from now on.
            if (error?.name !== "AbortError") head = null;
            if (watch && error?.name !== "AbortError") markVectorBroken(error);
            throw error;
          }
        };
        await archive.getHeader();
        watch = true;
        vectorReady = archive;
        return archive;
      });
    }
    return vectorPromise;
  }

  /**
   * Header and directories in one range request, the size the server names. Null when it does
   * not answer with exactly that range; the archive then reads its header the usual way.
   */
  async function readHead(url) {
    if (headPromise) return headPromise;
    const length = Number.isSafeInteger(state.meta?.mapPmtilesHead) && state.meta.mapPmtilesHead > 0
      ? state.meta.mapPmtilesHead
      : 16384;
    headPromise = (async () => {
      const response = await fetch(url, { headers: { range: `bytes=0-${length - 1}` } });
      if (response.status !== 206 || !String(response.headers.get("content-range") || "").startsWith(`bytes 0-${length - 1}/`)) {
        response.body?.cancel().catch(() => {});
        return null;
      }
      const data = await response.arrayBuffer();
      if (data.byteLength !== length) return null;
      const etag = response.headers.get("etag");
      return { data, etag: etag && !etag.startsWith("W/") ? etag : undefined };
    })().catch(() => null);
    const head = await headPromise;
    if (!head) headPromise = null;
    return head;
  }

  /**
   * Once the app is idle: Leaflet, the vector map script and the archive header, so the Map tab
   * and the place picker draw at once. Failures are dropped; opening a map tries again.
   */
  function warmMap() {
    if (warmed) return;
    warmed = true;
    const run = () => {
      loadLeaflet().catch(() => {});
      primeVector();
    };
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 1000);
  }

  /**
   * Starts reading the archive header next to the Leaflet download. A failure here only drops
   * the promise, so the map that opens next tries again and decides about raster itself.
   */
  function primeVector() {
    const cover = vectorCoverage(state.meta);
    if (!cover || vectorBroken || vectorPromise) return;
    const pending = loadVectorArchive(cover.url);
    pending.catch(() => { if (vectorPromise === pending) vectorPromise = null; });
  }

  /** Same loading as Leaflet: one script tag from /vendor, after Leaflet itself. */
  function loadProtomaps() {
    if (window.protomapsL) return Promise.resolve(window.protomapsL);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/protomaps-leaflet/protomaps-leaflet.js";
      script.onload = () => (window.protomapsL ? resolve(window.protomapsL) : reject(new Error("vector map failed to load")));
      script.onerror = () => {
        script.remove();
        reject(new Error("vector map failed to load"));
      };
      document.body.append(script);
    });
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
   * One marker per pin: a glass pill with the avatar on the latlng, then the crowd and the
   * day label inside the pill. The crowd lets taps through to the pill.
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
    const classes = ["pin", "pin-styled", `pin-${pin.kind}`];
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
      if (openMapPin === key) closeMapCard();
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
      closeMapCard();
      return;
    }
    showMapCard(pin);
  }

  async function mountWhereMap() {
    const host = document.getElementById("where-map");
    if (!host || !bag().whereMap || !pickerSheet()) return;
    primeVector();
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
    primeVector();
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
    // A tap on the map itself, not a pin (markers do not bubble) and not a drag, puts the card away.
    map.on("click", () => { if (!keepCardOnMapTap()) closeMapCard(); });
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

  /** Puts the pin card away. The map stays as it is. Focus inside the card goes back to the map. */
  function closeMapCard() {
    openMapPin = null;
    const host = document.getElementById("map-card-host");
    if (!host) return;
    const hadFocus = host.contains(document.activeElement);
    host.replaceChildren();
    if (hadFocus) document.getElementById("hangry-map")?.focus({ preventScroll: true });
  }

  function mapCardOpen() {
    return Boolean(openMapPin && document.querySelector("#map-card-host .map-card"));
  }

  return { mountMap, mountWhereMap, destroyLiveMap, destroyWhereMap, refreshPins, closeMapCard, mapCardOpen, warmMap };
}
