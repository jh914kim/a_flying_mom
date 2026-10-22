/**
 * flying mom - Timezone & UTC Conversion Utilities
 * Handles IANA timezones, Daylight Saving Time (DST), and UTC conversions using native Intl API.
 */

import { getAirport, GWACHEON_BASE } from './airports.js';

const KOREA_TZ = 'Asia/Seoul';

/**
 * Parses a local datetime string (YYYY-MM-DDTHH:mm) in a given IANA timezone into a UTC Date.
 * Handles DST shifts and detects invalid/ambiguous times.
 * 
 * @param {string} localStr - 'YYYY-MM-DDTHH:mm'
 * @param {string} timeZone - e.g. 'Europe/London', 'Asia/Seoul', 'America/New_York'
 * @returns {{ date: Date, dstNotice: string|null, error: string|null }}
 */
export function parseLocalToUTC(localStr, timeZone = KOREA_TZ) {
  if (!localStr || typeof localStr !== 'string') {
    return { date: null, dstNotice: null, error: '날짜/시각 정보가 없습니다.' };
  }

  const parts = localStr.split('T');
  if (parts.length !== 2) {
    return { date: null, dstNotice: null, error: '날짜/시각 형식이 올바르지 않습니다.' };
  }

  const [datePart, timePart] = parts;
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, min] = timePart.split(':').map(Number);

  if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(min)) {
    return { date: null, dstNotice: null, error: '날짜/시각 숫자가 유효하지 않습니다.' };
  }

  try {
    // Initial guess assuming UTC
    const guessUtc = Date.UTC(year, month - 1, day, hour, min, 0);

    // Formatter for target timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });

    const getLocalFromTimestamp = (ts) => {
      const parts = formatter.formatToParts(new Date(ts));
      const map = {};
      for (const p of parts) {
        if (p.type !== 'literal') map[p.type] = parseInt(p.value, 10);
      }
      return Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second || 0);
    };

    // Calculate timezone offset at guess
    const localAtGuess = getLocalFromTimestamp(guessUtc);
    const offset = guessUtc - localAtGuess;
    let actualUtc = guessUtc + offset;

    // Verify and refine
    let verifiedLocal = getLocalFromTimestamp(actualUtc);
    let diff = guessUtc - verifiedLocal;

    if (diff !== 0) {
      actualUtc += diff;
      verifiedLocal = getLocalFromTimestamp(actualUtc);
      diff = guessUtc - verifiedLocal;
    }

    let dstNotice = null;
    // If still doesn't match, this is a non-existent spring-forward time during DST transition
    if (diff !== 0) {
      dstNotice = `해당 시각(${localStr})은 현지 서머타임 전환으로 존재하지 않는 시각(Gap)입니다. 현지 기준 유효 시간을 확인해주세요.`;
    }

    // Check for fall-back repetition (ambiguous time)
    // Check offsets 1 hour before and 1 hour after
    const offsetBefore = (guessUtc - 3600000) - getLocalFromTimestamp(guessUtc - 3600000);
    const offsetAfter = (guessUtc + 3600000) - getLocalFromTimestamp(guessUtc + 3600000);
    if (offsetBefore !== offsetAfter && !dstNotice) {
      dstNotice = `해당 시각은 서머타임 해제/적용 전환 구간에 걸쳐 있을 수 있습니다.`;
    }

    return { date: new Date(actualUtc), dstNotice, error: null };
  } catch (err) {
    return { date: null, dstNotice: null, error: `시간대 처리 오류: ${err.message}` };
  }
}

/**
 * Parses flight departure/arrival into UTC Date based on timeBasis
 * @param {string} timeStr - 'YYYY-MM-DDTHH:mm'
 * @param {string} airportCode - e.g. 'ICN', 'LHR'
 * @param {'local'|'korea'} timeBasis
 */
export function parseFlightTime(timeStr, airportCode, timeBasis = 'korea') {
  let targetTz = KOREA_TZ;
  if (timeBasis === 'local') {
    const airport = getAirport(airportCode);
    if (airport && airport.tz) {
      targetTz = airport.tz;
    }
  }
  return parseLocalToUTC(timeStr, targetTz);
}

/**
 * Format a Date object into 'YYYY-MM-DDTHH:mm' or human readable in given timezone
 */
export function formatInTz(date, timeZone = KOREA_TZ, options = {}) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return '';

  const {
    showSeconds = false,
    formatType = 'iso', // 'iso', 'short', 'full', 'timeOnly', 'dateOnly'
  } = options;

  try {
    const dtf = new Intl.DateTimeFormat('ko-KR', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: showSeconds ? '2-digit' : undefined,
      hour12: false
    });

    const parts = dtf.formatToParts(date);
    const p = {};
    for (const part of parts) {
      if (part.type !== 'literal') p[part.type] = part.value;
    }

    if (formatType === 'iso') {
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    }

    if (formatType === 'timeOnly') {
      return showSeconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
    }

    if (formatType === 'dateOnly') {
      return `${p.year}년 ${parseInt(p.month, 10)}월 ${parseInt(p.day, 10)}일`;
    }

    if (formatType === 'short') {
      return `${parseInt(p.month, 10)}/${parseInt(p.day, 10)} ${p.hour}:${p.minute}`;
    }

    // full
    const weekdayFmt = new Intl.DateTimeFormat('ko-KR', { timeZone, weekday: 'short' });
    const weekday = weekdayFmt.format(date);
    return `${p.year}년 ${parseInt(p.month, 10)}월 ${parseInt(p.day, 10)}일 (${weekday}) ${p.hour}:${p.minute}`;
  } catch (err) {
    console.error('formatInTz error:', err);
    return date.toISOString().slice(0, 16);
  }
}

/**
 * Get weekday name in timezone
 */
export function getWeekdayInTz(date, timeZone = KOREA_TZ) {
  try {
    return new Intl.DateTimeFormat('ko-KR', { timeZone, weekday: 'short' }).format(date);
  } catch {
    return '';
  }
}

/**
 * Formats 'YYYY-MM-DD' + weekday into Korean 'M월 D일 (요일)'
 */
export function formatKoreanMonthDayWeekday(dateObj, timeZone = KOREA_TZ) {
  if (!dateObj) return '';
  const iso = formatInTz(dateObj, timeZone, { formatType: 'iso' });
  const m = parseInt(iso.slice(5, 7), 10);
  const d = parseInt(iso.slice(8, 10), 10);
  const w = getWeekdayInTz(dateObj, timeZone);
  return `${m}월 ${d}일 (${w})`;
}

/**
 * Checks if two dates have the same calendar day in the given timezone
 */
export function isSameDayInTz(date1, date2, timeZone = KOREA_TZ) {
  if (!date1 || !date2) return false;
  const iso1 = formatInTz(date1, timeZone, { formatType: 'iso' }).slice(0, 10);
  const iso2 = formatInTz(date2, timeZone, { formatType: 'iso' }).slice(0, 10);
  return iso1 === iso2;
}

/**
 * Formats a display card time showing both local time and Korea time (if overseas)
 */
export function formatLocationTime(date, airport) {
  const isHome = !airport || airport.code === 'HOME' || airport.tz === KOREA_TZ;
  const tz = airport && airport.tz ? airport.tz : KOREA_TZ;

  const localTimeStr = formatInTz(date, tz, { formatType: 'full' });
  const kstTimeStr = !isHome ? formatInTz(date, KOREA_TZ, { formatType: 'full' }) : null;

  return {
    isHome,
    localTimeStr,
    kstTimeStr,
    timeZoneName: tz
  };
}

/**
 * Formats time and date for digital clock display in specific timezone
 * @param {Date} date
 * @param {string} timeZone
 * @returns {{ timeStr: string, dateStr: string }}
 */
export function formatTzDateTime(date, timeZone = KOREA_TZ) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || KOREA_TZ,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date);

    const p = {};
    for (const part of parts) {
      p[part.type] = part.value;
    }

    const weekdayFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: timeZone || KOREA_TZ, weekday: 'short' });
    const weekday = weekdayFmt.format(date);

    const hh = String(p.hour || '00').padStart(2, '0');
    const mm = String(p.minute || '00').padStart(2, '0');

    return {
      timeStr: `${hh}:${mm}`,
      dateStr: `${p.month}월 ${p.day}일 (${weekday})`
    };
  } catch (err) {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
    return {
      timeStr: `${hh}:${mm}`,
      dateStr: `${date.getMonth() + 1}월 ${date.getDate()}일 (${weekdays[date.getDay()]})`
    };
  }
}

/**
 * Formats live clock and storage timestamp for top meta strip
 * @param {Date} date
 * @returns {{ liveStr: string, storageStr: string }}
 */
export function formatMetaTime(date = new Date()) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const w = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');

  return {
    liveStr: `${m}월 ${d}일 (${w}) · ${hh}:${mm}`,
    storageStr: `${m}월 ${d}일 (${w}) ${hh}:${mm}`
  };
}
