/**
 * a flying mom - Journey (여정) Tracker
 * Groups flights into round-trip or multi-leg journeys between Korea and overseas.
 * Displays CURRENT JOURNEY or NEXT JOURNEY in Korea Standard Time (KST).
 */

import { isKoreaBase, getAirport } from './airports.js';
import { getSortedFlightTimeline } from './location-engine.js';
import { formatInTz, formatKoreanMonthDayWeekday } from './timezone.js';

const KOREA_TZ = 'Asia/Seoul';

const CITY_SHORT_MAP = {
  '샌프란시스코': '샌프란',
  '로스앤젤레스': 'LA',
  '프랑크푸르트': '프랑크',
  '호놀룰루': '하와이',
  '라스베이거스': '베이거스',
  '블라디보스토크': '블라디',
  '쿠알라룸푸르': '쿠알라',
  '부에노스아이레스': '부에노스',
  '아디스아바바': '아디스',
  '요하네스버그': '요하네스'
};

/**
 * Returns a compact (2~4 chars) city name for calendar display to prevent ellipsis (...) truncation.
 */
export function getShortCityName(cityName, airportCode = '') {
  if (!cityName) return airportCode || '';
  const base = cityName.split('/')[0].trim();
  if (CITY_SHORT_MAP[base]) return CITY_SHORT_MAP[base];
  if (base.length > 4) {
    return airportCode ? airportCode.toUpperCase() : base.slice(0, 3);
  }
  return base;
}

/**
 * Parses flights into distinct journeys.
 * A journey begins when leaving Korea (ICN/GMP) and ends upon return to Korea (ICN/GMP).
 * If customFlights is passed, uses that array; otherwise uses the full global sorted timeline.
 */
export function extractJourneys(customFlights = null) {
  const timeline = customFlights || getSortedFlightTimeline();
  if (timeline.length === 0) return [];

  const journeys = [];
  let currentLegs = [];
  let isInOverseasJourney = false;

  for (let i = 0; i < timeline.length; i++) {
    const flight = timeline[i];

    // Handle Standby (STBY) duties as isolated single-item journeys
    if (flight.number === 'STBY') {
      if (currentLegs.length > 0) {
        journeys.push(buildJourneyObject(currentLegs));
        currentLegs = [];
        isInOverseasJourney = false;
      }
      journeys.push(buildJourneyObject([flight]));
      continue;
    }

    const departsKorea = isKoreaBase(flight.from);
    const arrivesKorea = isKoreaBase(flight.to);

    // If flight starts from Korea
    if (departsKorea && !arrivesKorea) {
      if (currentLegs.length > 0) {
        // Previous journey was not closed with return to Korea
        journeys.push(buildJourneyObject(currentLegs));
        currentLegs = [];
      }
      currentLegs.push(flight);
      isInOverseasJourney = true;
    } else if (isInOverseasJourney) {
      // Continuation of an ongoing overseas journey
      currentLegs.push(flight);
      if (arrivesKorea) {
        // Journey ended upon return to Korea
        journeys.push(buildJourneyObject(currentLegs));
        currentLegs = [];
        isInOverseasJourney = false;
      }
    } else if (departsKorea && arrivesKorea) {
      // Domestic flight (e.g. GMP -> CJU -> GMP)
      journeys.push(buildJourneyObject([flight]));
    } else {
      // Detached flight or return flight
      currentLegs.push(flight);
      if (arrivesKorea) {
        journeys.push(buildJourneyObject(currentLegs));
        currentLegs = [];
        isInOverseasJourney = false;
      }
    }
  }

  // Handle open journey without return leg
  if (currentLegs.length > 0) {
    journeys.push(buildJourneyObject(currentLegs));
  }

  // Assign distinct rotating color palette index (0..5) to each journey for visual distinction
  let colorCounter = 0;
  for (const j of journeys) {
    if (j.isStandby) {
      j.colorIndex = -1;
      j.colorClass = 'journey-color-standby';
    } else {
      const idx = colorCounter % 6;
      j.colorIndex = idx;
      j.colorClass = `journey-color-${idx}`;
      colorCounter++;
    }
  }

  return journeys;
}

function buildJourneyObject(flights) {
  if (!flights || flights.length === 0) return null;

  const firstFlight = flights[0];
  const lastFlight = flights[flights.length - 1];

  const departsKorea = isKoreaBase(firstFlight.from);
  const arrivesKorea = isKoreaBase(lastFlight.to);

  // Populate formatted local airport strings on each flight leg
  for (const f of flights) {
    if (!f.depAirport) f.depAirport = getAirport(f.from);
    if (!f.arrAirport) f.arrAirport = getAirport(f.to);
    const depLocalTz = (f.depAirport && f.depAirport.tz) ? f.depAirport.tz : KOREA_TZ;
    const arrLocalTz = (f.arrAirport && f.arrAirport.tz) ? f.arrAirport.tz : KOREA_TZ;
    if (!f.depLocalLabel) f.depLocalLabel = formatKoreanMonthDayWeekday(f.depUtc, depLocalTz);
    if (!f.arrLocalLabel) f.arrLocalLabel = formatKoreanMonthDayWeekday(f.arrUtc, arrLocalTz);
    if (!f.depLocalTime) {
      const depIso = formatInTz(f.depUtc, depLocalTz, { formatType: 'iso' });
      f.depLocalTime = depIso.slice(11, 16);
      f.depLocalDate = depIso.slice(0, 10);
    }
    if (!f.arrLocalTime) {
      const arrIso = formatInTz(f.arrUtc, arrLocalTz, { formatType: 'iso' });
      f.arrLocalTime = arrIso.slice(11, 16);
      f.arrLocalDate = arrIso.slice(0, 10);
    }
  }

  const isStandby = flights.length === 1 && firstFlight.number === 'STBY';

  // Path nodes (e.g. ['ICN', 'LHR', 'ICN'])
  const routeNodes = [firstFlight.from];
  for (const f of flights) {
    if (routeNodes[routeNodes.length - 1] !== f.to) {
      routeNodes.push(f.to);
    }
  }

  // Flight numbers
  const flightNumbers = flights.map(f => f.number).filter(Boolean);

  // Overseas destinations (excluding Korean bases) with country
  const overseasDestinations = [];
  for (const f of flights) {
    if (!isKoreaBase(f.to)) {
      const ap = f.arrAirport || getAirport(f.to);
      const city = ap ? ap.city.split('/')[0] : f.to;
      const country = ap && ap.country ? ap.country : '';
      const label = country ? `${city} (${country})` : city;
      if (!overseasDestinations.includes(label)) overseasDestinations.push(label);
    }
  }

  const defaultDest = firstFlight.arrAirport
    ? `${firstFlight.arrAirport.city.split('/')[0]}${firstFlight.arrAirport.country ? ` (${firstFlight.arrAirport.country})` : ''}`
    : firstFlight.to;

  const startUtc = firstFlight.depUtc;
  const endUtc = arrivesKorea ? lastFlight.arrUtc : lastFlight.arrUtc;

  const startKstIso = formatInTz(startUtc, KOREA_TZ, { formatType: 'iso' });
  const startKstDate = startKstIso.slice(0, 10);
  const endKstIso = endUtc ? formatInTz(endUtc, KOREA_TZ, { formatType: 'iso' }) : startKstIso;
  const endKstDate = endKstIso.slice(0, 10);

  // Compute all spanned calendar dates in KST
  const allSpannedKstDates = [];
  const cur = new Date(startKstDate + 'T00:00:00');
  const targetEnd = new Date(endKstDate + 'T00:00:00');
  while (cur <= targetEnd) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    allSpannedKstDates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }

  // Calculate duration label (e.g. 2박 3일 or 당일 왕복)
  const diffDays = Math.round((targetEnd.getTime() - new Date(startKstDate + 'T00:00:00').getTime()) / (1000 * 60 * 60 * 24));
  let durationLabel = diffDays <= 0 ? '당일 왕복' : `${diffDays}박 ${diffDays + 1}일`;
  if (isStandby) durationLabel = '대기 근무';

  // Find primary destination city and country
  let mainCity = '';
  let mainCountry = '';
  for (const f of flights) {
    if (!isKoreaBase(f.to)) {
      const ap = f.arrAirport || getAirport(f.to);
      if (ap) {
        mainCity = ap.city.split('/')[0];
        mainCountry = ap.country || '';
        break;
      }
    }
  }
  if (!mainCity && firstFlight.arrAirport) {
    mainCity = firstFlight.arrAirport.city.split('/')[0];
    mainCountry = firstFlight.arrAirport.country || '';
  }
  if (!mainCity) mainCity = firstFlight.to;

  const shortCity = isStandby ? '대기' : getShortCityName(mainCity, firstFlight.to);

  const depKstShortLabel = formatKoreanMonthDayWeekday(startUtc, KOREA_TZ);
  const endKstShortLabel = endUtc ? formatKoreanMonthDayWeekday(endUtc, KOREA_TZ) : '';
  const periodLabel = (startKstDate === endKstDate)
    ? `${depKstShortLabel} · ${durationLabel}`
    : `${depKstShortLabel} ~ ${endKstShortLabel} · ${durationLabel}`;

  const startCity = firstFlight.depAirport ? firstFlight.depAirport.city.split('/')[0] : firstFlight.from;
  const mainRouteTitle = isStandby
    ? `${startCity} 공항 대기 (STBY)`
    : (departsKorea && arrivesKorea && flights.length > 1)
      ? `${startCity} ↔ ${mainCity}${mainCountry ? ` (${mainCountry})` : ''}`
      : `${startCity} ➔ ${mainCity}${mainCountry ? ` (${mainCountry})` : ''}`;

  return {
    _id: `journey-${firstFlight.from}-${firstFlight.departure}-${lastFlight.to}-${lastFlight.arrival}`,
    flights,
    routeSummary: routeNodes.join(' ➔ '),
    mainRouteTitle,
    flightNumbers: flightNumbers.join(', '),
    destinations: overseasDestinations.length > 0 ? overseasDestinations.join(', ') : defaultDest,
    mainCity,
    shortCity,
    mainCountry,
    startCity,
    departsKorea,
    arrivesKorea,
    startUtc,
    endUtc,
    startKstDate,
    endKstDate,
    durationLabel,
    diffDays,
    isStandby,
    isSameDay: startKstDate === endKstDate,
    allSpannedKstDates,
    depKstShortLabel,
    endKstShortLabel,
    periodLabel,
    depKstFormatted: formatInTz(startUtc, KOREA_TZ, { formatType: 'full' }),
    arrKstFormatted: arrivesKorea && endUtc ? formatInTz(endUtc, KOREA_TZ, { formatType: 'full' }) : '귀국편 미등록',
    hasReturnFlight: arrivesKorea
  };
}

/**
 * Returns all journeys that intersect with the given yearMonth ('YYYY-MM') in KST.
 */
export function getJourneysForMonth(yearMonth) {
  const allJourneys = extractJourneys();
  return allJourneys.filter(j => j.allSpannedKstDates.some(d => d.startsWith(yearMonth)));
}

/**
 * Returns CURRENT JOURNEY (if currently underway) or NEXT JOURNEY (if upcoming), or null.
 * Evaluates based on nowUtc (defaults to current time).
 */
export function getCurrentOrNextJourney(nowUtc = new Date()) {
  const journeys = extractJourneys();
  if (journeys.length === 0) {
    return {
      type: 'NO_JOURNEY',
      journey: null,
      message: '등록된 여정이 없습니다.'
    };
  }

  const nowTs = nowUtc.getTime();

  // Check if currently inside any journey
  for (const j of journeys) {
    const startTs = j.startUtc.getTime();
    const endTs = j.endUtc ? j.endUtc.getTime() : Infinity;

    if (nowTs >= startTs && nowTs <= endTs) {
      return {
        type: 'CURRENT_JOURNEY',
        label: 'CURRENT JOURNEY',
        badgeClass: 'badge-current',
        journey: j,
        isUnderway: true
      };
    }
  }

  // If not currently inside a journey, find the next upcoming journey
  for (const j of journeys) {
    const startTs = j.startUtc.getTime();
    if (startTs > nowTs) {
      return {
        type: 'NEXT_JOURNEY',
        label: 'NEXT JOURNEY',
        badgeClass: 'badge-next',
        journey: j,
        isUnderway: false
      };
    }
  }

  // If all journeys have already completed in the past
  return {
    type: 'NO_JOURNEY',
    journey: null,
    message: '예정된 다음 여정이 없습니다.'
  };
}
