/**
 * a flying mom - Open-Meteo Weather Service
 * Free API-key-free weather fetching with 10-minute client caching.
 * Translates WMO weather codes to Korean descriptions and SVG icons.
 * Gracefully reports "확인 불가" on network or parsing failure.
 */

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const weatherCache = new Map();

/**
 * Maps WMO weather interpretation codes to Korean descriptions & SVG icons
 */
export function getWeatherMeta(code) {
  // WMO Weather interpretation codes (WW)
  switch (code) {
    case 0:
      return {
        text: '맑음',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="1" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
      };
    case 1:
      return {
        text: '대체로 맑음',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`
      };
    case 2:
      return {
        text: '구름 조금',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`
      };
    case 3:
      return {
        text: '흐림',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><path d="M22 10a3 3 0 0 0-3-3h-1.5"/></svg>`
      };
    case 45:
    case 48:
      return {
        text: '안개',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="13" x2="21" y2="13"/><line x1="5" y1="17" x2="19" y2="17"/></svg>`
      };
    case 51:
    case 53:
    case 55:
      return {
        text: '이슬비',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><line x1="8" y1="21" x2="8" y2="23"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="16" y1="21" x2="16" y2="23"/></svg>`
      };
    case 61:
    case 63:
    case 65:
      return {
        text: '비',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><line x1="8" y1="20" x2="6" y2="23"/><line x1="12" y1="20" x2="10" y2="23"/><line x1="16" y1="20" x2="14" y2="23"/></svg>`
      };
    case 71:
    case 73:
    case 75:
    case 77:
      return {
        text: '눈',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#93c5fd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><line x1="8" y1="21" x2="8" y2="21.01"/><line x1="12" y1="21" x2="12" y2="21.01"/><line x1="16" y1="21" x2="16" y2="21.01"/></svg>`
      };
    case 80:
    case 81:
    case 82:
      return {
        text: '소나기',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#1d4ed8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><line x1="8" y1="20" x2="7" y2="23"/><line x1="12" y1="20" x2="11" y2="23"/><line x1="16" y1="20" x2="15" y2="23"/></svg>`
      };
    case 95:
    case 96:
    case 99:
      return {
        text: '뇌우',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polygon points="13 14 10 19 14 19 11 23"/></svg>`
      };
    default:
      return {
        text: '구름 많음',
        icon: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`
      };
  }
}

/**
 * Fetch current weather from Open-Meteo with 10-minute cache
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{ available: boolean, tempText: string, desc: string, iconHtml: string, updatedTime: string }>}
 */
export async function fetchCurrentWeather(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
    return {
      available: false,
      tempText: '확인 불가',
      desc: '위치 정보 없음',
      iconHtml: '',
      updatedTime: '-'
    };
  }

  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = weatherCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=temperature_2m,weather_code&timezone=auto`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }

    const data = await res.json();
    if (!data || !data.current) {
      throw new Error('Invalid weather response payload');
    }

    const temp = Math.round(data.current.temperature_2m);
    const code = data.current.weather_code;
    const meta = getWeatherMeta(code);

    const updateDate = new Date();
    const updatedTime = `${String(updateDate.getHours()).padStart(2, '0')}:${String(updateDate.getMinutes()).padStart(2, '0')} 한국 기준 갱신`;

    const result = {
      available: true,
      tempText: `${temp}°`,
      desc: meta.text,
      iconHtml: meta.icon,
      updatedTime
    };

    weatherCache.set(cacheKey, { timestamp: now, data: result });
    return result;
  } catch (err) {
    console.warn('Weather fetch failed, displaying 확인 불가:', err.message);
    return {
      available: false,
      tempText: '확인 불가',
      desc: '날씨 정보 연결 불가',
      iconHtml: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#9ca3af" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
      updatedTime: '-'
    };
  }
}
