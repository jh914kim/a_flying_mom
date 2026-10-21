/**
 * a flying mom - Schedule Manager Modal & Editor
 * Fullscreen mobile responsive editor, photo OCR import, text paste parser,
 * JSON backup/restore with deep verification, row numbering, uncertainty highlights,
 * field jump-on-error, and confirmation guard checkbox.
 */

import {
  saveMonthSchedule,
  deleteMonthSchedule,
  getMonthSchedule,
  validateMonthSchedule
} from './storage.js';
import { searchAirports, getAirport, KOREA_BASES } from './airports.js';
import { recognizeSchedulePhoto, parseScheduleText, getSampleSchedule } from './ocr.js';
import { refreshAllViews } from './app.js';

let currentEditingMonth = ''; // 'YYYY-MM'
let flightRows = []; // [{ number, from, to, departure, arrival, isUncertain }]
let isModalOpen = false;

/**
 * Synchronize current input field values from DOM into flightRows array
 */
function syncDOMToFlightRows() {
  for (let i = 0; i < flightRows.length; i++) {
    const numEl = document.getElementById(`flt-num-${i}`);
    const fromEl = document.getElementById(`flt-from-${i}`);
    const toEl = document.getElementById(`flt-to-${i}`);
    const depEl = document.getElementById(`flt-dep-${i}`);
    const arrEl = document.getElementById(`flt-arr-${i}`);

    if (numEl) flightRows[i].number = numEl.value.trim().toUpperCase();
    if (fromEl) flightRows[i].from = fromEl.value.trim().toUpperCase();
    if (toEl) flightRows[i].to = toEl.value.trim().toUpperCase();
    if (depEl) flightRows[i].departure = depEl.value.trim();
    if (arrEl) flightRows[i].arrival = arrEl.value.trim();
  }
}

/**
 * Open the Schedule Management Modal
 */
export function openManagerModal(defaultMonth = null) {
  const modal = document.getElementById('manager-modal');
  if (!modal) return;

  const now = new Date();
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  currentEditingMonth = defaultMonth || currentMonthStr;

  // Initialize input values
  const monthInput = document.getElementById('mgmt-month-input');
  if (monthInput) monthInput.value = currentEditingMonth;

  loadMonthIntoEditor(currentEditingMonth);

  modal.classList.add('is-active');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  isModalOpen = true;
}

/**
 * Close the modal
 */
export function closeManagerModal() {
  const modal = document.getElementById('manager-modal');
  if (!modal) return;
  modal.classList.remove('is-active');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  isModalOpen = false;
}

/**
 * Loads an existing month schedule from localStorage into the editor
 */
export function loadMonthIntoEditor(yearMonth) {
  currentEditingMonth = yearMonth;

  // Keep download button label concise
  const downloadLabel = document.getElementById('btn-download-month-label');
  if (downloadLabel) {
    downloadLabel.textContent = '파일 내려받기';
  }

  const existing = getMonthSchedule(yearMonth);
  const timeBasisSelect = document.getElementById('mgmt-timebasis-select');
  const homeSelect = document.getElementById('mgmt-home-select');
  const confirmCheck = document.getElementById('mgmt-confirm-check');
  const saveBtn = document.getElementById('mgmt-save-btn');

  if (confirmCheck) confirmCheck.checked = false;
  if (saveBtn) saveBtn.disabled = true;

  if (existing) {
    // Default timeBasis to 'local' ("각 공항 현지 시간")
    const basis = existing.timeBasis === 'korea' ? 'local' : (existing.timeBasis || 'local');
    if (timeBasisSelect) timeBasisSelect.value = basis;
    if (homeSelect) homeSelect.value = existing.home || 'ICN';
    flightRows = (existing.flights || []).map(f => ({
      ...f,
      isUncertain: { number: false, from: false, to: false, departure: false, arrival: false }
    }));
  } else {
    // Blank state for new month: default timeBasis to local
    if (timeBasisSelect) timeBasisSelect.value = 'local';
    flightRows = [];
  }

  renderFlightRows();
}

/**
 * Renders flight rows table/cards
 */
export function renderFlightRows() {
  const container = document.getElementById('mgmt-flight-rows-container');
  if (!container) return;

  container.innerHTML = '';

  if (flightRows.length === 0) {
    container.innerHTML = `
      <div class="empty-editor-notice">
        <p>비행 일정이 비어 있습니다. 사진을 업로드하거나 직접 추가해주세요.</p>
        <div class="empty-editor-actions">
          <button type="button" class="btn btn-outline" id="btn-add-first-row">+ 첫 비행 직접 추가</button>
        </div>
      </div>
    `;

    document.getElementById('btn-add-first-row')?.addEventListener('click', () => {
      addNewRow();
    });

    return;
  }

  flightRows.forEach((row, idx) => {
    const rowEl = createFlightRowElement(row, idx);
    container.appendChild(rowEl);
  });
}

/**
 * Creates single flight row DOM element with 1, 2, 3 numbering and uncertain highlight
 */
function createFlightRowElement(row, idx) {
  const card = document.createElement('div');
  const unc = row.isUncertain || {};
  const hasAnyUncertain = Boolean(unc.number || unc.from || unc.to || unc.departure || unc.arrival);
  const hasMissingOrInvalid =
    !row.number ||
    !row.from || !getAirport(row.from) ||
    !row.to || !getAirport(row.to) ||
    !row.departure ||
    !row.arrival;

  card.className = `mgmt-row-card${hasMissingOrInvalid ? ' row-error' : ''}`;
  card.id = `flight-row-${idx}`;

  card.innerHTML = `
    <div class="mgmt-row-header">
      <div class="mgmt-row-header-left">
        <span class="row-num-badge">${idx + 1}번 ${row.number === 'STBY' ? '대기(STBY)' : '비행'}</span>
        <div class="mgmt-flt-num-inline">
          <label for="flt-num-${idx}">편명</label>
          <input type="text" id="flt-num-${idx}" class="form-input form-input-compact ${unc.number ? 'highlight-uncertain' : ''} ${!row.number ? 'field-error' : ''}" 
                 value="${row.number || ''}" placeholder="예: 272" maxlength="10">
        </div>
        ${hasAnyUncertain ? '<span class="uncertain-badge" style="font-size:11px; background:#FEF7E0; color:#B06000; border:1px solid #FBC02D; border-radius:4px; padding:2px 6px; font-weight:600;">확인 필요</span>' : ''}
      </div>
      <button type="button" class="btn-delete-row" data-idx="${idx}" title="삭제" aria-label="${idx + 1}번 비행 삭제">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="mgmt-row-body">
      <!-- 출발 라인: 출발 공항 + 출발 날짜/시각 -->
      <div class="mgmt-flight-line">
        <div class="form-group autocomplete-wrapper mgmt-col-airport">
          <label for="flt-from-${idx}">출발 공항</label>
          <input type="text" id="flt-from-${idx}" class="form-input form-input-compact ${unc.from ? 'highlight-uncertain' : ''} ${(!row.from || !getAirport(row.from)) ? 'field-error' : ''}" 
                 value="${row.from || ''}" placeholder="예: ICN" maxlength="3" uppercase>
          <div class="autocomplete-dropdown" id="dropdown-from-${idx}"></div>
        </div>
        <div class="form-group mgmt-col-datetime">
          <label for="flt-dep-${idx}">출발 날짜/시각</label>
          <input type="datetime-local" id="flt-dep-${idx}" class="form-input form-input-compact ${unc.departure ? 'highlight-uncertain' : ''} ${!row.departure ? 'field-error' : ''}" 
                 value="${row.departure || ''}">
        </div>
      </div>
      <!-- 도착 라인: 도착 공항 + 도착 날짜/시각 -->
      <div class="mgmt-flight-line">
        <div class="form-group autocomplete-wrapper mgmt-col-airport">
          <label for="flt-to-${idx}">도착 공항</label>
          <input type="text" id="flt-to-${idx}" class="form-input form-input-compact ${unc.to ? 'highlight-uncertain' : ''} ${(!row.to || !getAirport(row.to)) ? 'field-error' : ''}" 
                 value="${row.to || ''}" placeholder="예: SEA" maxlength="3" uppercase>
          <div class="autocomplete-dropdown" id="dropdown-to-${idx}"></div>
        </div>
        <div class="form-group mgmt-col-datetime">
          <label for="flt-arr-${idx}">도착 날짜/시각</label>
          <input type="datetime-local" id="flt-arr-${idx}" class="form-input form-input-compact ${unc.arrival ? 'highlight-uncertain' : ''} ${!row.arrival ? 'field-error' : ''}" 
                 value="${row.arrival || ''}">
        </div>
      </div>
    </div>
  `;

  // Attach input listeners
  const numInput = card.querySelector(`#flt-num-${idx}`);
  numInput.oninput = (e) => {
    flightRows[idx].number = e.target.value.toUpperCase();
    flightRows[idx].isUncertain.number = false;
    numInput.classList.remove('highlight-uncertain', 'field-error');
  };

  const fromInput = card.querySelector(`#flt-from-${idx}`);
  setupAirportAutocomplete(fromInput, card.querySelector(`#dropdown-from-${idx}`), (code) => {
    flightRows[idx].from = code;
    flightRows[idx].isUncertain.from = false;
    fromInput.classList.remove('highlight-uncertain', 'field-error');
  });

  const toInput = card.querySelector(`#flt-to-${idx}`);
  setupAirportAutocomplete(toInput, card.querySelector(`#dropdown-to-${idx}`), (code) => {
    flightRows[idx].to = code;
    flightRows[idx].isUncertain.to = false;
    toInput.classList.remove('highlight-uncertain', 'field-error');
  });

  const depInput = card.querySelector(`#flt-dep-${idx}`);
  depInput.onchange = (e) => {
    flightRows[idx].departure = e.target.value;
    flightRows[idx].isUncertain.departure = false;
    depInput.classList.remove('highlight-uncertain', 'field-error');
  };

  const arrInput = card.querySelector(`#flt-arr-${idx}`);
  arrInput.onchange = (e) => {
    flightRows[idx].arrival = e.target.value;
    flightRows[idx].isUncertain.arrival = false;
    arrInput.classList.remove('highlight-uncertain', 'field-error');
  };

  // Delete button
  const delBtn = card.querySelector('.btn-delete-row');
  delBtn.onclick = () => {
    syncDOMToFlightRows();
    flightRows.splice(idx, 1);
    renderFlightRows();
  };

  return card;
}

/**
 * Setup lightweight airport autocomplete dropdown
 */
function setupAirportAutocomplete(inputEl, dropdownEl, onSelect) {
  if (!inputEl || !dropdownEl) return;

  const handleInput = () => {
    const val = inputEl.value.trim().toUpperCase();
    inputEl.value = val;
    onSelect(val);

    if (val.length < 1) {
      dropdownEl.style.display = 'none';
      return;
    }

    const matches = searchAirports(val, 6);
    if (matches.length === 0) {
      dropdownEl.style.display = 'none';
      return;
    }

    dropdownEl.innerHTML = '';
    for (const a of matches) {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.innerHTML = `<strong>${a.code}</strong> · ${a.city} <span class="country-sub">(${a.country})</span>`;
      item.onmousedown = (e) => {
        e.preventDefault();
        inputEl.value = a.code;
        onSelect(a.code);
        dropdownEl.style.display = 'none';
      };
      dropdownEl.appendChild(item);
    }
    dropdownEl.style.display = 'block';
  };

  inputEl.addEventListener('input', handleInput);
  inputEl.addEventListener('focus', handleInput);
  inputEl.addEventListener('blur', () => {
    setTimeout(() => { dropdownEl.style.display = 'none'; }, 200);
  });
}

/**
 * Add new empty row to editor
 */
export function addNewRow() {
  syncDOMToFlightRows();

  const [y, m] = currentEditingMonth.split('-');
  const defaultDep = `${y}-${m}-01T09:00`;
  const defaultArr = `${y}-${m}-01T12:00`;

  flightRows.push({
    number: '',
    from: 'ICN',
    to: '',
    departure: defaultDep,
    arrival: defaultArr,
    isUncertain: { number: false, from: false, to: false, departure: false, arrival: false }
  });

  renderFlightRows();

  // Scroll to bottom
  const container = document.getElementById('mgmt-flight-rows-container');
  if (container) {
    container.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
  }
}

/**
 * Validates form inputs and jumps to the first error with visual focus and error message
 */
function validateAndHighlightErrors() {
  // Clear previous error styles
  document.querySelectorAll('.field-error, .row-error').forEach(el => {
    el.classList.remove('field-error', 'row-error');
  });

  if (flightRows.length === 0) {
    alert('등록할 비행 일정이 최소 1개 이상 필요합니다.');
    return false;
  }

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const rowCard = document.getElementById(`flight-row-${i}`);

    const markError = (inputId, message) => {
      if (rowCard) rowCard.classList.add('row-error');
      const input = document.getElementById(inputId);
      if (input) {
        input.classList.add('field-error');
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      alert(`${i + 1}번 비행 오류: ${message}`);
    };

    if (!row.number || !row.number.trim()) {
      markError(`flt-num-${i}`, '편명을 입력해주세요 (예: KE907).');
      return false;
    }

    if (!row.from || !/^[A-Za-z]{3}$/.test(row.from.trim()) || !getAirport(row.from.trim())) {
      markError(`flt-from-${i}`, '유효한 출발 공항 IATA 3자리 코드를 입력해주세요 (예: ICN).');
      return false;
    }

    if (!row.to || !/^[A-Za-z]{3}$/.test(row.to.trim()) || !getAirport(row.to.trim())) {
      markError(`flt-to-${i}`, '유효한 도착 공항 IATA 3자리 코드를 입력해주세요 (예: LHR).');
      return false;
    }

    if (row.from.trim().toUpperCase() === row.to.trim().toUpperCase() && row.number.trim().toUpperCase() !== 'STBY') {
      markError(`flt-to-${i}`, '출발 공항과 도착 공항이 동일합니다.');
      return false;
    }

    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    if (!row.departure || !isoRegex.test(row.departure)) {
      markError(`flt-dep-${i}`, '출발 날짜/시각을 올바르게 선택해주세요.');
      return false;
    }

    if (!row.arrival || !isoRegex.test(row.arrival)) {
      markError(`flt-arr-${i}`, '도착 날짜/시각을 올바르게 선택해주세요.');
      return false;
    }
  }

  // Validate STBY does not conflict with active flight schedules
  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    if (row.number.trim().toUpperCase() === 'STBY') {
      const stbyDate = (row.departure || '').slice(0, 10);
      for (let j = 0; j < flightRows.length; j++) {
        if (i === j) continue;
        const other = flightRows[j];
        if (other.number.trim().toUpperCase() === 'STBY') continue;
        const otherDepDate = (other.departure || '').slice(0, 10);
        const otherArrDate = (other.arrival || '').slice(0, 10);
        if (stbyDate && (stbyDate === otherDepDate || stbyDate === otherArrDate)) {
          markError(`flt-dep-${i}`, `대기(STBY) 일정이 ${other.number} 비행(${otherDepDate})과 같은 날짜에 겹칩니다.`);
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Save schedule handler
 */
export function handleSaveSchedule() {
  syncDOMToFlightRows();

  const confirmCheck = document.getElementById('mgmt-confirm-check');
  if (!confirmCheck || !confirmCheck.checked) {
    alert('하단의 "공항, 출발·도착 날짜와 시간 기준을 확인했어요" 확인란에 체크해주세요.');
    return;
  }

  // If user removed all rows and wants to save:
  if (flightRows.length === 0) {
    if (confirm(`등록된 비행 일정이 없습니다. ${currentEditingMonth}의 일정을 삭제(비움) 처리하시겠습니까?`)) {
      deleteMonthSchedule(currentEditingMonth);
      closeManagerModal();
      refreshAllViews();
      alert(`${currentEditingMonth} 일정이 삭제되었습니다.`);
    }
    return;
  }

  if (!validateAndHighlightErrors()) {
    return;
  }

  const timeBasisSelect = document.getElementById('mgmt-timebasis-select');
  const homeSelect = document.getElementById('mgmt-home-select');

  const schedulePayload = {
    month: currentEditingMonth,
    home: homeSelect ? homeSelect.value : 'ICN',
    timeBasis: timeBasisSelect ? timeBasisSelect.value : 'local',
    flights: flightRows
  };

  const result = saveMonthSchedule(schedulePayload);
  if (result.success) {
    alert(`${currentEditingMonth} 일정이 브라우저에 안전하게 저장되었습니다.`);
    closeManagerModal();
    refreshAllViews();
  } else {
    alert(`저장 실패: \n${result.errors.join('\n')}`);
  }
}

/**
 * Export current month schedule as JSON file for sending to kid's phone
 */
export function handleDownloadMonthJson() {
  syncDOMToFlightRows();

  const existing = getMonthSchedule(currentEditingMonth);
  let flightsToExport = [];

  if (flightRows.length > 0) {
    flightsToExport = flightRows.map(f => ({
      number: (f.number || '').trim().toUpperCase(),
      from: (f.from || '').trim().toUpperCase(),
      to: (f.to || '').trim().toUpperCase(),
      departure: (f.departure || '').trim(),
      arrival: (f.arrival || '').trim()
    }));
  } else if (existing && existing.flights && existing.flights.length > 0) {
    flightsToExport = existing.flights;
  }

  if (flightsToExport.length === 0) {
    alert(`내려받을 ${currentEditingMonth} 비행 일정이 없습니다.\n비행 일정을 먼저 추가하거나 등록해주세요.`);
    return;
  }

  const timeBasisSelect = document.getElementById('mgmt-timebasis-select');
  const homeSelect = document.getElementById('mgmt-home-select');

  const bundle = {
    app: 'aflyingmom',
    version: '1.0',
    month: currentEditingMonth,
    home: (homeSelect?.value || existing?.home || 'ICN').toUpperCase(),
    timeBasis: (timeBasisSelect?.value || existing?.timeBasis || 'local'),
    exportedAt: new Date().toISOString(),
    flights: flightsToExport
  };

  try {
    const jsonStr = JSON.stringify(bundle, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flyingmom-schedule-${currentEditingMonth}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    alert(`✅ ${currentEditingMonth} 비행 일정 파일이 저장되었습니다!\n\n파일명: flyingmom-schedule-${currentEditingMonth}.json (${bundle.flights.length}편)\n\n이 파일을 카카오톡이나 메시지로 아이(키즈폰)에게 보내주세요.`);
  } catch (err) {
    console.error('JSON export error:', err);
    alert(`파일 다운로드 실패: ${err.message}`);
  }
}

/**
 * Import monthly schedule from JSON file (Kids phone or parent file restore)
 */
export async function handleUploadMonthJson(file) {
  if (!file) return;

  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      alert('올바른 JSON 파일 형식이 아닙니다. 부모님이 보내준 비행일정 파일(.json)인지 확인해주세요.');
      return;
    }

    if (!data || typeof data !== 'object') {
      alert('파일 내용이 비어있거나 형식이 올바르지 않습니다.');
      return;
    }

    // Default missing fields gracefully
    if (!data.home) data.home = 'ICN';
    if (!data.timeBasis || !['local', 'korea'].includes(data.timeBasis)) {
      data.timeBasis = 'local';
    }

    const validation = validateMonthSchedule(data);
    if (!validation.valid) {
      alert(`일정 파일 내용에 오류가 있어 등록할 수 없습니다:\n\n${validation.errors.join('\n')}`);
      return;
    }

    const existing = getMonthSchedule(data.month);
    const flightCount = data.flights.length;
    const parts = data.month.split('-');
    const monthKor = parts.length === 2 ? `${parts[0]}년 ${parseInt(parts[1], 10)}월` : data.month;

    const confirmMsg = existing
      ? `📅 ${monthKor} 일정 (${flightCount}건)을 등록하시겠습니까?\n(기존에 등록되어 있던 일정을 새 일정으로 덮어씁니다)`
      : `📅 ${monthKor} 비행 일정 (${flightCount}건)을 등록하시겠습니까?`;

    if (!confirm(confirmMsg)) {
      return;
    }

    const saveResult = saveMonthSchedule(data);
    if (!saveResult.success) {
      alert(`저장 실패:\n${saveResult.errors.join('\n')}`);
      return;
    }

    // If modal is open, reload into editor
    if (isModalOpen) {
      const monthInput = document.getElementById('mgmt-month-input');
      if (monthInput) monthInput.value = data.month;
      loadMonthIntoEditor(data.month);
    }

    // Refresh calendar & all views
    refreshAllViews();

    alert(`🎉 ${monthKor} 비행 일정(${flightCount}편)이 성공적으로 등록되었습니다!\n\n달력과 홈 화면에서 엄마의 위치를 바로 확인해 보세요.`);
  } catch (err) {
    console.error('JSON upload error:', err);
    alert(`파일을 읽는 도중 오류가 발생했습니다: ${err.message}`);
  }
}

/**
 * Setup all manager modal event listeners (OCR upload, text paste modal)
 */
export function initManagerListeners() {
  // Modal open buttons
  document.querySelectorAll('[data-action="open-manager"]').forEach(btn => {
    btn.onclick = () => openManagerModal();
  });

  // Modal close buttons
  document.querySelectorAll('[data-action="close-manager"]').forEach(btn => {
    btn.onclick = () => closeManagerModal();
  });

  // Month change input
  const monthInput = document.getElementById('mgmt-month-input');
  if (monthInput) {
    monthInput.onchange = (e) => {
      loadMonthIntoEditor(e.target.value);
    };
  }

  // Add Row button
  document.getElementById('btn-add-row')?.addEventListener('click', () => {
    addNewRow();
  });

  // Clear all rows in editor
  document.getElementById('btn-clear-rows')?.addEventListener('click', () => {
    if (confirm('편집 중인 비행 일정을 모두 비우시겠습니까?')) {
      flightRows = [];
      renderFlightRows();
    }
  });

  // Confirmation Checkbox triggers save button enabled state
  const confirmCheck = document.getElementById('mgmt-confirm-check');
  const saveBtn = document.getElementById('mgmt-save-btn');
  if (confirmCheck && saveBtn) {
    confirmCheck.onchange = (e) => {
      saveBtn.disabled = !e.target.checked;
    };
    saveBtn.onclick = () => handleSaveSchedule();
  }

  // Delete current month
  document.getElementById('btn-delete-month')?.addEventListener('click', () => {
    if (confirm(`정말로 ${currentEditingMonth} 일정을 삭제하시겠습니까? 삭제 후에는 복원할 수 없습니다.`)) {
      const ok = deleteMonthSchedule(currentEditingMonth);
      if (ok) {
        loadMonthIntoEditor(currentEditingMonth);
        closeManagerModal();
        refreshAllViews();
        alert(`${currentEditingMonth} 일정이 삭제되었습니다.`);
      }
    }
  });

  // Download Month JSON (Parent -> Kid)
  document.getElementById('btn-download-month-json')?.addEventListener('click', () => {
    handleDownloadMonthJson();
  });

  // Upload Month JSON in modal
  const jsonInput = document.getElementById('mgmt-json-input');
  if (jsonInput) {
    jsonInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        await handleUploadMonthJson(file);
        jsonInput.value = '';
      }
    };
  }

  // Quick Kid's Phone Upload on main calendar screen
  const quickKidJsonInput = document.getElementById('quick-kid-json-input');
  if (quickKidJsonInput) {
    quickKidJsonInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        await handleUploadMonthJson(file);
        quickKidJsonInput.value = '';
      }
    };
  }

  // Photo OCR upload
  const photoInput = document.getElementById('mgmt-photo-input');
  const ocrProgressContainer = document.getElementById('ocr-progress-container');
  const ocrProgressBar = document.getElementById('ocr-progress-bar');
  const ocrProgressText = document.getElementById('ocr-progress-text');

  if (photoInput) {
    photoInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (ocrProgressContainer) {
        ocrProgressContainer.style.display = 'block';
        if (ocrProgressBar) ocrProgressBar.style.width = '5%';
        if (ocrProgressText) ocrProgressText.textContent = '사진을 준비하고 있습니다...';
      }
      // Yield to allow browser to paint progress bar immediately
      await new Promise(r => setTimeout(r, 20));

      try {
        const { flights, detectedYearMonth } = await recognizeSchedulePhoto(
          file,
          currentEditingMonth,
          (progress, text) => {
            if (ocrProgressBar) ocrProgressBar.style.width = `${Math.round(progress * 100)}%`;
            if (ocrProgressText) ocrProgressText.textContent = text;
          }
        );

        if (detectedYearMonth && detectedYearMonth !== currentEditingMonth) {
          currentEditingMonth = detectedYearMonth;
          const monthInput = document.getElementById('mgmt-month-input');
          if (monthInput) monthInput.value = detectedYearMonth;
        }

        // Reset confirmation guard before applying OCR result
        const confirmCheck = document.getElementById('mgmt-confirm-check');
        const saveBtn = document.getElementById('mgmt-save-btn');
        if (confirmCheck) confirmCheck.checked = false;
        if (saveBtn) saveBtn.disabled = true;

        if (flights.length === 0) {
          // Guide 6/6: 인식 0편이면 이전 일정이나 샘플을 남겨 등록하면 안 돼
          flightRows = [];
          renderFlightRows();
          alert('사진에서 비행 스케줄 행을 인식하지 못했습니다. 편집 목록을 비웠으니 수동 추가 또는 텍스트 붙여넣기를 이용해주세요.');
        } else {
          flightRows = flights;
          renderFlightRows();
          alert(`사진에서 ${flights.length}개의 비행 일정을 인식했습니다. 확인이 필요한 항목은 노란색으로 표시되어 있으니 검토 후 등록해주세요.`);
        }
      } catch (err) {
        console.error('OCR Error:', err);
        alert(`사진 인식 실패: ${err.message}`);
      } finally {
        if (ocrProgressContainer) ocrProgressContainer.style.display = 'none';
        photoInput.value = '';
      }
    };
  }

  // Text Paste Parser Modal / Box
  const btnOpenPaste = document.getElementById('btn-open-text-paste');
  const pasteContainer = document.getElementById('mgmt-text-paste-container');
  const pasteTextarea = document.getElementById('mgmt-text-paste-area');
  const btnApplyPaste = document.getElementById('btn-apply-text-paste');

  if (btnOpenPaste && pasteContainer) {
    btnOpenPaste.onclick = () => {
      pasteContainer.style.display = pasteContainer.style.display === 'none' ? 'block' : 'none';
    };
  }

  if (btnApplyPaste && pasteTextarea) {
    btnApplyPaste.onclick = () => {
      const txt = pasteTextarea.value.trim();
      if (!txt) {
        alert('붙여넣을 텍스트를 입력해주세요.');
        return;
      }
      const parsed = parseScheduleText(txt, currentEditingMonth);
      if (parsed.length === 0) {
        alert('입력된 텍스트에서 비행 정보를 파악하지 못했습니다.');
      } else {
        flightRows = parsed;
        renderFlightRows();
        alert(`${parsed.length}건의 일정이 추출되었습니다. 검토 후 확인란에 체크하고 등록해주세요.`);
        pasteContainer.style.display = 'none';
        pasteTextarea.value = '';
      }
    };
  }
}
