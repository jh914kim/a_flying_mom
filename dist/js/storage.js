/**
 * flying mom - Local Storage Manager
 * Handles client-side persistent storage per month, backup/restore with deep JSON schema validation,
 * atomic transactions, quota error catching, and cross-tab synchronization.
 */

import { getAirport } from './airports.js';

const STORAGE_KEY_PREFIX = 'flyingmom_schedule_';
const STORAGE_INDEX_KEY = 'flyingmom_months_index';
const STORAGE_SETTINGS_KEY = 'flyingmom_settings';

// Storage change listener registry
const changeListeners = new Set();

/**
 * Initialize cross-tab storage sync
 */
export function initStorageSync(callback) {
  if (typeof callback === 'function') {
    changeListeners.add(callback);
  }
  
  window.addEventListener('storage', (event) => {
    if (event.key && (event.key.startsWith(STORAGE_KEY_PREFIX) || event.key === STORAGE_INDEX_KEY)) {
      notifyChangeListeners({ type: 'storage_event', key: event.key });
    }
  });
}

export function subscribeStorageChanges(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function notifyChangeListeners(detail) {
  for (const fn of changeListeners) {
    try {
      fn(detail);
    } catch (e) {
      console.error('Storage listener error:', e);
    }
  }
}

/**
 * Get all stored month keys (e.g. ['2026-10', '2026-11']) sorted ascending
 */
export function getSavedMonths() {
  try {
    const raw = localStorage.getItem(STORAGE_INDEX_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.sort();
  } catch (err) {
    console.error('Failed to read months index:', err);
    return [];
  }
}

/**
 * Get schedule for a specific month YYYY-MM
 * @param {string} monthStr - 'YYYY-MM'
 * @returns {Object|null}
 */
export function getMonthSchedule(monthStr) {
  if (!monthStr) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + monthStr);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read schedule for month ${monthStr}:`, err);
    return null;
  }
}

/**
 * Deep validation of a flight object
 */
export function validateFlight(flight, index = 0) {
  const errors = [];
  if (!flight || typeof flight !== 'object') {
    return [`${index + 1}번 행: 유효하지 않은 비행 데이터 형식입니다.`];
  }

  const { number, from, to, departure, arrival } = flight;

  if (!number || typeof number !== 'string' || !number.trim()) {
    errors.push(`${index + 1}번 행: 편명을 입력해주세요.`);
  }

  if (!from || typeof from !== 'string' || !/^[A-Za-z]{3}$/.test(from.trim())) {
    errors.push(`${index + 1}번 행: 출발 공항 3자리 IATA 코드를 올바르게 입력해주세요 (예: ICN).`);
  } else if (!getAirport(from.trim())) {
    errors.push(`${index + 1}번 행: 출발 공항(${from.trim().toUpperCase()})은 등록되지 않은 IATA 공항 코드입니다.`);
  }

  if (!to || typeof to !== 'string' || !/^[A-Za-z]{3}$/.test(to.trim())) {
    errors.push(`${index + 1}번 행: 도착 공항 3자리 IATA 코드를 올바르게 입력해주세요 (예: LHR).`);
  } else if (!getAirport(to.trim())) {
    errors.push(`${index + 1}번 행: 도착 공항(${to.trim().toUpperCase()})은 등록되지 않은 IATA 공항 코드입니다.`);
  }

  if (from && to && from.trim().toUpperCase() === to.trim().toUpperCase() && number.trim().toUpperCase() !== 'STBY') {
    errors.push(`${index + 1}번 행: 출발 공항과 도착 공항이 동일합니다.`);
  }

  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  if (!departure || !isoRegex.test(departure)) {
    errors.push(`${index + 1}번 행: 출발 날짜/시각을 YYYY-MM-DDTHH:mm 형식으로 입력해주세요.`);
  }

  if (!arrival || !isoRegex.test(arrival)) {
    errors.push(`${index + 1}번 행: 도착 날짜/시각을 YYYY-MM-DDTHH:mm 형식으로 입력해주세요.`);
  }

  return errors;
}

/**
 * Deep validation of a monthly schedule bundle
 */
export function validateMonthSchedule(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['데이터 형식이 올바르지 않습니다.'] };
  }

  if (!data.month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month)) {
    errors.push('연월 형식(YYYY-MM)이 올바르지 않습니다.');
  }

  if (!data.home || typeof data.home !== 'string') {
    errors.push('기준 거점 공항이 지정되지 않았습니다.');
  }

  if (!['local', 'korea'].includes(data.timeBasis)) {
    errors.push('시간 기준 설정(local 또는 korea)이 올바르지 않습니다.');
  }

  if (!Array.isArray(data.flights)) {
    errors.push('비행 목록이 배열 형식이 아닙니다.');
  } else {
    data.flights.forEach((f, idx) => {
      const flightErrors = validateFlight(f, idx);
      errors.push(...flightErrors);
    });

    // Validation rule: STBY (standby duty) must never overlap with flight schedules
    data.flights.forEach((f, idx) => {
      if ((f.number || '').trim().toUpperCase() === 'STBY') {
        const stbyDate = (f.departure || '').slice(0, 10);
        data.flights.forEach((other, oIdx) => {
          if (idx === oIdx || (other.number || '').trim().toUpperCase() === 'STBY') return;
          const depDate = (other.departure || '').slice(0, 10);
          const arrDate = (other.arrival || '').slice(0, 10);
          if (stbyDate && (stbyDate === depDate || stbyDate === arrDate)) {
            errors.push(`${idx + 1}번 행: 대기(STBY) 일정이 ${other.number} 비행(${depDate})과 같은 날짜에 겹칩니다.`);
          }
        });
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Save schedule for a specific month.
 * Overwrites that specific month while keeping other months intact.
 * Throws on storage quota or access restriction without displaying false success.
 */
export function saveMonthSchedule(schedule) {
  const validation = validateMonthSchedule(schedule);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  const month = schedule.month;
  const key = STORAGE_KEY_PREFIX + month;
  const payload = JSON.stringify({
    month: schedule.month,
    home: schedule.home.toUpperCase(),
    timeBasis: schedule.timeBasis,
    flights: schedule.flights.map(f => ({
      number: f.number.trim().toUpperCase(),
      from: f.from.trim().toUpperCase(),
      to: f.to.trim().toUpperCase(),
      departure: f.departure.trim(),
      arrival: f.arrival.trim()
    })),
    updatedAt: new Date().toISOString()
  });

  try {
    // Check if test write succeeds (catch QuotaExceededError)
    localStorage.setItem(key, payload);

    // Update index
    const months = new Set(getSavedMonths());
    months.add(month);
    localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(Array.from(months).sort()));

    // Record last saved timestamp
    localStorage.setItem('aflyingmom_last_saved', new Date().toISOString());

    notifyChangeListeners({ type: 'month_saved', month });
    return { success: true };
  } catch (err) {
    console.error('Storage quota or access error:', err);
    let msg = '브라우저 저장 공간이 부족하거나 저장 권한이 제한되어 저장에 실패했습니다.';
    if (err.name === 'QuotaExceededError') {
      msg = '브라우저 저장소 용량이 초과되었습니다. 이전 달 일정을 정리하거나 브라우저 용량을 확보해주세요.';
    }
    return { success: false, errors: [msg] };
  }
}

/**
 * Delete schedule for a specific month
 */
export function deleteMonthSchedule(monthStr) {
  if (!monthStr) return false;
  try {
    localStorage.removeItem(STORAGE_KEY_PREFIX + monthStr);
    const months = getSavedMonths().filter(m => m !== monthStr);
    localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(months));
    notifyChangeListeners({ type: 'month_deleted', month: monthStr });
    return true;
  } catch (err) {
    console.error('Failed to delete month schedule:', err);
    return false;
  }
}

/**
 * Get all flights across all saved months, sorted chronologically
 */
export function getAllSavedSchedules() {
  const months = getSavedMonths();
  const allMonths = [];
  for (const m of months) {
    const s = getMonthSchedule(m);
    if (s) allMonths.push(s);
  }
  return allMonths;
}

/**
 * Returns Date of last save to localStorage, or null
 */
export function getLastSavedDate() {
  try {
    const raw = localStorage.getItem('aflyingmom_last_saved');
    if (raw) {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return d;
    }
  } catch {}
  return null;
}

