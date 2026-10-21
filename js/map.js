/**
 * a flying mom - Interactive Map Module (OpenFreeMap + MapLibre GL JS + Leaflet)
 * 
 * - Map Provider: OpenFreeMap (Not Google Maps, zero API keys required).
 * - Map Data: OpenStreetMap based data provided via OpenFreeMap.
 * - Display: Leaflet + MapLibre GL JS.
 * - Design: Modified Positron style with custom colors, minimized roads & buildings for city-centric clarity.
 * - Korean Place Names: Korean names prioritized; if unavailable, the label is omitted.
 * - Offline / Fallback: Uses embedded Natural Earth world landmass GeoJSON.
 * - Calculation: Airplane location & flight paths are calculated by the app based on registered schedules.
 */

import { GWACHEON_BASE } from './airports.js';
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

  // Create Leaflet instance (City zoom 6, world minZoom 2)
  mapInstance = L.map(containerId, {
    center: [GWACHEON_BASE.lat, GWACHEON_BASE.lng],
    zoom: 6,
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
 * Creates rotated airplane icon:
 * - Default / Asiana / KoreanAir: Modern Jetliner (Option 1: Aerodynamic Style)
 * - Hello Kitty theme: Hello Kitty riding an airplane with East / West heading flip & realistic pitch
 */
function createAirplaneIcon(L, heading = 0, fillColor = '#1A73E8', strokeColor = '#ffffff', themeId = 'default') {
  const isHelloKitty = themeId === 'hellokitty' || (typeof fillColor === 'object' && fillColor.id === 'hellokitty');
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
    // Eastbound: heading 90 = 0deg, heading 45 = -18deg (climb NE), heading 135 = +18deg (descend SE)
    // Westbound: heading 270 = 0deg, heading 315 = -18deg (climb NW), heading 225 = +18deg (descend SW)
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
    currentMarker = L.marker(coords, {
      icon: createAirplaneIcon(L, statusData.heading || 0, theme.airplaneColor, theme.airplaneStroke || '#ffffff', theme.id),
      zIndexOffset: 1000
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

  if (statusData.status === STATUS_TYPES.IN_FLIGHT && statusData.flightPath) {
    activeSegments = statusData.flightPath;
    
    // Arrival destination airport marker
    if (statusData.flight && statusData.flight.arrAirport) {
      const destAp = statusData.flight.arrAirport;
      const destCity = destAp.city.split('/')[0];
      const pct = Math.min(100, Math.max(0, Math.round((statusData.progress || 0) * 100)));

      const destMarker = L.marker([destAp.lat, destAp.lng], {
        icon: createPinIcon(L, theme.destPinColor)
      });

      // Permanent badge tooltip displaying city and % right next to the pin
      destMarker.bindTooltip(`
        <div class="map-city-pct-badge">
          <span class="map-city-name">${destCity}</span>
          <span class="map-city-pct">${pct}%</span>
        </div>
      `, {
        permanent: true,
        direction: 'right',
        offset: [12, -18],
        className: 'custom-map-pct-tooltip'
      });

      destMarker.bindPopup(`<b>도착 공항</b><br>${destAp.city} (${destAp.code}) · 진척도 ${pct}%`).addTo(mapInstance);
      currentMarkers.push(destMarker);
    }
    // Departure airport marker
    if (statusData.flight && statusData.flight.depAirport) {
      const depAp = statusData.flight.depAirport;
      const depMarker = L.marker([depAp.lat, depAp.lng], {
        icon: createPinIcon(L, theme.depPinColor)
      }).bindPopup(`<b>출발 공항</b><br>${depAp.city} (${depAp.code})`).addTo(mapInstance);
      currentMarkers.push(depMarker);
    }
  } else if (statusData.nextFlightPath) {
    activeSegments = statusData.nextFlightPath;

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

  // Initial Camera Positioning: In-flight 3, City/Home 6, World 2
  if (!preserveCamera) {
    if (statusData.status === STATUS_TYPES.IN_FLIGHT) {
      mapInstance.setView(coords, 3);
    } else if (statusData.status === STATUS_TYPES.HOME || statusData.status === STATUS_TYPES.OVERSEAS_STAY) {
      mapInstance.setView(coords, 6);
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
      ? `${statusData.flight.arrAirport.city.split('/')[0]} (${statusData.flight.to})`
      : '목적지';
    const pct = Math.min(100, Math.max(0, Math.round((statusData.progress || 0) * 100)));
    textEl.textContent = `도착지 · ${destName} ${pct}%`;
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
    textEl.textContent = `${currentLoc} 체류 중 · 다음 일정 ${nextCity} (${statusData.nextFlight.to})${timeSuffix}`;
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
  const targetZoom = lastStatusData.status === STATUS_TYPES.IN_FLIGHT ? 3 : 6;
  mapInstance.setView(coords, targetZoom);
}
