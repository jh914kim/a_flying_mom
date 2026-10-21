/**
 * a flying mom - Flight Calendar Module
 * 
 * Matches the clean reference calendar UI:
 * - Legend: ● 비행  ● 해외 체류  ● 오늘
 * - 7-column grid with subtle horizontal row dividers
 * - Flight days: Bold blue date number + plain blue "✈ SFO" below (no boxy pill backgrounds)
 * - Selected or Today date: Filled blue circle around the date number with white text
 * - Overseas stay at 12:00 Noon KST: Green "해외 체류" text below the date number
 * - Midnight-crossing flights: Placed on both KST departure date ("✈ DEST") and KST arrival date ("도착 DEST" or "✈ DEST")
 * - Flight list card below:
 *   Header: "10월 21일의 비행 · 1편" (or "10월의 비행 · 14편") and "전체 보기 ↗"
 *   Item:
 *     Top row: "10월 21일 (수)" (left) | "OZ106" (right)
 *     Middle row: "인천" (large bold left) | "→" (center) | "도쿄" (large bold right)
 *     Sub row: "ICN 15:45" (left) | "NRT 18:25" (right)
 *     Footer meta: "출발·도착 현지 시각 · 도착 10월 21일 (수)"
 */

import { getMonthSchedule } from './storage.js';
import { getAirport, isKoreaBase } from './airports.js';
import { formatInTz, getWeekdayInTz, parseFlightTime, parseLocalToUTC, formatKoreanMonthDayWeekday } from './timezone.js';
import { getSortedFlightTimeline } from './location-engine.js';
import { extractJourneys, getJourneysForMonth, getShortCityName } from './journey.js';

const KOREA_TZ = 'Asia/Seoul';
const LIST_COLLAPSED_LIMIT = 5;

let currentCalendarYearMonth = ''; // 'YYYY-MM'
let selectedDateStr = null; // 'YYYY-MM-DD' or null (when viewing full month)
let isListExpanded = false;

/**
 * Initializes calendar strictly to the current KST month.
 * If current month has no schedule, shows empty calendar + notice (does NOT substitute another month).
 */
export function initCalendar() {
  const now = new Date();
  const kstIso = formatInTz(now, KOREA_TZ, { formatType: 'iso' }); // 'YYYY-MM-DDTHH:mm'
  currentCalendarYearMonth = kstIso.slice(0, 7);
  selectedDateStr = null;
  isListExpanded = false;
  renderCalendar();
}

export function setCalendarMonth(yearMonth) {
  if (!yearMonth) return;
  currentCalendarYearMonth = yearMonth;
  selectedDateStr = null;
  isListExpanded = false;
  renderCalendar();
}

export function prevCalendarMonth() {
  const [y, m] = currentCalendarYearMonth.split('-').map(Number);
  const prevDate = new Date(y, m - 2, 1);
  currentCalendarYearMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
  selectedDateStr = null; // Clear date selection on month navigation
  isListExpanded = false;
  renderCalendar();
}

export function nextCalendarMonth() {
  const [y, m] = currentCalendarYearMonth.split('-').map(Number);
  const nextDate = new Date(y, m, 1);
  currentCalendarYearMonth = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
  selectedDateStr = null; // Clear date selection on month navigation
  isListExpanded = false;
  renderCalendar();
}

/**
 * Normalizes flights belonging to the target yearMonth in KST.
 * Strictly checks if the viewed month itself has a saved schedule.
 */
function getMonthNormalizedFlights(yearMonth) {
  const monthSchedule = getMonthSchedule(yearMonth);
  if (!monthSchedule || !Array.isArray(monthSchedule.flights) || monthSchedule.flights.length === 0) {
    return { hasMonthSchedule: false, flights: [] };
  }

  const timeBasis = monthSchedule.timeBasis || 'korea';
  const normalized = [];

  monthSchedule.flights.forEach((f, idx) => {
    const depRes = parseFlightTime(f.departure, f.from, timeBasis);
    const arrRes = parseFlightTime(f.arrival, f.to, timeBasis);

    if (depRes.date && arrRes.date) {
      const depAirport = getAirport(f.from);
      const arrAirport = getAirport(f.to);

      // KST date & time strings for calendar placement
      const depKstIso = formatInTz(depRes.date, KOREA_TZ, { formatType: 'iso' });
      const arrKstIso = formatInTz(arrRes.date, KOREA_TZ, { formatType: 'iso' });

      // Airport local time strings for flight card display
      const depLocalTz = (depAirport && depAirport.tz) ? depAirport.tz : KOREA_TZ;
      const arrLocalTz = (arrAirport && arrAirport.tz) ? arrAirport.tz : KOREA_TZ;

      const depLocalIso = formatInTz(depRes.date, depLocalTz, { formatType: 'iso' });
      const arrLocalIso = formatInTz(arrRes.date, arrLocalTz, { formatType: 'iso' });

      normalized.push({
        ...f,
        _id: `${yearMonth}-${idx}-${f.number}-${f.departure}`,
        timeBasis,
        depUtc: depRes.date,
        arrUtc: arrRes.date,
        depAirport,
        arrAirport,
        depKstDate: depKstIso.slice(0, 10),
        depKstTime: depKstIso.slice(11, 16),
        arrKstDate: arrKstIso.slice(0, 10),
        arrKstTime: arrKstIso.slice(11, 16),
        depLocalDate: depLocalIso.slice(0, 10),
        depLocalTime: depLocalIso.slice(11, 16),
        depLocalLabel: formatKoreanMonthDayWeekday(depRes.date, depLocalTz),
        depLocalTz,
        arrLocalDate: arrLocalIso.slice(0, 10),
        arrLocalTime: arrLocalIso.slice(11, 16),
        arrLocalLabel: formatKoreanMonthDayWeekday(arrRes.date, arrLocalTz),
        arrLocalTz
      });
    }
  });

  // Sort chronologically by UTC departure time
  normalized.sort((a, b) => a.depUtc.getTime() - b.depUtc.getTime());

  return {
    hasMonthSchedule: true,
    flights: normalized
  };
}

/**
 * Checks if at 12:00 Noon KST on `dayStr` ('YYYY-MM-DD'), the crew member is staying overseas
 * according to the schedule timeline.
 */
function checkOverseasStayAtNoonKST(dayStr, monthFlights) {
  if (!monthFlights || monthFlights.length === 0) return { isOverseasStay: false, stayAirport: null };

  const noonRes = parseLocalToUTC(`${dayStr}T12:00`, KOREA_TZ);
  if (!noonRes.date) return { isOverseasStay: false, stayAirport: null };
  const noonTs = noonRes.date.getTime();

  const timeline = getSortedFlightTimeline();
  const sourceList = timeline.length > 0 ? timeline : monthFlights;

  // 1. If in-flight right at 12:00 noon KST:
  for (const f of sourceList) {
    if (f.number === 'STBY') continue;
    const depTs = f.depUtc.getTime();
    const arrTs = f.arrUtc.getTime();
    if (noonTs >= depTs && noonTs <= arrTs) {
      if (!isKoreaBase(f.from) && !isKoreaBase(f.to)) {
        return { isOverseasStay: true, stayAirport: f.arrAirport || getAirport(f.to) };
      }
      return { isOverseasStay: false, stayAirport: null };
    }
  }

  // 2. Find latest flight that arrived before 12:00 noon KST and earliest flight departing after 12:00 noon KST
  let prevFlight = null;
  let nextFlight = null;

  for (const f of sourceList) {
    if (f.arrUtc.getTime() < noonTs) {
      prevFlight = f;
    } else if (f.depUtc.getTime() > noonTs && !nextFlight) {
      nextFlight = f;
    }
  }

  if (prevFlight && !isKoreaBase(prevFlight.to)) {
    if (nextFlight && nextFlight.depUtc.getTime() > noonTs) {
      return {
        isOverseasStay: true,
        stayAirport: prevFlight.arrAirport || getAirport(prevFlight.to)
      };
    }
  }

  return { isOverseasStay: false, stayAirport: null };
}

/**
 * Computes calendar metadata for each day of the month in KST:
 * - Associate each day with its active Journey (start date, stay dates, return date)
 * - Flights departing and arriving on each day
 * - Overseas stay status
 */
function computeMonthDaysMeta(yearMonth, monthFlights, hasMonthSchedule) {
  const [year, month] = yearMonth.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();

  const nowKstIso = formatInTz(new Date(), KOREA_TZ, { formatType: 'iso' });
  const todayKstStr = nowKstIso.slice(0, 10);

  const metaMap = new Map();

  for (let day = 1; day <= daysInMonth; day++) {
    const dayStr = `${yearMonth}-${String(day).padStart(2, '0')}`;
    metaMap.set(dayStr, {
      day,
      month,
      year,
      dateStr: dayStr,
      isToday: dayStr === todayKstStr,
      flightsDeparting: [],
      flightsArrivingOvernight: [],
      allDayFlights: [], // Deduplicated flights on this KST day
      isOverseasStay: false,
      stayAirport: null,
      journey: null,
      isJourneyDay: false,
      isJourneyStart: false,
      isJourneyEnd: false,
      isJourneyStay: false,
      isJourneySameDay: false,
      isStandby: false
    });
  }

  // 1. Place individual flights on calendar days
  if (hasMonthSchedule && monthFlights) {
    for (const f of monthFlights) {
      const depDay = f.depKstDate;
      const arrDay = f.arrKstDate;

      if (metaMap.has(depDay)) {
        const m = metaMap.get(depDay);
        m.flightsDeparting.push(f);
        if (!m.allDayFlights.some(existing => existing._id === f._id)) {
          m.allDayFlights.push(f);
        }
      }

      if (f.number !== 'STBY' && arrDay !== depDay && metaMap.has(arrDay)) {
        const m = metaMap.get(arrDay);
        m.flightsArrivingOvernight.push(f);
        if (!m.allDayFlights.some(existing => existing._id === f._id)) {
          m.allDayFlights.push(f);
        }
      }
    }
  }

  // 2. Associate Journeys with days
  const monthJourneys = getJourneysForMonth(yearMonth);
  for (const j of monthJourneys) {
    for (const dStr of j.allSpannedKstDates) {
      if (metaMap.has(dStr)) {
        const meta = metaMap.get(dStr);
        meta.journey = j;
        meta.isJourneyDay = true;
        meta.colorClass = j.colorClass;
        meta.colorIndex = j.colorIndex;

        if (j.isStandby) {
          meta.isStandby = true;
        } else if (j.isSameDay) {
          meta.isJourneySameDay = true;
          meta.isJourneyStart = true;
          meta.isJourneyEnd = true;
        } else if (dStr === j.startKstDate) {
          meta.isJourneyStart = true;
        } else if (dStr === j.endKstDate && j.hasReturnFlight) {
          meta.isJourneyEnd = true;
        } else {
          meta.isJourneyStay = true;
        }
      }
    }
  }

  // 3. Fallback evaluate 12:00 Noon KST overseas stay for any days not mapped into a journey
  for (const [dStr, meta] of metaMap.entries()) {
    if (!meta.isJourneyStay) {
      const stayInfo = checkOverseasStayAtNoonKST(dStr, monthFlights);
      meta.isOverseasStay = stayInfo.isOverseasStay;
      meta.stayAirport = stayInfo.stayAirport;
    }
  }

  return metaMap;
}

/**
 * Formats compact airport code labels for fallback standalone flights
 */
function getFlightDisplayAirportCode(f) {
  const fromCode = (f.from || '').toUpperCase();
  const toCode = (f.to || '').toUpperCase();
  if (isKoreaBase(fromCode) && !isKoreaBase(toCode)) {
    return toCode;
  }
  if (!isKoreaBase(fromCode) && isKoreaBase(toCode)) {
    return fromCode;
  }
  return toCode || fromCode;
}

/**
 * Builds clean, intuitive labels for a calendar day cell:
 * - Departure day: ✈ [목적지] 출발 (or ✈ [목적지] 왕복 for same-day roundtrips)
 * - Stay day: [목적지] 체류
 * - Return day: ✈ 귀국
 * - Standby: ⏰ STBY
 */
function buildDayFlightLabels(meta) {
  const badges = [];

  if (meta.journey) {
    const j = meta.journey;
    if (j.isStandby) {
      badges.push({
        type: 'standby',
        text: '⏰ STBY',
        title: '비행 대기 일정 (스탠바이)',
        fullCodes: ['STBY']
      });
      return badges;
    }

    const shortCity = j.shortCity || getShortCityName(j.mainCity, '');

    if (meta.isJourneySameDay) {
      badges.push({
        type: 'flight',
        text: `✈ ${shortCity}`,
        title: `✈ ${j.mainCity} 당일 왕복`,
        fullCodes: [j.mainCity]
      });
      return badges;
    }

    if (meta.isJourneyStart) {
      badges.push({
        type: 'flight',
        text: `✈ ${shortCity}`,
        title: `✈ ${j.mainCity} 출발 (${j.durationLabel})`,
        fullCodes: [j.mainCity]
      });
      return badges;
    }

    if (meta.isJourneyEnd) {
      badges.push({
        type: 'return',
        text: '✈ 귀국',
        title: `✈ ${j.mainCity} 여정 귀국`,
        fullCodes: ['귀국']
      });
      return badges;
    }

    if (meta.isJourneyStay) {
      badges.push({
        type: 'stay',
        text: `${shortCity}`,
        title: `${j.mainCity} 현지 체류`,
        fullCodes: [j.mainCity]
      });
      return badges;
    }
  }

  // Fallback for standalone flights without a journey mapping
  const regularFlights = meta.allDayFlights.filter(f => f.number !== 'STBY');
  const standbyFlights = meta.allDayFlights.filter(f => f.number === 'STBY');

  if (regularFlights.length > 0) {
    const uniqueCodes = [];
    for (const f of regularFlights) {
      const code = getFlightDisplayAirportCode(f);
      const ap = getAirport(code);
      const shortName = ap ? getShortCityName(ap.city, code) : code;
      if (shortName && !uniqueCodes.includes(shortName)) {
        uniqueCodes.push(shortName);
      }
    }

    const MAX_VISIBLE_CODES = 2;
    const visible = uniqueCodes.slice(0, MAX_VISIBLE_CODES);
    const extraCount = uniqueCodes.length - visible.length;
    const codeText = visible.join(' · ') + (extraCount > 0 ? ` +${extraCount}` : '');

    badges.push({
      type: 'flight',
      text: `✈ ${codeText}`,
      title: `비행: ${codeText}`,
      fullCodes: uniqueCodes
    });
  }

  if (standbyFlights.length > 0) {
    badges.push({
      type: 'standby',
      text: '⏰ STBY',
      fullCodes: ['STBY']
    });
  }

  return badges;
}

/**
 * Main render function for the calendar view and flight list
 */
export function renderCalendar() {
  const titleEl = document.getElementById('calendar-title');
  const gridEl = document.getElementById('calendar-grid');
  const flightListEl = document.getElementById('calendar-flight-list');
  const showMoreBtn = document.getElementById('calendar-show-more-btn');

  if (!gridEl) return;

  const [year, month] = currentCalendarYearMonth.split('-').map(Number);
  if (titleEl) {
    titleEl.textContent = `${year}년 ${month}월`;
  }

  const { hasMonthSchedule, flights: monthFlights } = getMonthNormalizedFlights(currentCalendarYearMonth);
  const firstDayOfWeek = new Date(year, month - 1, 1).getDay(); // 0 is Sun
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysMeta = computeMonthDaysMeta(currentCalendarYearMonth, monthFlights, hasMonthSchedule);

  // Clear grid
  gridEl.innerHTML = '';

  // Day of week headers
  const daysHeader = ['일', '월', '화', '수', '목', '금', '토'];
  for (const h of daysHeader) {
    const cell = document.createElement('div');
    cell.className = 'cal-header-cell';
    cell.textContent = h;
    gridEl.appendChild(cell);
  }

  // Padding cells before day 1
  for (let i = 0; i < firstDayOfWeek; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'cal-day-cell cal-empty-cell';
    emptyCell.setAttribute('aria-hidden', 'true');
    gridEl.appendChild(emptyCell);
  }

  // Days of current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dStr = `${currentCalendarYearMonth}-${String(d).padStart(2, '0')}`;
    const meta = daysMeta.get(dStr);

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-day-cell';

    const flightCount = meta.allDayFlights.length;
    const hasFlight = flightCount > 0;

    if (meta.isToday) cell.classList.add('is-today');
    if (dStr === selectedDateStr) cell.classList.add('is-selected');
    if (hasFlight) cell.classList.add('has-flight');
    if (meta.isOverseasStay || meta.isJourneyStay) cell.classList.add('is-overseas-stay');

    if (meta.isJourneyDay) {
      cell.classList.add('is-journey-day');
      if (meta.colorClass) cell.classList.add(meta.colorClass);
      if (meta.isJourneySameDay) cell.classList.add('journey-sameday');
      else if (meta.isJourneyStart) cell.classList.add('journey-start');
      else if (meta.isJourneyEnd) cell.classList.add('journey-end');
      else if (meta.isJourneyStay) cell.classList.add('journey-stay');
    }

    // Accessible aria-label
    let ariaLabel = `${year}년 ${month}월 ${d}일`;
    if (meta.journey) {
      if (meta.isJourneySameDay) {
        ariaLabel += `, ${meta.journey.mainCity} 당일 왕복 일정`;
      } else if (meta.isJourneyStart) {
        ariaLabel += `, ${meta.journey.mainCity} 비행 출발 (${meta.journey.durationLabel})`;
      } else if (meta.isJourneyEnd) {
        ariaLabel += `, ${meta.journey.mainCity} 여정 귀국일`;
      } else if (meta.isJourneyStay) {
        ariaLabel += `, ${meta.journey.mainCity} 현지 체류`;
      }
    } else if (hasFlight) {
      ariaLabel += `, 비행 ${flightCount}편`;
    }
    cell.setAttribute('aria-label', ariaLabel);
    cell.setAttribute('aria-pressed', dStr === selectedDateStr ? 'true' : 'false');

    // Date Number Circle Wrapper
    const numSpan = document.createElement('span');
    numSpan.className = 'cal-day-num';
    numSpan.textContent = d;
    cell.appendChild(numSpan);

    // Indicators container below date number
    const badgesContainer = document.createElement('div');
    badgesContainer.className = 'cal-dots-container';

    const flightBadges = buildDayFlightLabels(meta);
    for (const b of flightBadges) {
      const badgeEl = document.createElement('span');
      if (b.type === 'standby') {
        badgeEl.className = 'cal-label-flight cal-label-standby';
      } else if (b.type === 'stay') {
        badgeEl.className = 'cal-label-stay';
      } else if (b.type === 'return') {
        badgeEl.className = 'cal-label-return';
      } else {
        badgeEl.className = 'cal-label-flight';
      }
      if (meta.colorClass) {
        badgeEl.classList.add(meta.colorClass);
      }
      badgeEl.textContent = b.text;
      if (b.title) badgeEl.title = b.title;
      badgesContainer.appendChild(badgeEl);
    }

    // Fallback overseas stay notice if no badges present
    if (meta.isOverseasStay && flightBadges.length === 0) {
      const stayBadge = document.createElement('span');
      stayBadge.className = 'cal-label-stay';
      stayBadge.textContent = '해외 체류';
      badgesContainer.appendChild(stayBadge);
    }

    cell.appendChild(badgesContainer);

    cell.onclick = () => {
      if (selectedDateStr === dStr) {
        selectedDateStr = null;
      } else {
        selectedDateStr = dStr;
      }
      isListExpanded = false;
      renderCalendar();
    };

    gridEl.appendChild(cell);
  }

  // Render Flight List Section
  renderFlightsList(daysMeta, monthFlights, hasMonthSchedule, flightListEl, showMoreBtn);
}

/**
 * Renders the unified 비행 일정 (Journey Schedule) list for:
 * 1) Empty month
 * 2) Selected date (focusing on the matching journey)
 * 3) Full month view (ordered by active, upcoming, completed journeys)
 */
function renderFlightsList(daysMeta, monthFlights, hasMonthSchedule, listEl, showMoreBtn) {
  if (!listEl) return;
  listEl.innerHTML = '';

  const [year, month] = currentCalendarYearMonth.split('-').map(Number);
  const monthJourneys = getJourneysForMonth(currentCalendarYearMonth);

  // Case 1: Current viewed month has NO schedule registered
  if (!hasMonthSchedule && monthJourneys.length === 0) {
    if (selectedDateStr) {
      const selMonth = parseInt(selectedDateStr.slice(5, 7), 10);
      const selDay = parseInt(selectedDateStr.slice(8, 10), 10);

      const headerBar = createListHeaderBar(
        `${selMonth}월 ${selDay}일의 비행 일정 · 0개 여정`,
        true
      );
      listEl.appendChild(headerBar);

      const emptyDayCard = document.createElement('div');
      emptyDayCard.className = 'empty-notice-card';
      emptyDayCard.innerHTML = `
        <p class="empty-notice-title">이 날짜에 등록된 비행 일정이 없어요</p>
        <span class="subtext">등록된 비행이 없다고 해서 휴무이거나 집에 있다고 단정하지 않습니다.</span>
      `;
      listEl.appendChild(emptyDayCard);
    } else {
      const headerBar = createListHeaderBar(`${month}월의 비행 일정 · 0개 여정`, false);
      listEl.appendChild(headerBar);

      const emptyCard = document.createElement('div');
      emptyCard.className = 'empty-notice-card';
      emptyCard.innerHTML = `
        <p class="empty-notice-title">${year}년 ${month}월에 등록된 비행 일정이 없습니다.</p>
        <span class="subtext">상단의 [스케줄 관리] 메뉴를 통해 이 달의 스케줄을 등록해주세요. 다른 달의 일정을 대신 표시하거나 임의로 휴무·집 체류로 단정하지 않습니다.</span>
      `;
      listEl.appendChild(emptyCard);
    }
    if (showMoreBtn) showMoreBtn.style.display = 'none';
    return;
  }

  // Case 2: A specific date is selected on the calendar
  if (selectedDateStr) {
    const selMonth = parseInt(selectedDateStr.slice(5, 7), 10);
    const selDay = parseInt(selectedDateStr.slice(8, 10), 10);

    const matchedJourneys = monthJourneys.filter(j => j.allSpannedKstDates.includes(selectedDateStr));

    if (matchedJourneys.length > 0) {
      const headerBar = createListHeaderBar(
        `${selMonth}월 ${selDay}일 포함 비행 일정 · ${matchedJourneys.length}개 여정`,
        true
      );
      listEl.appendChild(headerBar);

      const itemsWrap = document.createElement('div');
      itemsWrap.className = 'flight-items-list';
      matchedJourneys.forEach((j) => {
        itemsWrap.appendChild(createJourneyScheduleCard(j, selectedDateStr));
      });
      listEl.appendChild(itemsWrap);
    } else {
      const headerBar = createListHeaderBar(
        `${selMonth}월 ${selDay}일의 비행 일정 · 0개 여정`,
        true
      );
      listEl.appendChild(headerBar);

      const emptyDayCard = document.createElement('div');
      emptyDayCard.className = 'empty-notice-card';
      emptyDayCard.innerHTML = `
        <p class="empty-notice-title">이 날짜에 등록된 비행 일정이 없어요</p>
        <span class="subtext">비행 일정이 없는 날이라도 지상근무·교육·체류 등일 수 있으므로 휴무나 집 체류로 단정하지 않습니다.</span>
      `;
      listEl.appendChild(emptyDayCard);
    }

    if (showMoreBtn) showMoreBtn.style.display = 'none';
    return;
  }

  // Case 3: Full Month View - Prioritize active & upcoming journeys!
  const nowTs = Date.now();
  const underwayJourneys = [];
  const upcomingJourneys = [];
  const pastJourneys = [];

  for (const j of monthJourneys) {
    const startTs = j.startUtc.getTime();
    const endTs = j.endUtc ? j.endUtc.getTime() : Infinity;

    if (nowTs >= startTs && nowTs <= endTs) {
      underwayJourneys.push(j);
    } else if (startTs > nowTs) {
      upcomingJourneys.push(j);
    } else {
      pastJourneys.push(j);
    }
  }

  upcomingJourneys.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  pastJourneys.sort((a, b) => b.startUtc.getTime() - a.startUtc.getTime());

  const orderedJourneys = [...underwayJourneys, ...upcomingJourneys, ...pastJourneys];

  const headerBar = createListHeaderBar(
    `${month}월의 비행 일정 · ${orderedJourneys.length}개 여정`,
    false
  );
  listEl.appendChild(headerBar);

  const limit = isListExpanded ? orderedJourneys.length : LIST_COLLAPSED_LIMIT;
  const visibleItems = orderedJourneys.slice(0, limit);

  const itemsWrap = document.createElement('div');
  itemsWrap.className = 'flight-items-list';
  visibleItems.forEach((j) => {
    itemsWrap.appendChild(createJourneyScheduleCard(j, null));
  });
  listEl.appendChild(itemsWrap);

  if (showMoreBtn) {
    if (orderedJourneys.length > LIST_COLLAPSED_LIMIT) {
      showMoreBtn.style.display = 'inline-flex';
      const remaining = orderedJourneys.length - LIST_COLLAPSED_LIMIT;
      showMoreBtn.textContent = isListExpanded
        ? '접기'
        : `나머지 보기 (${remaining}개 여정)`;
      showMoreBtn.onclick = () => {
        isListExpanded = !isListExpanded;
        renderCalendar();
      };
    } else {
      showMoreBtn.style.display = 'none';
    }
  }
}

/**
 * Creates the header bar above the flight list
 */
function createListHeaderBar(titleText, showResetBtn = false) {
  const bar = document.createElement('div');
  bar.className = 'flight-list-header-bar';

  const titleEl = document.createElement('h3');
  titleEl.className = 'flight-list-title';
  titleEl.textContent = titleText;
  bar.appendChild(titleEl);

  if (showResetBtn) {
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn-view-all-link';
    resetBtn.innerHTML = '전체 보기 <span aria-hidden="true">↗</span>';
    resetBtn.onclick = () => {
      selectedDateStr = null;
      isListExpanded = false;
      renderCalendar();
    };
    bar.appendChild(resetBtn);
  }

  return bar;
}

/**
 * Creates a consolidated Journey Schedule Card (비행 일정 카드):
 * Represents departure from Korea to return to Korea as a single unified journey with duration,
 * status badge, outbound leg, local stay, and return leg.
 */
function createJourneyScheduleCard(journey, focusedDateStr = null) {
  const card = document.createElement('div');
  card.className = `journey-schedule-card ${journey.colorClass || ''}`;

  const nowTs = Date.now();
  const startTs = journey.startUtc.getTime();
  const endTs = journey.endUtc ? journey.endUtc.getTime() : Infinity;

  let statusBadgeHtml = '';
  if (journey.isStandby) {
    statusBadgeHtml = '<span class="jsc-badge jsc-badge-standby">⏰ STBY (대기)</span>';
  } else if (nowTs >= startTs && nowTs <= endTs) {
    statusBadgeHtml = '<span class="jsc-badge jsc-badge-active"><span class="jsc-badge-dot">●</span> 진행 중</span>';
    card.classList.add('is-journey-active');
  } else if (startTs > nowTs) {
    statusBadgeHtml = '<span class="jsc-badge jsc-badge-upcoming"><span class="jsc-badge-dot">●</span> 예정</span>';
  } else {
    statusBadgeHtml = '<span class="jsc-badge jsc-badge-completed">완료</span>';
    card.classList.add('is-journey-completed');
  }

  if (journey.isStandby) {
    const f = journey.flights[0];
    card.innerHTML = `
      <div class="jsc-header">
        <div class="jsc-meta">
          <span class="jsc-date-text">📅 ${journey.depKstShortLabel}</span>
          <span class="jsc-duration-badge">대기 근무</span>
        </div>
        ${statusBadgeHtml}
      </div>
      <div class="jsc-main-route">
        <h4 class="jsc-dest-title">${journey.mainRouteTitle}</h4>
        <span class="jsc-flight-numbers">비행 대기 일정 (스탠바이)</span>
      </div>
      <div class="jsc-legs-container">
        <div class="jsc-leg-row">
          <div class="jsc-leg-top">
            <span class="jsc-leg-tag standby">대기</span>
            <span class="jsc-leg-time">${f.from} ${f.depLocalTime} ~ ${f.arrLocalTime}</span>
          </div>
          <div class="jsc-leg-cities">
            <span class="jsc-city-bold">${journey.startCity} 공항 대기</span>
          </div>
        </div>
      </div>
      <div class="jsc-footer">
        <span>한국 시각(KST) 기준: ${journey.depKstFormatted}</span>
      </div>
    `;
    return card;
  }

  // Regular Flight Journey
  let legsHtml = '';
  const totalLegs = journey.flights.length;

  journey.flights.forEach((f, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === totalLegs - 1 && journey.hasReturnFlight && totalLegs > 1;
    let legRole = '이동편';
    let legTagClass = 'inter';

    if (isFirst) {
      legRole = '가는 편';
      legTagClass = 'outbound';
    } else if (isLast) {
      legRole = '오는 편 (귀국)';
      legTagClass = 'inbound';
    }

    const depCity = f.depAirport ? f.depAirport.city.split('/')[0] : f.from;
    const arrCity = f.arrAirport ? f.arrAirport.city.split('/')[0] : f.to;
    const depCountry = f.depAirport && f.depAirport.country ? ` (${f.depAirport.country})` : '';
    const arrCountry = f.arrAirport && f.arrAirport.country ? ` (${f.arrAirport.country})` : '';
    const isDiffArrDate = f.arrLocalDate !== f.depLocalDate;

    legsHtml += `
      <div class="jsc-leg-row ${isFirst ? 'is-outbound' : isLast ? 'is-inbound' : ''}">
        <div class="jsc-leg-top">
          <span class="jsc-leg-tag ${legTagClass}">${legRole} · ${f.number}</span>
          <span class="jsc-leg-date">${f.depLocalLabel}</span>
        </div>
        <div class="jsc-leg-cities">
          <span class="jsc-city-bold is-dep">${depCity}${depCountry}</span>
          <span class="jsc-arrow" aria-hidden="true">→</span>
          <span class="jsc-city-bold is-arr">${arrCity}${arrCountry}</span>
        </div>
        <div class="jsc-leg-times">
          <span class="jsc-time-code is-dep">${f.from} ${f.depLocalTime}</span>
          <span class="jsc-time-arrow" aria-hidden="true">➔</span>
          <span class="jsc-time-code is-arr">${f.to} ${f.arrLocalTime}</span>
          <span class="jsc-tz-hint">(현지 시각)</span>
        </div>
        ${isDiffArrDate ? `<div class="jsc-leg-diff-date">도착 현지 일자: <strong>${f.arrLocalLabel}</strong></div>` : ''}
      </div>
    `;

    // Insert Stay notice between outbound leg and next leg if stay is > 0 days
    if (isFirst && totalLegs > 1 && journey.diffDays > 0) {
      legsHtml += `
        <div class="jsc-stay-notice">
          <span class="jsc-stay-icon" aria-hidden="true">🏨</span>
          <span class="jsc-stay-text">${journey.mainCity} 현지 체류</span>
          <span class="jsc-stay-sub">(${journey.durationLabel})</span>
        </div>
      `;
    }
  });

  // If no return leg registered yet
  if (!journey.hasReturnFlight) {
    legsHtml += `
      <div class="jsc-stay-notice jsc-open-stay">
        <span class="jsc-stay-icon" aria-hidden="true">⏳</span>
        <span class="jsc-stay-text">${journey.mainCity} 체류 중 · 귀국편 미등록</span>
      </div>
    `;
  }

  card.innerHTML = `
    <div class="jsc-header">
      <div class="jsc-meta">
        <span class="jsc-date-text">📅 ${journey.periodLabel}</span>
      </div>
      ${statusBadgeHtml}
    </div>
    <div class="jsc-main-route">
      <h4 class="jsc-dest-title">${journey.mainRouteTitle}</h4>
      <span class="jsc-flight-numbers">${journey.flightNumbers}</span>
    </div>
    <div class="jsc-legs-container">
      ${legsHtml}
    </div>
    <div class="jsc-footer">
      <span>한국 시각(KST) 기준: <strong>${journey.depKstFormatted}</strong> 출발 ~ <strong>${journey.arrKstFormatted}</strong> 귀국</span>
    </div>
  `;

  return card;
}
