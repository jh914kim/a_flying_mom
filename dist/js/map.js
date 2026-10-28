/**
 * flying mom - Interactive Map Module (OpenFreeMap + MapLibre GL JS + Leaflet)
 * 
 * - Map Provider: OpenFreeMap (Not Google Maps, zero API keys required).
 * - Map Data: OpenStreetMap based data provided via OpenFreeMap.
 * - Display: Leaflet + MapLibre GL JS.
 * - Design: Modified Positron style with custom colors, minimized roads & buildings for city-centric clarity.
 * - Korean Place Names: Korean names prioritized; if unavailable, the label is omitted.
 * - Offline / Fallback: Uses embedded Natural Earth world landmass GeoJSON.
 * - Calculation: Airplane location & flight paths are calculated by the app based on registered schedules.
 */

import { GWACHEON_BASE, getHomeBase } from './airports.js';
import { STATUS_TYPES } from './location-engine.js';
import { NATURAL_EARTH_WORLD } from './natural-earth.js';
import { CUSTOM_MAP_STYLE } from './map-style.js';
import { getCurrentThemeConfig, onThemeChange } from './theme.js';

let leafletLoaded = false;
let librariesLoadingPromise = null;
let mapInstance = null;
let currentMarkers = [];
let currentPolylineLayers = [];
let fallbackGeoJsonLayer = null;
let lastStatusData = null;
let isFallbackActive = false;

// Resource URLs
const LEAFLET_CSS_URL = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS_URL = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const MAPLIBRE_CSS_URL = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css';
const MAPLIBRE_JS_URL = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js';
const MAPLIBRE_LEAFLET_URL = 'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.0.20/leaflet-maplibre-gl.js';

/**
 * Loads Leaflet, MapLibre GL JS, and Leaflet-MapLibre bridge dynamically
 */
export function loadMapLibraries() {
  if (leafletLoaded && window.L && window.maplibregl) return Promise.resolve();
  if (librariesLoadingPromise) return librariesLoadingPromise;

  librariesLoadingPromise = new Promise(async (resolve, reject) => {
    try {
      // 1. Inject CSS
      injectStylesheet(LEAFLET_CSS_URL);
      injectStylesheet(MAPLIBRE_CSS_URL);

      // 2. Load Leaflet JS
      if (!window.L) await loadScript(LEAFLET_JS_URL);
      // 3. Load MapLibre GL JS
      if (!window.maplibregl) await loadScript(MAPLIBRE_JS_URL);
      // 4. Load Leaflet MapLibre Plugin
      if (!window.L.maplibreGL) await loadScript(MAPLIBRE_LEAFLET_URL);

      leafletLoaded = true;
      resolve();
    } catch (err) {
      console.warn('Failed to load online vector map libraries, falling back to offline Leaflet/Natural Earth:', err);
      // Even if MapLibre fails, try to at least have basic Leaflet
      if (!window.L) {
        try {
          await loadScript(LEAFLET_JS_URL);
        } catch (_) {}
      }
      resolve(); // Proceed to fallback
    }
  });

  return librariesLoadingPromise;
}

function injectStylesheet(href) {
  if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Customizes OpenFreeMap Positron Style:
 * 1. Prioritizes Korean place names ('name:ko', 'name_ko'). Omit label if Korean is missing.
 * 2. Hides detailed building footprints and minor roads to focus on cities and countries.
 * 3. Applies clean high-contrast color scheme.
 */
/**
 * Initialize Map inside container
 */
export async function initMap(containerId = 'map-canvas') {
  const container = document.getElementById(containerId);
  if (!container) return null;

  await loadMapLibraries();

  if (!window.L) {
    showMapNotice('지도 렌더링 엔진 로드 실패. 브라우저 설정을 확인해주세요.');
    return null;
  }

  const L = window.L;

  if (mapInstance) {
    mapInstance.invalidateSize();
    return mapInstance;
  }

  // Create Leaflet instance (City zoom 7, world minZoom 2)
  mapInstance = L.map(containerId, {
    center: [GWACHEON_BASE.lat, GWACHEON_BASE.lng],
    zoom: 7,
    minZoom: 2,
    maxZoom: 14,
    zoomControl: false,
    worldCopyJump: true
  });

  // Small 30-32px zoom controls in bottom-right
  L.control.zoom({ position: 'bottomright' }).addTo(mapInstance);

  let vectorLayerSuccess = false;

  // Render OpenFreeMap using MapLibre GL Leaflet adapter with our customized Positron style
  if (L.maplibreGL && window.maplibregl) {
    try {
      const glLayer = L.maplibreGL({
        style: CUSTOM_MAP_STYLE,
        attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> | Tiles &copy; <a href="https://openfreemap.org" target="_blank">OpenFreeMap</a>'
      });

      glLayer.addTo(mapInstance);
      vectorLayerSuccess = true;
    } catch (err) {
      console.warn('Failed to initialize OpenFreeMap vector layer:', err);
    }
  }

  // Fallback: ONLY if OpenFreeMap fails or is offline, use embedded Natural Earth world map
  // Do NOT overlay Natural Earth on top of active OpenFreeMap!
  if (!vectorLayerSuccess) {
    activateNaturalEarthFallback(L);
  }

  if (lastStatusData) {
    updateMapWithStatus(lastStatusData);
  }

  return mapInstance;
}

/**
 * Renders embedded Natural Earth world map layer when connection fails
 */
function activateNaturalEarthFallback(L) {
  if (isFallbackActive || !mapInstance) return;
  isFallbackActive = true;

  // Set ocean background color on container
  const container = mapInstance.getContainer();
  if (container) {
    container.style.backgroundColor = '#d8e6f7';
  }

  // Render Natural Earth landmass polygons
  fallbackGeoJsonLayer = L.geoJSON(NATURAL_EARTH_WORLD, {
    style: {
      fillColor: '#ffffff',
      weight: 1.2,
      color: '#b0bac7',
      fillOpacity: 1
    }
  }).addTo(mapInstance);

  showMapNotice('온라인 지도 연결이 원활하지 않아 앱에 내장된 Natural Earth 세계 윤곽 지도로 표시합니다.');
}

function showMapNotice(msg) {
  const noticeEl = document.getElementById('map-error-notice');
  if (noticeEl) {
    noticeEl.textContent = msg;
    noticeEl.style.display = 'block';
  }
}

function clearMapMarkers() {
  if (!mapInstance) return;
  for (const m of currentMarkers) {
    mapInstance.removeLayer(m);
  }
  currentMarkers = [];

  for (const p of currentPolylineLayers) {
    mapInstance.removeLayer(p);
  }
  currentPolylineLayers = [];
}

/**
 * Creates 26px SVG pin icon
 */
function createPinIcon(L, color = '#1A73E8') {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34" fill="none">
      <path d="M13 0C5.82 0 0 5.82 0 13C0 22.75 13 34 13 34C13 34 26 22.75 26 13C26 5.82 20.18 0 13 0Z" fill="${color}"/>
      <circle cx="13" cy="13" r="5" fill="#FFFFFF"/>
    </svg>
  `;
  return L.divIcon({
    className: 'custom-map-pin',
    html: svg,
    iconSize: [26, 34],
    iconAnchor: [13, 34],
    popupAnchor: [0, -32]
  });
}

/**
 * Creates Home Icon:
 * - Hello Kitty theme: Relaxing Hello Kitty lying down
 * - Other themes: 28x36px Home Pin Icon with House SVG
 */
function createHomeIcon(L, color = '#1A73E8', themeId = 'default') {
  if (themeId === 'hellokitty') {
    const html = `
      <div class="hk-home-marker-wrapper" style="width: 52px; height: 38px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="assets/img/hk-home-kitty.png" width="50" height="36" alt="우리 집 키티" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;
    return L.divIcon({
      className: 'custom-home-pin hk-home-pin',
      html: html,
      iconSize: [52, 38],
      iconAnchor: [26, 19],
      popupAnchor: [0, -18]
    });
  }

  if (themeId === 'rilakkuma') {
    const html = `
      <div class="rk-home-marker-wrapper" style="width: 54px; height: 40px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="assets/img/rk-home-rilakkuma.png" width="52" height="38" alt="우리 집 리락쿠마" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;
    return L.divIcon({
      className: 'custom-home-pin rk-home-pin',
      html: html,
      iconSize: [54, 40],
      iconAnchor: [27, 20],
      popupAnchor: [0, -18]
    });
  }

  if (themeId === 'doraemon') {
    const html = `
      <div class="dm-home-marker-wrapper" style="width: 44px; height: 54px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="assets/img/dm-home-doraemon.png" width="40" height="50" alt="우리 집 도라에몽" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;
    return L.divIcon({
      className: 'custom-home-pin dm-home-pin',
      html: html,
      iconSize: [44, 54],
      iconAnchor: [22, 27],
      popupAnchor: [0, -25]
    });
  }

  const svg = `
    <div style="filter: drop-shadow(0 2px 5px rgba(0,0,0,0.3)); display: flex; align-items: center; justify-content: center;">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" fill="none">
        <path d="M14 0C6.27 0 0 6.27 0 14C0 24.5 14 36 14 36C14 36 28 24.5 28 14C28 6.27 21.73 0 14 0Z" fill="${color}"/>
        <circle cx="14" cy="14" r="9.5" fill="#FFFFFF"/>
        <path d="M14 6.8L7.5 12.8H9.5V20H12.5V16H15.5V20H18.5V12.8H20.5L14 6.8Z" fill="${color}"/>
      </svg>
    </div>
  `;
  return L.divIcon({
    className: 'custom-home-pin',
    html: svg,
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -34]
  });
}

/**
 * Creates Stay / Destination Hotel Icon:
 * - Hello Kitty theme: Hello Kitty Traveler character
 * - Rilakkuma theme: Rilakkuma relaxing on vacation character
 * - Other themes: 28x36px Hotel Pin Icon with Bed SVG
 */
function createStayIcon(L, color = '#1A73E8', themeId = 'default') {
  if (themeId === 'hellokitty') {
    const html = `
      <div class="hk-stay-marker-wrapper" style="width: 48px; height: 50px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="assets/img/hk-traveler.png" width="44" height="48" alt="체류지 키티" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;
    return L.divIcon({
      className: 'custom-stay-pin hk-stay-pin',
      html: html,
      iconSize: [48, 50],
      iconAnchor: [24, 25],
      popupAnchor: [0, -22]
    });
  }

  if (themeId === 'rilakkuma') {
    const html = `
      <div class="rk-stay-marker-wrapper" style="width: 50px; height: 46px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="assets/img/rk-relax.png" width="48" height="42" alt="체류지 리락쿠마" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;
    return L.divIcon({
      className: 'custom-stay-pin rk-stay-pin',
      html: html,
      iconSize: [50, 46],
      iconAnchor: [25, 23],
      popupAnchor: [0, -20]
    });
  }

  if (themeId === 'doraemon') {
    const html = `
      <div class="dm-stay-marker-wrapper" style="width: 52px; height: 50px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="assets/img/dm-relax.png" width="50" height="48" alt="체류지 도라에몽" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;
    return L.divIcon({
      className: 'custom-stay-pin dm-stay-pin',
      html: html,
      iconSize: [52, 50],
      iconAnchor: [26, 25],
      popupAnchor: [0, -23]
    });
  }

  const svg = `
    <div style="filter: drop-shadow(0 2px 5px rgba(0,0,0,0.3)); display: flex; align-items: center; justify-content: center;">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" fill="none">
        <path d="M14 0C6.27 0 0 6.27 0 14C0 24.5 14 36 14 36C14 36 28 24.5 28 14C28 6.27 21.73 0 14 0Z" fill="${color}"/>
        <circle cx="14" cy="14" r="9.5" fill="#FFFFFF"/>
        <!-- Hotel Bed Symbol -->
        <path d="M7 10V18H8.5V16.5H19.5V18H21V12.8C21 11.5 19.9 10.5 18.5 10.5H13.5V13H8.5V10H7Z" fill="${color}"/>
        <circle cx="10.8" cy="12" r="1.4" fill="${color}"/>
        <path d="M13.5 12.5H18.5C19.3 12.5 20 13.1 20 13.8V15H13.5V12.5Z" fill="${color}"/>
      </svg>
    </div>
  `;
  return L.divIcon({
    className: 'custom-stay-pin',
    html: svg,
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -34]
  });
}

/**
 * Creates Briefing Icon:
 * - Hello Kitty theme: Hello Kitty reading binder at desk
 * - Rilakkuma theme: Rilakkuma checking schedule with question mark
 * - Doraemon theme: Nobita intently writing notes at desk
 * - Other themes: 28x36px Briefing Clipboard / Checklist Pin Icon
 */
function createBriefingIcon(L, color = '#1A73E8', themeId = 'default') {
  if (themeId === 'hellokitty') {
    const html = `
      <div class="hk-briefing-marker-wrapper" style="width: 48px; height: 50px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="assets/img/hk-briefing.png" width="46" height="48" alt="브리핑 키티" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;
    return L.divIcon({
      className: 'custom-briefing-pin hk-briefing-pin',
      html: html,
      iconSize: [48, 50],
      iconAnchor: [24, 25],
      popupAnchor: [0, -22]
    });
  }

  if (themeId === 'rilakkuma') {
    const html = `
      <div class="rk-briefing-marker-wrapper" style="width: 48px; height: 50px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="assets/img/rk-briefing.png" width="46" height="48" alt="브리핑 리락쿠마" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;
    return L.divIcon({
      className: 'custom-briefing-pin rk-briefing-pin',
      html: html,
      iconSize: [48, 50],
      iconAnchor: [24, 25],
      popupAnchor: [0, -22]
    });
  }

  if (themeId === 'doraemon') {
    const html = `
      <div class="dm-briefing-marker-wrapper" style="width: 50px; height: 48px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="assets/img/dm-briefing.png" width="48" height="46" alt="브리핑 진구" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;
    return L.divIcon({
      className: 'custom-briefing-pin dm-briefing-pin',
      html: html,
      iconSize: [50, 48],
      iconAnchor: [25, 24],
      popupAnchor: [0, -22]
    });
  }

  const svg = `
    <div style="filter: drop-shadow(0 2px 5px rgba(0,0,0,0.3)); display: flex; align-items: center; justify-content: center;">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" fill="none">
        <path d="M14 0C6.27 0 0 6.27 0 14C0 24.5 14 36 14 36C14 36 28 24.5 28 14C28 6.27 21.73 0 14 0Z" fill="${color}"/>
        <circle cx="14" cy="14" r="9.5" fill="#FFFFFF"/>
        <!-- Briefing Clipboard Symbol -->
        <rect x="9" y="8.5" width="10" height="12" rx="1.5" stroke="${color}" stroke-width="1.3" fill="none"/>
        <rect x="11.5" y="7.5" width="5" height="2" rx="0.8" fill="${color}"/>
        <line x1="11.5" y1="12" x2="16.5" y2="12" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="11.5" y1="14.5" x2="16.5" y2="14.5" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="11.5" y1="17" x2="14.5" y2="17" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>
      </svg>
    </div>
  `;
  return L.divIcon({
    className: 'custom-briefing-pin',
    html: svg,
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -34]
  });
}



/**
 * Creates 28x36px Airport Pin Icon (Option 1: Runway & Jet Takeoff Departure)
 */
function createAirportIcon(L, color = '#5f6368') {
  const svg = `
    <div style="filter: drop-shadow(0 2px 5px rgba(0,0,0,0.25)); display: flex; align-items: center; justify-content: center;">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" fill="none">
        <path d="M14 0C6.27 0 0 6.27 0 14C0 24.5 14 36 14 36C14 36 28 24.5 28 14C28 6.27 21.73 0 14 0Z" fill="${color}"/>
        <circle cx="14" cy="14" r="9.5" fill="#FFFFFF"/>
        <!-- Runway Line Below -->
        <line x1="7.5" y1="19.5" x2="20.5" y2="19.5" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/>
        <!-- Jet Climbing Departure 45 deg (Official Airport Signage Symbol) -->
        <path d="M20 10l-4 1.3-5-4.8-1.4.5 2.9 5.3-3.7 1.1-1.5-1.2-1 .3 1.1 2.7 1.4.4 10.8-3.1c.6-.2 1-.8.8-1.4-.1-.6-.7-.9-1.3-.7z" fill="${color}"/>
      </svg>
    </div>
  `;
  return L.divIcon({
    className: 'custom-airport-pin',
    html: svg,
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -34]
  });
}

/**
 * Creates rotated airplane icon:
 * - Default / Asiana / KoreanAir: Modern Jetliner (Option 1: Aerodynamic Style)
 * - Hello Kitty theme: Hello Kitty riding an airplane with East / West heading flip & realistic pitch
 */
function createAirplaneIcon(L, heading = 0, fillColor = '#1A73E8', strokeColor = '#ffffff', themeId = 'default') {
  const isHelloKitty = themeId === 'hellokitty' || (typeof fillColor === 'object' && fillColor.id === 'hellokitty');
  const isRilakkuma = themeId === 'rilakkuma' || (typeof fillColor === 'object' && fillColor.id === 'rilakkuma');
  const isDoraemon = themeId === 'doraemon' || (typeof fillColor === 'object' && fillColor.id === 'doraemon');
  const actualFill = typeof fillColor === 'object' ? (fillColor.airplaneColor || '#1A73E8') : fillColor;
  const actualStroke = typeof fillColor === 'object' ? (fillColor.airplaneStroke || strokeColor) : strokeColor;

  if (isHelloKitty) {
    // Heading in degrees: 0..360 (0=North, 90=East, 180=South, 270=West)
    const normalized = ((heading % 360) + 360) % 360;
    // Eastbound: 0 <= normalized < 180 (flying towards right)
    // Westbound: 180 <= normalized < 360 (flying towards left)
    const isWestbound = normalized >= 180 && normalized < 360;
    const imgSrc = isWestbound ? 'assets/img/hk-airplane-west.png' : 'assets/img/hk-airplane-east.png';

    // Calculate natural climb/descent pitch angle (clamped within ±25 deg)
    const pitch = isWestbound
      ? Math.max(-25, Math.min(25, (270 - normalized) * 0.4))
      : Math.max(-25, Math.min(25, (normalized - 90) * 0.4));

    const html = `
      <div class="hk-airplane-marker-wrapper" style="transform: rotate(${pitch}deg); transform-origin: center center; width: 48px; height: 46px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="${imgSrc}" width="46" height="44" alt="헬로키티 비행기" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;

    return L.divIcon({
      className: 'custom-airplane-pin hk-airplane-pin',
      html: html,
      iconSize: [48, 46],
      iconAnchor: [24, 23]
    });
  }

  if (isRilakkuma) {
    const normalized = ((heading % 360) + 360) % 360;
    const isWestbound = normalized >= 180 && normalized < 360;
    const imgSrc = isWestbound ? 'assets/img/rk-airplane-west.png' : 'assets/img/rk-airplane-east.png';

    const pitch = isWestbound
      ? Math.max(-25, Math.min(25, (270 - normalized) * 0.4))
      : Math.max(-25, Math.min(25, (normalized - 90) * 0.4));

    const html = `
      <div class="rk-airplane-marker-wrapper" style="transform: rotate(${pitch}deg); transform-origin: center center; width: 50px; height: 42px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="${imgSrc}" width="48" height="40" alt="리락쿠마 비행기" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;

    return L.divIcon({
      className: 'custom-airplane-pin rk-airplane-pin',
      html: html,
      iconSize: [50, 42],
      iconAnchor: [25, 21]
    });
  }

  if (isDoraemon) {
    const normalized = ((heading % 360) + 360) % 360;
    const isWestbound = normalized >= 180 && normalized < 360;
    const imgSrc = isWestbound ? 'assets/img/dm-airplane-west.png' : 'assets/img/dm-airplane-east.png';

    const pitch = isWestbound
      ? Math.max(-25, Math.min(25, (270 - normalized) * 0.4))
      : Math.max(-25, Math.min(25, (normalized - 90) * 0.4));

    const html = `
      <div class="dm-airplane-marker-wrapper" style="transform: rotate(${pitch}deg); transform-origin: center center; width: 52px; height: 44px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">
        <img src="${imgSrc}" width="50" height="42" alt="도라에몽 비행기" style="display: block; object-fit: contain; pointer-events: none; user-select: none;">
      </div>
    `;

    return L.divIcon({
      className: 'custom-airplane-pin dm-airplane-pin',
      html: html,
      iconSize: [52, 44],
      iconAnchor: [26, 22]
    });
  }

  const svg = `
    <div style="transform: rotate(${heading}deg); transform-origin: center center; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.35));">
      <svg width="34" height="34" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Modern Jetliner Wings & Fuselage -->
        <path d="M24 2 C22.8 2 21.5 5 21.5 10 L21.5 18 L3 27.5 C2 28 2 29.5 3.2 29.5 L21.5 25.5 L21.5 38 L14 42.5 C13.5 42.8 13.5 43.8 14.2 44 L24 42 L33.8 44 C34.5 43.8 34.5 42.8 34 42.5 L26.5 38 L26.5 25.5 L44.8 29.5 C46 29.5 46 28 45 27.5 L26.5 18 L26.5 10 C26.5 5 25.2 2 24 2 Z" fill="${actualFill}" stroke="${actualStroke}" stroke-width="1.6" stroke-linejoin="round"/>
        <!-- Dual Jet Engine Nacelles -->
        <rect x="14.5" y="23.5" width="2.8" height="6.2" rx="1.4" fill="${actualFill}" stroke="${actualStroke}" stroke-width="1"/>
        <rect x="30.7" y="23.5" width="2.8" height="6.2" rx="1.4" fill="${actualFill}" stroke="${actualStroke}" stroke-width="1"/>
      </svg>
    </div>
  `;
  return L.divIcon({
    className: 'custom-airplane-pin',
    html: svg,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

/**
 * Updates the map visual state according to current status
 */
export function updateMapWithStatus(statusData, preserveCamera = false) {
  lastStatusData = statusData;
  updateMapOverlayBar(statusData);
  if (!mapInstance || !window.L) return;

  const L = window.L;
  const theme = getCurrentThemeConfig();
  clearMapMarkers();

  // If status is UNKNOWN (e.g. all schedules deleted or no schedule for current month)
  if (statusData.status === STATUS_TYPES.UNKNOWN || !statusData.coords) {
    updateMapOverlayBar(statusData);
    if (!preserveCamera) {
      mapInstance.setView([25, 130], 2);
    }
    return;
  }

  const coords = statusData.coords;

  // 1. Current Location Marker (Themed 26px pin or airplane)
  let currentMarker;
  if (statusData.status === STATUS_TYPES.IN_FLIGHT) {
    const isMascot = theme.id === 'hellokitty' || theme.id === 'rilakkuma' || theme.id === 'doraemon';
    const pct = Math.min(100, Math.max(0, Math.round((statusData.progress || 0) * 100)));

    currentMarker = L.marker(coords, {
      icon: createAirplaneIcon(L, statusData.heading || 0, theme.airplaneColor, theme.airplaneStroke || '#ffffff', theme.id),
      zIndexOffset: 1000
    });

    // Permanent badge tooltip displaying progress % on the airplane
    currentMarker.bindTooltip(`
      <div class="map-airplane-pct-badge">
        <span class="map-airplane-pct">${pct}%</span>
      </div>
    `, {
      permanent: true,
      direction: 'top',
      offset: isMascot ? [0, -22] : [0, -18],
      className: 'custom-map-plane-tooltip'
    });

    currentMarker.bindPopup(`<b>${statusData.title}</b><br>${statusData.description}`);
  } else if (statusData.status === STATUS_TYPES.HOME) {
    const isMascot = theme.id === 'hellokitty' || theme.id === 'rilakkuma' || theme.id === 'doraemon';
    const home = getHomeBase();
    currentMarker = L.marker(coords, {
      icon: createHomeIcon(L, theme.primaryColor, theme.id),
      zIndexOffset: 1000
    });
    currentMarker.bindTooltip(home.name || '우리 집', { direction: 'top', offset: isMascot ? [0, -19] : [0, -34] });
    currentMarker.bindPopup(`<b>${statusData.title}</b><br>${home.address || (home.city + ' (집)')}`);
  } else if (statusData.status === STATUS_TYPES.OVERSEAS_STAY) {
    const isMascot = theme.id === 'hellokitty' || theme.id === 'rilakkuma' || theme.id === 'doraemon';
    currentMarker = L.marker(coords, {
      icon: createStayIcon(L, theme.primaryColor, theme.id),
      zIndexOffset: 1000
    });
    currentMarker.bindTooltip(statusData.locationName ? `체류 중 · ${statusData.locationName}` : '해외 체류 중', {
      direction: 'top',
      offset: isMascot ? [0, -22] : [0, -34]
    });
    currentMarker.bindPopup(`<b>${statusData.title}</b><br>${statusData.locationName || '해외 체류지'}`);
  } else if (statusData.status === STATUS_TYPES.BRIEFING) {
    const isMascot = theme.id === 'hellokitty' || theme.id === 'rilakkuma' || theme.id === 'doraemon';
    currentMarker = L.marker(coords, {
      icon: createBriefingIcon(L, theme.primaryColor, theme.id),
      zIndexOffset: 1000
    });
    currentMarker.bindTooltip(statusData.locationName ? `브리핑 중 · ${statusData.locationName}` : '비행 브리핑 중', {
      direction: 'top',
      offset: isMascot ? [0, -22] : [0, -34]
    });
    currentMarker.bindPopup(`<b>${statusData.title}</b><br>${statusData.description}`);
  } else {
    currentMarker = L.marker(coords, {
      icon: createPinIcon(L, theme.primaryColor),
      zIndexOffset: 1000
    });
    currentMarker.bindPopup(`<b>${statusData.title}</b><br>${statusData.locationName}`);
  }
  currentMarker.addTo(mapInstance);
  currentMarkers.push(currentMarker);

  // 2. Flight Paths & Destination Markers
  let activeSegments = null;

  if ((statusData.status === STATUS_TYPES.IN_FLIGHT || statusData.status === STATUS_TYPES.BRIEFING) && statusData.flightPath) {
    activeSegments = statusData.flightPath;
    
    // Arrival destination airport marker
    if (statusData.flight && statusData.flight.arrAirport) {
      const destAp = statusData.flight.arrAirport;
      const destCity = destAp.city.split('/')[0];
      const pct = Math.min(100, Math.max(0, Math.round((statusData.progress || 0) * 100)));

      const destMarker = L.marker([destAp.lat, destAp.lng], {
        icon: createPinIcon(L, theme.destPinColor)
      });

      // Permanent badge tooltip displaying destination city right next to the pin
      destMarker.bindTooltip(`
        <div class="map-city-pct-badge">
          <span class="map-city-name">${destCity}</span>
        </div>
      `, {
        permanent: true,
        direction: 'right',
        offset: [12, -18],
        className: 'custom-map-pct-tooltip'
      });

      destMarker.bindPopup(`<b>도착 공항</b><br>${destAp.city} (${destAp.code})`).addTo(mapInstance);
      currentMarkers.push(destMarker);
    }
    // Departure airport marker
    if (statusData.status === STATUS_TYPES.IN_FLIGHT && statusData.flight && statusData.flight.depAirport) {
      const depAp = statusData.flight.depAirport;
      const depMarker = L.marker([depAp.lat, depAp.lng], {
        icon: createAirportIcon(L, theme.depPinColor)
      });
      depMarker.bindTooltip(`출발 · ${depAp.city.split('/')[0]} (${depAp.code})`, { direction: 'top', offset: [0, -34] });
      depMarker.bindPopup(`<b>출발 공항</b><br>${depAp.city} (${depAp.code})`).addTo(mapInstance);
      currentMarkers.push(depMarker);
    }
  } else if (statusData.nextFlightPath) {
    activeSegments = statusData.nextFlightPath;

    // Departure airport marker for upcoming flight (e.g. while mom is at home)
    if (statusData.nextFlight && statusData.nextFlight.depAirport) {
      const depAp = statusData.nextFlight.depAirport;
      const isSameLoc = coords && (Math.abs(depAp.lat - coords[0]) < 0.01 && Math.abs(depAp.lng - coords[1]) < 0.01);
      if (!isSameLoc) {
        const depMarker = L.marker([depAp.lat, depAp.lng], {
          icon: createAirportIcon(L, theme.depPinColor)
        });
        depMarker.bindTooltip(`출발 공항 · ${depAp.city.split('/')[0]} (${depAp.code})`, { direction: 'top', offset: [0, -34] });
        depMarker.bindPopup(`<b>출발 공항</b><br>${depAp.city} (${depAp.code})`).addTo(mapInstance);
        currentMarkers.push(depMarker);
      }
    }

    // Next flight arrival marker
    if (statusData.nextFlight && statusData.nextFlight.arrAirport) {
      const nextAp = statusData.nextFlight.arrAirport;
      const nextMarker = L.marker([nextAp.lat, nextAp.lng], {
        icon: createPinIcon(L, theme.destPinColor)
      }).bindPopup(`<b>다음 목적지</b><br>${nextAp.city} (${nextAp.code})`).addTo(mapInstance);
      currentMarkers.push(nextMarker);
    }
  }

  // Draw Great Circle multi-polyline segments (Flight path dashed line)
  if (activeSegments && Array.isArray(activeSegments)) {
    for (const seg of activeSegments) {
      if (seg.length > 1) {
        const poly = L.polyline(seg, {
          color: theme.flightPathColor,
          weight: 3.5,
          opacity: 0.95,
          dashArray: '6, 6'
        }).addTo(mapInstance);
        currentPolylineLayers.push(poly);
      }
    }
  }

  // Update Map Overlay Text Bar
  updateMapOverlayBar(statusData);

  // Initial Camera Positioning: In-flight 5, City/Home 7, World 2
  if (!preserveCamera) {
    if (statusData.status === STATUS_TYPES.IN_FLIGHT) {
      mapInstance.setView(coords, 5);
    } else if (statusData.status === STATUS_TYPES.HOME || statusData.status === STATUS_TYPES.OVERSEAS_STAY || statusData.status === STATUS_TYPES.BRIEFING) {
      mapInstance.setView(coords, 7);
    } else {
      mapInstance.setView([25, 130], 2);
    }
  }
}

// Re-render map markers & polylines when theme changes without resetting camera zoom/pan
onThemeChange(() => {
  if (mapInstance && lastStatusData) {
    updateMapWithStatus(lastStatusData, true);
  }
});

/**
 * Updates the top bar overlay on the map container
 */
function updateMapOverlayBar(statusData) {
  const textEl = document.getElementById('map-badge-text');
  if (!textEl) return;

  if (statusData.status === STATUS_TYPES.UNKNOWN) {
    textEl.textContent = '현재 등록된 비행 일정이 없어요 · 일정을 등록해주세요';
  } else if (statusData.status === STATUS_TYPES.IN_FLIGHT) {
    const destName = statusData.flight && statusData.flight.arrAirport
      ? statusData.flight.arrAirport.city.split('/')[0]
      : (statusData.destCityName || '목적지');
    const pct = Math.min(100, Math.max(0, Math.round((statusData.progress || 0) * 100)));
    const remainingPart = statusData.remainingTimeText ? ` · ${statusData.remainingTimeText}` : '';
    textEl.textContent = `도착지 · ${destName} ${pct}%${remainingPart}`;
  } else if (statusData.status === STATUS_TYPES.BRIEFING) {
    const nextAp = statusData.nextFlight && statusData.nextFlight.arrAirport;
    const nextCity = nextAp ? nextAp.city.split('/')[0] : (statusData.nextFlight ? statusData.nextFlight.to : '');
    textEl.textContent = `${statusData.locationName} · 브리핑 중 (다음 목적지: ${nextCity} · 출발 ${statusData.remainingFormatted} 전)`;
  } else if (statusData.nextFlight) {
    const nextAp = statusData.nextFlight.arrAirport;
    const nextCity = nextAp ? nextAp.city.split('/')[0] : statusData.nextFlight.to;
    const currentLoc = statusData.cityHighlight || '현지';

    let timeRemStr = '';
    if (statusData.nextFlight.depUtc) {
      const diffMs = statusData.nextFlight.depUtc.getTime() - Date.now();
      if (diffMs > 0) {
        const totalMins = Math.round(diffMs / 60000);
        const hours = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        if (hours === 0) {
          timeRemStr = `${Math.max(1, mins)}분 뒤`;
        } else if (hours < 24) {
          timeRemStr = mins > 0 ? `${hours}시간 ${mins}분 뒤` : `${hours}시간 뒤`;
        } else {
          const days = Math.floor(hours / 24);
          const remH = hours % 24;
          timeRemStr = remH > 0 ? `${days}일 ${remH}시간 뒤` : `${days}일 뒤`;
        }
      } else {
        timeRemStr = '곧 출발';
      }
    }

    const timeSuffix = timeRemStr ? ` · ${timeRemStr}` : '';
    const locPrefix = (statusData.status === STATUS_TYPES.HOME || currentLoc === '우리 집')
      ? '우리 집'
      : `${currentLoc} 체류 중`;
    textEl.textContent = `${locPrefix} · 다음 일정 ${nextCity}${timeSuffix}`;
  } else {
    textEl.textContent = statusData.title;
  }
}

/**
 * Reset map view to world overview (zoom 2)
 */
export function resetToWorldView() {
  if (!mapInstance) return;
  mapInstance.setView([25, 130], 2);
}

/**
 * Focus map camera back to current estimated position
 */
export function focusCurrentLocation() {
  if (!mapInstance || !lastStatusData) return;
  if (!lastStatusData.coords) {
    mapInstance.setView([25, 130], 2);
    return;
  }
  const coords = lastStatusData.coords;
  const targetZoom = lastStatusData.status === STATUS_TYPES.IN_FLIGHT ? 5 : 7;
  mapInstance.setView(coords, targetZoom);
}
