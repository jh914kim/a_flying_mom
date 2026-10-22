/**
 * flying mom - Main Application Coordinator
 * Bootstraps modules, manages live clock ticker, weather updates,
 * lazy-loaded map, multi-tab sync, and mobile bottom navigation.
 */

import { determineCurrentStatus, STATUS_TYPES, getDirectionParticle } from './location-engine.js';
import { getCurrentOrNextJourney } from './journey.js';
import { fetchCurrentWeather, clearWeatherCache } from './weather.js';
import { formatLocationTime, formatTzDateTime, formatMetaTime } from './timezone.js';
import { initMap, updateMapWithStatus, resetToWorldView, focusCurrentLocation } from './map.js';
import { initCalendar, prevCalendarMonth, nextCalendarMonth, renderCalendar } from './calendar.js';
import { initStorageSync, getSavedMonths, getMonthSchedule, saveMonthSchedule } from './storage.js';
import { initManagerListeners, openManagerModal } from './manager.js';
import { getSampleSchedule } from './ocr.js';
import { initThemeSwitcher } from './theme.js';

let liveClockInterval = null;
let mapInitialized = false;

/**
 * Initialize application on DOM ready
 */
export async function initApp() {
  // Migrate existing schedules with 'korea' timeBasis to 'local' ("각 공항 현지 시간")
  try {
    const savedMonths = getSavedMonths();
    for (const m of savedMonths) {
      const s = getMonthSchedule(m);
      if (s && s.timeBasis === 'korea') {
        s.timeBasis = 'local';
        saveMonthSchedule(s);
      }
    }
  } catch (err) {
    console.warn('Migration error:', err);
  }

  // Initialize Theme Switcher (Google Flights / Asiana Airlines / Korean Air)
  initThemeSwitcher();

  // Initialize storage cross-tab synchronization
  initStorageSync(() => {
    refreshAllViews();
  });

  // Initialize Schedule Manager event listeners
  initManagerListeners();

  // Initialize Flight Calendar
  initCalendar();

  // Setup Lazy-load Map with IntersectionObserver
  setupLazyMap();

  // Setup Map Action Buttons
  setupMapActions();

  // Setup Calendar Month Navigation
  setupCalendarNav();

  // Setup Bottom Navigation Bar (Mobile)
  setupBottomNav();

  // Setup Screen Refresh Button
  setupScreenRefresh();

  // Initial Full Render
  await refreshAllViews();

  // Start live tick (every 30 seconds for clock and flight progress)
  liveClockInterval = setInterval(() => {
    updateLiveTick();
  }, 30000);
}

/**
 * Pre-populate initial sample schedule if storage is completely empty
 */
function ensureInitialData() {
  const months = getSavedMonths();
  if (months.length === 0) {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const sample = getSampleSchedule(currentMonth);
    saveMonthSchedule({
      month: currentMonth,
      home: 'ICN',
      timeBasis: 'local',
      flights: sample
    });
  }
}

/**
 * Setup lazy loading of map when container is in or near viewport
 */
function setupLazyMap() {
  const mapContainer = document.getElementById('map-canvas');
  if (!mapContainer) return;

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !mapInitialized) {
          mapInitialized = true;
          initMap('map-canvas');
          observer.disconnect();
        }
      }
    }, { rootMargin: '200px' });

    observer.observe(mapContainer);
  } else {
    mapInitialized = true;
    initMap('map-canvas');
  }
}

/**
 * Setup map header control buttons
 */
function setupMapActions() {
  document.getElementById('btn-map-world')?.addEventListener('click', () => {
    resetToWorldView();
  });

  document.getElementById('btn-map-locate')?.addEventListener('click', () => {
    focusCurrentLocation();
  });
}

/**
 * Setup calendar navigation buttons
 */
function setupCalendarNav() {
  document.getElementById('btn-cal-prev')?.addEventListener('click', () => {
    prevCalendarMonth();
  });

  document.getElementById('btn-cal-next')?.addEventListener('click', () => {
    nextCalendarMonth();
  });
}

/**
 * Setup mobile 3-item bottom bar
 */
function setupBottomNav() {
  const btnNavStatus = document.getElementById('nav-btn-status');
  const btnNavCalendar = document.getElementById('nav-btn-calendar');
  const btnNavManage = document.getElementById('nav-btn-manage');

  btnNavStatus?.addEventListener('click', () => {
    document.getElementById('status-section')?.scrollIntoView({ behavior: 'smooth' });
    setActiveNav(btnNavStatus);
  });

  btnNavCalendar?.addEventListener('click', () => {
    document.getElementById('calendar-section')?.scrollIntoView({ behavior: 'smooth' });
    setActiveNav(btnNavCalendar);
  });

  btnNavManage?.addEventListener('click', () => {
    openManagerModal();
    setActiveNav(btnNavManage);
  });
}

function setActiveNav(activeBtn) {
  document.querySelectorAll('.bottom-nav-item').forEach(btn => btn.classList.remove('active'));
  activeBtn?.classList.add('active');
}

/**
 * Setup Screen Refresh Button on Status Card Top-Right
 */
function setupScreenRefresh() {
  const btnRefresh = document.getElementById('btn-screen-refresh');
  if (!btnRefresh) return;

  btnRefresh.addEventListener('click', async () => {
    btnRefresh.classList.add('is-spinning');
    try {
      clearWeatherCache();
      await refreshAllViews();
    } catch (err) {
      console.error('Refresh views error:', err);
    } finally {
      setTimeout(() => {
        btnRefresh.classList.remove('is-spinning');
      }, 600);
    }
  });
}

/**
 * Refreshes current status, integrated card, map, journey card, and calendar
 */
export async function refreshAllViews() {
  const now = new Date();
  const statusData = determineCurrentStatus(now);

  // 1. Update Integrated Current Status Card
  await updateStatusCard(statusData, now);

  // 2. Update Map
  if (mapInitialized) {
    updateMapWithStatus(statusData);
  }

  // 3. Update CURRENT / NEXT JOURNEY card
  updateJourneyCard(now);

  // 4. Update Calendar View
  renderCalendar();
}

/**
 * Fast live tick without re-fetching network resources
 */
function updateLiveTick() {
  const now = new Date();
  const statusData = determineCurrentStatus(now);

  // 1. Meta live clock
  const metaLiveTimeEl = document.getElementById('meta-live-time-text');
  const metaTimes = formatMetaTime(now);
  if (metaLiveTimeEl) metaLiveTimeEl.textContent = metaTimes.liveStr;

  // 2. Digital clocks
  const destTimeEl = document.getElementById('status-dest-time');
  const destDateEl = document.getElementById('status-dest-date');
  const homeTimeEl = document.getElementById('status-home-time');

  const koreaTimes = formatTzDateTime(now, 'Asia/Seoul');
  const targetTz = statusData.airport && statusData.airport.tz ? statusData.airport.tz : 'Asia/Seoul';
  const targetTimes = formatTzDateTime(now, targetTz);

  if (statusData.status === STATUS_TYPES.IN_FLIGHT || statusData.status === STATUS_TYPES.OVERSEAS_STAY) {
    if (destTimeEl) destTimeEl.textContent = targetTimes.timeStr;
    if (destDateEl) destDateEl.textContent = targetTimes.dateStr;
    if (homeTimeEl) homeTimeEl.textContent = koreaTimes.timeStr;
  } else {
    if (destTimeEl) destTimeEl.textContent = koreaTimes.timeStr;
    if (destDateEl) destDateEl.textContent = koreaTimes.dateStr;
  }

  // 3. In-flight progress bar update
  const remainingEl = document.getElementById('status-remaining-time');
  if (statusData.status === STATUS_TYPES.IN_FLIGHT) {
    const progressFill = document.getElementById('status-progress-fill');
    const pct = Math.min(100, Math.max(0, Math.round((statusData.progress || 0) * 100)));
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (remainingEl) {
      remainingEl.textContent = statusData.remainingTimeText || '';
      remainingEl.style.display = 'inline-block';
    }
  } else {
    if (remainingEl) {
      remainingEl.textContent = '';
      remainingEl.style.display = 'none';
    }
  }

  // 4. Update map aircraft position & progress if in flight
  if (mapInitialized && statusData.status === STATUS_TYPES.IN_FLIGHT) {
    updateMapWithStatus(statusData, true);
  }
}

/**
 * Updates the single integrated status card:
 * Status badge, headline with highlighted city, subtitle, in-flight progress bar,
 * local and KST digital times with dates, weather icon, temp, description, and update time.
 */
async function updateStatusCard(statusData, now) {
  // 1. Top Meta Strip (Live Clock)
  const metaLiveTimeEl = document.getElementById('meta-live-time-text');
  const metaTimes = formatMetaTime(now);
  if (metaLiveTimeEl) metaLiveTimeEl.textContent = metaTimes.liveStr;

  // 2. Status Badge Pill
  const badgePill = document.getElementById('status-badge-pill');
  const badgeTextEl = document.getElementById('status-badge-text');
  if (badgePill && badgeTextEl) {
    badgeTextEl.textContent = statusData.badgeText || '예정상 비행 중';
    badgePill.className = `status-badge-pill badge-${statusData.badgeType || 'flight'}`;
  }

  // 3. Headline & Subtitle
  const titleEl = document.getElementById('status-card-title');
  const descEl = document.getElementById('status-card-desc');
  if (titleEl) {
    if (statusData.status === STATUS_TYPES.IN_FLIGHT) {
      if (statusData.isReturningToKorea) {
        titleEl.innerHTML = `엄마는 <span class="status-city-highlight">한국</span>으로 오고 있어요`;
      } else if (statusData.cityHighlight) {
        const dir = getDirectionParticle(statusData.cityHighlight);
        titleEl.innerHTML = `엄마는 <span class="status-city-highlight">${statusData.cityHighlight}</span>${dir} 날아가고 있어요`;
      } else {
        titleEl.textContent = statusData.title || '엄마의 일정을 확인하는 중...';
      }
    } else if (statusData.status === STATUS_TYPES.OVERSEAS_STAY && statusData.cityHighlight) {
      titleEl.innerHTML = `엄마는 <span class="status-city-highlight">${statusData.cityHighlight}</span>에 머무르고 있어요`;
    } else if (statusData.status === STATUS_TYPES.HOME) {
      titleEl.innerHTML = `엄마는 <span class="status-city-highlight">우리 집</span>에 있어요`;
    } else {
      titleEl.textContent = statusData.title || '엄마의 일정을 확인하는 중...';
    }
  }
  if (descEl) descEl.textContent = statusData.description;

  const remainingEl = document.getElementById('status-remaining-time');
  if (remainingEl) {
    if (statusData.status === STATUS_TYPES.IN_FLIGHT && statusData.remainingTimeText) {
      remainingEl.textContent = statusData.remainingTimeText;
      remainingEl.style.display = 'inline-block';
    } else {
      remainingEl.textContent = '';
      remainingEl.style.display = 'none';
    }
  }

  // 4. In-flight Progress Bar
  const progressContainer = document.getElementById('status-progress-container');
  const progressFill = document.getElementById('status-progress-fill');
  if (statusData.status === STATUS_TYPES.IN_FLIGHT) {
    if (progressContainer) progressContainer.style.display = 'block';
    const pct = Math.min(100, Math.max(0, Math.round((statusData.progress || 0) * 100)));
    if (progressFill) progressFill.style.width = `${pct}%`;
  } else {
    if (progressContainer) progressContainer.style.display = 'none';
  }

  // 5. Digital Clocks (Left Column)
  const destTimeLabel = document.getElementById('status-dest-time-label');
  const destTimeEl = document.getElementById('status-dest-time');
  const destDateEl = document.getElementById('status-dest-date');
  const homeBlock = document.getElementById('status-home-block');
  const homeTimeEl = document.getElementById('status-home-time');

  const koreaTimes = formatTzDateTime(now, 'Asia/Seoul');
  const targetTz = statusData.airport && statusData.airport.tz ? statusData.airport.tz : 'Asia/Seoul';
  const targetTimes = formatTzDateTime(now, targetTz);

  if (statusData.status === STATUS_TYPES.IN_FLIGHT || statusData.status === STATUS_TYPES.OVERSEAS_STAY) {
    const cityName = statusData.destCityName || '현지';
    if (destTimeLabel) destTimeLabel.textContent = `${cityName} 현지 시각`;
    if (destTimeEl) destTimeEl.textContent = targetTimes.timeStr;
    if (destDateEl) destDateEl.textContent = targetTimes.dateStr;

    if (homeBlock) homeBlock.style.display = 'block';
    if (homeTimeEl) homeTimeEl.textContent = koreaTimes.timeStr;
  } else {
    // HOME or UNKNOWN
    if (destTimeLabel) destTimeLabel.textContent = '우리 집 · 한국 시각';
    if (destTimeEl) destTimeEl.textContent = koreaTimes.timeStr;
    if (destDateEl) destDateEl.textContent = koreaTimes.dateStr;

    if (homeBlock) homeBlock.style.display = 'none';
  }

  // 6. Weather (Right Column)
  const weatherLabel = document.getElementById('status-weather-label');
  const weatherTempEl = document.getElementById('weather-temp');
  const weatherDescEl = document.getElementById('weather-desc');
  const weatherIconEl = document.getElementById('weather-icon');
  const weatherUpdatedEl = document.getElementById('weather-updated');

  if (weatherLabel) {
    if (statusData.status === STATUS_TYPES.IN_FLIGHT) {
      weatherLabel.textContent = `${statusData.destCityName || '도착지'} · 도착지 현재 날씨`;
    } else if (statusData.status === STATUS_TYPES.OVERSEAS_STAY) {
      weatherLabel.textContent = `${statusData.destCityName || '현지'} · 현지 현재 날씨`;
    } else if (statusData.status === STATUS_TYPES.HOME) {
      weatherLabel.textContent = '우리 집 · 현재 날씨';
    } else {
      weatherLabel.textContent = '현재 위치 날씨 안내';
    }
  }

  const targetAirport = statusData.weatherAirport;
  if (statusData.status === STATUS_TYPES.UNKNOWN) {
    if (weatherTempEl) weatherTempEl.textContent = '-';
    if (weatherDescEl) weatherDescEl.textContent = '일정 미등록';
    if (weatherIconEl) weatherIconEl.innerHTML = '';
    if (weatherUpdatedEl) weatherUpdatedEl.textContent = '-';
  } else if (targetAirport && typeof targetAirport.lat === 'number') {
    const weather = await fetchCurrentWeather(targetAirport.lat, targetAirport.lng);
    if (weatherTempEl) weatherTempEl.textContent = weather.tempText;
    if (weatherDescEl) weatherDescEl.textContent = weather.desc;
    if (weatherIconEl) weatherIconEl.innerHTML = weather.iconHtml;
    if (weatherUpdatedEl) weatherUpdatedEl.textContent = weather.updatedTime;
  } else {
    if (weatherTempEl) weatherTempEl.textContent = '확인 불가';
    if (weatherDescEl) weatherDescEl.textContent = '위치 정보 없음';
    if (weatherIconEl) weatherIconEl.innerHTML = '';
    if (weatherUpdatedEl) weatherUpdatedEl.textContent = '-';
  }
}

/**
 * Updates the NEXT JOURNEY / CURRENT JOURNEY card
 */
function updateJourneyCard(now) {
  const cardContainer = document.getElementById('journey-card-container');
  if (!cardContainer) return;

  const res = getCurrentOrNextJourney(now);

  if (res.type === 'NO_JOURNEY' || !res.journey) {
    cardContainer.innerHTML = `
      <div class="journey-empty-card">
        <span class="journey-badge-pill badge-none">여정 안내</span>
        <p class="journey-msg">${res.message || '예정된 여정이 없습니다.'}</p>
        <span class="subtext">한국 출발부터 귀국까지의 여정이 여기에 표시됩니다.</span>
      </div>
    `;
    return;
  }

  const j = res.journey;
  const isCurrent = res.isUnderway;

  cardContainer.innerHTML = `
    <div class="journey-active-card ${isCurrent ? 'is-current-journey' : 'is-next-journey'}">
      <div class="journey-card-header">
        <span class="journey-badge-pill ${res.badgeClass}">${res.label}</span>
        <span class="journey-route-text">${j.routeSummary}</span>
      </div>
      <div class="journey-card-body">
        <div class="journey-info-row">
          <div class="journey-info-item">
            <span class="info-label">한국 출발 (KST)</span>
            <span class="info-value">${j.depKstFormatted}</span>
          </div>
          <div class="journey-info-item">
            <span class="info-label">한국 도착 예정 (KST)</span>
            <span class="info-value ${!j.hasReturnFlight ? 'text-warning' : ''}">${j.arrKstFormatted}</span>
          </div>
        </div>
        <div class="journey-info-row secondary-row">
          <div class="journey-info-item">
            <span class="info-label">주요 목적지</span>
            <span class="info-value">${j.destinations}</span>
          </div>
          <div class="journey-info-item">
            <span class="info-label">비행 편명</span>
            <span class="info-value">${j.flightNumbers}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Start app on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
