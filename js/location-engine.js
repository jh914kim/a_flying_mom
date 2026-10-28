/**
 * flying mom - Location & Flight Calculation Engine
 * Estimates current status, location, in-flight progress, and geodesic great-circle flight paths.
 */

import { getAirport, isKoreaBase, GWACHEON_BASE, getHomeBase, calculateCommuteMinutes } from './airports.js';
import { parseFlightTime } from './timezone.js';
import { getAllSavedSchedules, getMonthSchedule } from './storage.js';

export const STATUS_TYPES = {
  UNKNOWN: 'UNKNOWN',
  HOME: 'HOME',
  IN_FLIGHT: 'IN_FLIGHT',
  OVERSEAS_STAY: 'OVERSEAS_STAY',
  BRIEFING: 'BRIEFING',
  COMMUTE_DEPARTURE: 'COMMUTE_DEPARTURE',
  COMMUTE_RETURN: 'COMMUTE_RETURN'
};

/**
 * 한국어 방향 조사('로' / '으로') 자동 판별
 * - 받침이 없거나 'ㄹ' 받침(종성 인덱스 0 또는 8)이면 '로' (예: 도쿄로, 하와이로, 파리로, 시애틀로, 몬트리올로)
 * - 그 외 받침이 있으면 '으로' (예: 런던으로, 뉴욕으로, 방콕으로, 인천으로)
 */
export function getDirectionParticle(word) {
  if (!word || typeof word !== 'string') return '로';
  const trimmed = word.trim();
  if (!trimmed) return '로';

  const lastCharCode = trimmed.charCodeAt(trimmed.length - 1);
  // 한글 음절 범위 (가: 0xAC00 ~ 힣: 0xD7A3)
  if (lastCharCode >= 0xAC00 && lastCharCode <= 0xD7A3) {
    const jongseong = (lastCharCode - 0xAC00) % 28;
    // 종성이 없거나(0) 'ㄹ' 받침(8)이면 '로', 나머지 받침은 '으로'
    return (jongseong === 0 || jongseong === 8) ? '로' : '으로';
  }
  return '로';
}

/**
 * Normalizes all saved flights with parsed UTC departure and arrival timestamps.
 */
export function getSortedFlightTimeline() {
  const allMonths = getAllSavedSchedules();
  const flights = [];

  for (const m of allMonths) {
    const timeBasis = m.timeBasis || 'korea';
    const monthFlights = Array.isArray(m.flights) ? m.flights : [];

    for (const f of monthFlights) {
      const depRes = parseFlightTime(f.departure, f.from, timeBasis);
      const arrRes = parseFlightTime(f.arrival, f.to, timeBasis);

      if (depRes.date && arrRes.date) {
        flights.push({
          ...f,
          month: m.month,
          timeBasis,
          depUtc: depRes.date,
          arrUtc: arrRes.date,
          depAirport: getAirport(f.from),
          arrAirport: getAirport(f.to),
          dstWarning: depRes.dstNotice || arrRes.dstNotice || null
        });
      }
    }
  }

  // Sort chronologically by departure UTC
  return flights.sort((a, b) => a.depUtc.getTime() - b.depUtc.getTime());
}

/**
 * Determines current status based on current UTC time and schedule.
 * If no schedule exists for the current month, status is UNKNOWN (does not assume location).
 * 
 * @param {Date} nowUtc
 * @returns {Object} Current status detail
 */
export function determineCurrentStatus(nowUtc = new Date()) {
  const nowTs = nowUtc.getTime();
  
  // Format current year-month YYYY-MM in Korea time
  const currentMonthStr = `${nowUtc.getUTCFullYear()}-${String(nowUtc.getUTCMonth() + 1).padStart(2, '0')}`;
  
  const timeline = getSortedFlightTimeline();

  // 1. If no flights registered anywhere in the system
  if (timeline.length === 0) {
    return {
      status: STATUS_TYPES.UNKNOWN,
      badgeText: '일정 확인 필요',
      badgeType: 'unknown',
      cityHighlight: null,
      destCityName: '위치 미등록',
      title: '일정 확인 필요',
      description: '현재 등록된 비행 일정이 없어요.',
      locationName: '위치 알 수 없음 (일정 미등록)',
      airport: null,
      weatherAirport: null,
      weatherNotice: null,
      coords: null,
      flight: null,
      nextFlight: null,
      progress: 0
    };
  }

  // Check if current month schedule exists and has flights
  const currentMonthSchedule = getMonthSchedule(currentMonthStr);
  const hasCurrentMonthFlights = currentMonthSchedule && Array.isArray(currentMonthSchedule.flights) && currentMonthSchedule.flights.length > 0;

  // 2. Find if currently in flight
  for (let i = 0; i < timeline.length; i++) {
    const f = timeline[i];
    const depTs = f.depUtc.getTime();
    const arrTs = f.arrUtc.getTime();

    if (nowTs >= depTs && nowTs <= arrTs) {
      // IN FLIGHT!
      const totalDuration = arrTs - depTs;
      const elapsed = nowTs - depTs;
      const progress = totalDuration > 0 ? Math.min(1, Math.max(0, elapsed / totalDuration)) : 0;

      const fromCoords = f.depAirport ? [f.depAirport.lat, f.depAirport.lng] : [getHomeBase().lat, getHomeBase().lng];
      const toCoords = f.arrAirport ? [f.arrAirport.lat, f.arrAirport.lng] : [getHomeBase().lat, getHomeBase().lng];

      const planePoint = interpolateGreatCircle(fromCoords, toCoords, progress);
      const heading = calculateBearing(fromCoords, toCoords, progress);

      const targetCity = f.arrAirport ? f.arrAirport.city.split('/')[0] : f.to;
      const depCity = f.depAirport ? f.depAirport.city.split('/')[0] : f.from;
      const dirParticle = getDirectionParticle(targetCity);

      // Check if arriving into Incheon (ICN) or Gimpo (GMP)
      const arrCode = (f.arrAirport?.code || f.to || '').toUpperCase();
      const arrCity = f.arrAirport?.city || '';
      const isReturningToKorea = isKoreaBase(arrCode) || 
                                ['ICN', 'GMP'].includes(arrCode) || 
                                arrCity.includes('인천') || 
                                arrCity.includes('김포') ||
                                String(f.to).includes('인천') ||
                                String(f.to).includes('김포');

      const displayTitle = isReturningToKorea
        ? '엄마는 한국으로 오고 있어요'
        : `엄마는 ${targetCity}${dirParticle} 날아가고 있어요`;

      // Calculate remaining flight time
      const remainingMs = Math.max(0, arrTs - nowTs);
      const remainingTotalMin = Math.round(remainingMs / (1000 * 60));
      const remainingH = Math.floor(remainingTotalMin / 60);
      const remainingM = remainingTotalMin % 60;
      let remainingFormatted = '';
      if (remainingH > 0 && remainingM > 0) {
        remainingFormatted = `${remainingH}시간 ${remainingM}분`;
      } else if (remainingH > 0) {
        remainingFormatted = `${remainingH}시간`;
      } else if (remainingM > 0) {
        remainingFormatted = `${remainingM}분`;
      } else {
        remainingFormatted = '1분 미만';
      }
      const remainingTimeText = `남은 비행시간 ${remainingFormatted}`;

      return {
        status: STATUS_TYPES.IN_FLIGHT,
        badgeText: '예정상 비행 중',
        badgeType: 'flight',
        isReturningToKorea,
        cityHighlight: isReturningToKorea ? '한국' : targetCity,
        destCityName: targetCity,
        title: displayTitle,
        description: `${f.number} · ${depCity} → ${targetCity}`,
        locationName: `${f.from} ➔ ${f.to}`,
        airport: f.arrAirport, // Weather is for arrival destination
        weatherAirport: f.arrAirport,
        weatherNotice: '도착지 기준 날씨',
        coords: [planePoint.lat, planePoint.lng],
        heading,
        flight: f,
        nextFlight: timeline[i + 1] || null,
        progress,
        remainingMs,
        remainingFormatted,
        remainingTimeText,
        flightPath: generateGreatCirclePath(fromCoords, toCoords)
      };
    }
  }

  // 3. Find previous flight and next flight relative to now
  let prevFlight = null;
  let nextFlight = null;

  for (let i = 0; i < timeline.length; i++) {
    const f = timeline[i];
    if (f.arrUtc.getTime() < nowTs) {
      prevFlight = f;
    } else if (f.depUtc.getTime() > nowTs && !nextFlight) {
      nextFlight = f;
    }
  }

  // 3-1. Check if upcoming flight departs from Korea and is currently in briefing lead time
  // Domestic: 1 hour 10 mins (70m), International: 1 hour 45 mins (105m) before departure
  if (nextFlight) {
    const isDepartingKorea = isKoreaBase(nextFlight.from) || (nextFlight.depAirport && nextFlight.depAirport.country === '대한민국');
    if (isDepartingKorea) {
      const isDomestic = isKoreaBase(nextFlight.to) || (nextFlight.arrAirport && nextFlight.arrAirport.country === '대한민국');
      const briefingLeadMs = isDomestic ? (70 * 60 * 1000) : (105 * 60 * 1000);
      const depTs = nextFlight.depUtc.getTime();
        const depAirport = nextFlight.depAirport || getAirport(nextFlight.from) || GWACHEON_BASE;
        const arrAirport = nextFlight.arrAirport || getAirport(nextFlight.to);
        const depCity = depAirport ? depAirport.city.split('/')[0] : nextFlight.from;
        const arrCity = arrAirport ? arrAirport.city.split('/')[0] : nextFlight.to;
        const coords = depAirport ? [depAirport.lat, depAirport.lng] : [getHomeBase().lat, getHomeBase().lng];

      if (nowTs >= depTs - briefingLeadMs && nowTs < depTs) {
        const remainingMs = Math.max(0, depTs - nowTs);
        const remainingTotalMin = Math.round(remainingMs / (1000 * 60));
        const remainingH = Math.floor(remainingTotalMin / 60);
        const remainingM = remainingTotalMin % 60;
        let remainingFormatted = '';
        if (remainingH > 0 && remainingM > 0) {
          remainingFormatted = `${remainingH}시간 ${remainingM}분`;
        } else if (remainingH > 0) {
          remainingFormatted = `${remainingH}시간`;
        } else if (remainingM > 0) {
          remainingFormatted = `${remainingM}분`;
        } else {
          remainingFormatted = '1분 미만';
        }


        return {
          status: STATUS_TYPES.BRIEFING,
          badgeText: '브리핑 중',
          badgeType: 'briefing',
          cityHighlight: depCity,
          destCityName: depCity,
          title: '엄마는 비행 브리핑 중이에요',
          description: `${nextFlight.number} 탑승 준비 · ${depCity} → ${arrCity} (출발 ${remainingFormatted} 전)`,
          locationName: depAirport ? `${depAirport.name} (${depAirport.code})` : `${depCity} 공항`,
          airport: depAirport,
          weatherAirport: depAirport,
          weatherNotice: '출발 공항 기준 날씨',
          coords,
          flight: nextFlight,
          nextFlight,
          progress: 0,
          remainingMs,
          remainingFormatted,
          isDomestic,
          flightPath: depAirport && arrAirport
            ? generateGreatCirclePath([depAirport.lat, depAirport.lng], [arrAirport.lat, arrAirport.lng])
            : null
        };
      }

      // Check Commute Departure status (출근 중 - 집에서 공항으로 이동)
      const home = getHomeBase();
      const commuteMinutes = calculateCommuteMinutes(home, depAirport);
      const commuteMs = commuteMinutes * 60 * 1000;
      const commuteStartTs = depTs - briefingLeadMs - commuteMs;

      if (nowTs >= commuteStartTs && nowTs < depTs - briefingLeadMs) {
        const remainingMs = Math.max(0, depTs - briefingLeadMs - nowTs);
        const remainingTotalMin = Math.round(remainingMs / (1000 * 60));
        const remainingH = Math.floor(remainingTotalMin / 60);
        const remainingM = remainingTotalMin % 60;
        let remainingFormatted = '';
        if (remainingH > 0 && remainingM > 0) {
          remainingFormatted = `${remainingH}시간 ${remainingM}분`;
        } else if (remainingH > 0) {
          remainingFormatted = `${remainingH}시간`;
        } else if (remainingM > 0) {
          remainingFormatted = `${remainingM}분`;
        } else {
          remainingFormatted = '1분 미만';
        }

        const elapsed = nowTs - commuteStartTs;
        const progress = commuteMs > 0 ? Math.min(1, Math.max(0, elapsed / commuteMs)) : 0;
        const currLat = home.lat + (depAirport.lat - home.lat) * progress;
        const currLng = home.lng + (depAirport.lng - home.lng) * progress;
        const airportNameOnly = depCity.endsWith('공항') ? depCity : `${depCity}공항`;

        return {
          status: STATUS_TYPES.COMMUTE_DEPARTURE,
          badgeText: '출근 중',
          badgeType: 'commute',
          cityHighlight: airportNameOnly,
          destCityName: airportNameOnly,
          title: `엄마는 ${airportNameOnly}으로 출근 중이에요`,
          description: `공항으로 이동 중이에요 (브리핑까지 약 ${remainingFormatted})`,
          locationName: `${airportNameOnly} 이동 중`,
          airport: depAirport,
          weatherAirport: depAirport,
          weatherNotice: '출발 공항 기준 날씨',
          coords: [currLat, currLng],
          homeCoords: [home.lat, home.lng],
          targetCoords: [depAirport.lat, depAirport.lng],
          flight: nextFlight,
          nextFlight,
          progress,
          remainingMs,
          remainingFormatted,
          commuteMinutes,
          isDomestic,
          flightPath: [[home.lat, home.lng], [depAirport.lat, depAirport.lng]]
        };
      }

    }
  }
  // 3-2. Check return commute if previous flight arrived in Korea (퇴근 중 - 공항에서 집으로 이동)
  if (prevFlight && (!nextFlight || nextFlight.depUtc.getTime() > nowTs)) {
    const isArrivingKorea = isKoreaBase(prevFlight.to) || (prevFlight.arrAirport && prevFlight.arrAirport.country === '대한민국');
    if (isArrivingKorea) {
      const home = getHomeBase();
      const arrAirport = prevFlight.arrAirport || getAirport(prevFlight.to) || GWACHEON_BASE;
      const commuteMinutes = calculateCommuteMinutes(home, arrAirport);
      const commuteMs = commuteMinutes * 60 * 1000;
      const arrTs = prevFlight.arrUtc.getTime();
      const commuteEndTs = arrTs + commuteMs;

      if (nowTs >= arrTs && nowTs < commuteEndTs) {
        const remainingMs = Math.max(0, commuteEndTs - nowTs);
        const remainingTotalMin = Math.round(remainingMs / (1000 * 60));
        const remainingH = Math.floor(remainingTotalMin / 60);
        const remainingM = remainingTotalMin % 60;
        let remainingFormatted = '';
        if (remainingH > 0 && remainingM > 0) {
          remainingFormatted = `${remainingH}시간 ${remainingM}분`;
        } else if (remainingH > 0) {
          remainingFormatted = `${remainingH}시간`;
        } else if (remainingM > 0) {
          remainingFormatted = `${remainingM}분`;
        } else {
          remainingFormatted = '1분 미만';
        }

        const elapsed = nowTs - arrTs;
        const progress = commuteMs > 0 ? Math.min(1, Math.max(0, elapsed / commuteMs)) : 0;
        const currLat = arrAirport.lat + (home.lat - arrAirport.lat) * progress;
        const currLng = arrAirport.lng + (home.lng - arrAirport.lng) * progress;

        return {
          status: STATUS_TYPES.COMMUTE_RETURN,
          badgeText: '퇴근 중',
          badgeType: 'commute',
          cityHighlight: '우리 집',
          destCityName: '우리 집',
          title: '엄마는 집으로 퇴근 중이에요',
          description: `집으로 이동 중이에요 (집 도착까지 약 ${remainingFormatted})`,
          locationName: '우리 집 이동 중',
          airport: GWACHEON_BASE,
          weatherAirport: GWACHEON_BASE,
          weatherNotice: '우리 집 기준 날씨',
          coords: [currLat, currLng],
          homeCoords: [home.lat, home.lng],
          targetCoords: [arrAirport.lat, arrAirport.lng],
          flight: prevFlight,
          nextFlight,
          progress,
          remainingMs,
          remainingFormatted,
          commuteMinutes,
          flightPath: [[arrAirport.lat, arrAirport.lng], [home.lat, home.lng]]
        };
      }
    }
  }


  // If currently in an overseas stay resulting from a previous flight
  if (prevFlight && !isKoreaBase(prevFlight.to) && (!nextFlight || nextFlight.depUtc.getTime() > nowTs)) {
    const airport = prevFlight.arrAirport || getAirport(prevFlight.to);
    const city = airport ? airport.city.split('/')[0] : prevFlight.to;
    const coords = airport ? [airport.lat, airport.lng] : [getHomeBase().lat, getHomeBase().lng];
    const nextDepCity = nextFlight && nextFlight.depAirport ? nextFlight.depAirport.city.split('/')[0] : (nextFlight ? nextFlight.from : '');
    const nextCity = nextFlight && nextFlight.arrAirport ? nextFlight.arrAirport.city.split('/')[0] : (nextFlight ? nextFlight.to : '');

    return {
      status: STATUS_TYPES.OVERSEAS_STAY,
      badgeText: '예정상 해외 체류 중',
      badgeType: 'stay',
      cityHighlight: city,
      destCityName: city,
      title: `엄마는 ${city}에 머무르고 있어요`,
      description: nextFlight ? `${prevFlight.number} 도착 후 체류 중 · 다음 비행: ${nextFlight.number} (${nextDepCity || prevFlight.to} → ${nextCity || nextFlight.to})` : `${prevFlight.number} 도착 후 현지 체류 중`,
      locationName: airport ? `${airport.city} (${airport.code})` : prevFlight.to,
      airport: airport || getHomeBase(),
      weatherAirport: airport || getHomeBase(),
      weatherNotice: '현지 기준 날씨',
      coords,
      flight: prevFlight,
      nextFlight,
      progress: 0,
      nextFlightPath: nextFlight && nextFlight.depAirport && nextFlight.arrAirport
        ? generateGreatCirclePath([nextFlight.depAirport.lat, nextFlight.depAirport.lng], [nextFlight.arrAirport.lat, nextFlight.arrAirport.lng])
        : null
    };
  }

  // 4. "현재 월 일정이 없으면 현재 위치를 단정하지 않습니다." (Spec 4 requirement)
  if (!hasCurrentMonthFlights) {
    return {
      status: STATUS_TYPES.UNKNOWN,
      badgeText: '일정 확인 필요',
      badgeType: 'unknown',
      cityHighlight: null,
      destCityName: '일정 미등록',
      title: '일정 확인 필요',
      description: `${currentMonthStr} 일정이 등록되지 않아 현재 위치를 알 수 없어요.`,
      locationName: '위치 확인 불가 (일정 미등록)',
      airport: null,
      weatherAirport: null,
      weatherNotice: null,
      coords: null,
      flight: null,
      nextFlight: nextFlight || null,
      progress: 0
    };
  }

  // 5. If has schedule in current month and at home base
  const nextDepCity = nextFlight && nextFlight.depAirport ? nextFlight.depAirport.city.split('/')[0] : (nextFlight ? nextFlight.from : '');
  const nextCity = nextFlight && nextFlight.arrAirport ? nextFlight.arrAirport.city.split('/')[0] : (nextFlight ? nextFlight.to : '');
  return {
    status: STATUS_TYPES.HOME,
    badgeText: '우리 집 (한국)',
    badgeType: 'home',
    cityHighlight: '우리 집',
    destCityName: '우리 집 (과천)',
    title: '엄마는 우리 집에 있어요',
    description: nextFlight ? `다음 비행: ${nextFlight.number} · ${nextDepCity} → ${nextCity || nextFlight.to}` : '현재 예정된 비행 일정이 없어요.',
    locationName: '과천 (집)',
    airport: GWACHEON_BASE,
    weatherAirport: GWACHEON_BASE,
    weatherNotice: null,
    coords: [getHomeBase().lat, getHomeBase().lng],
    flight: null,
    nextFlight,
    progress: 0,
    nextFlightPath: nextFlight && nextFlight.depAirport && nextFlight.arrAirport
      ? generateGreatCirclePath([nextFlight.depAirport.lat, nextFlight.depAirport.lng], [nextFlight.arrAirport.lat, nextFlight.arrAirport.lng])
      : null
  };
}

/**
 * Spherical linear interpolation (Slerp) on unit sphere for exact Great Circle navigation.
 * Handles date line and all globe wraps without distortion.
 */
export function interpolateGreatCircle([lat1, lng1], [lat2, lng2], fraction) {
  const f = Math.min(1, Math.max(0, fraction));
  if (f === 0) return { lat: lat1, lng: lng1 };
  if (f === 1) return { lat: lat2, lng: lng2 };

  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;

  const phi1 = lat1 * toRad;
  const lambda1 = lng1 * toRad;
  const phi2 = lat2 * toRad;
  const lambda2 = lng2 * toRad;

  // 3D unit vectors
  const v1 = [
    Math.cos(phi1) * Math.cos(lambda1),
    Math.cos(phi1) * Math.sin(lambda1),
    Math.sin(phi1)
  ];
  const v2 = [
    Math.cos(phi2) * Math.cos(lambda2),
    Math.cos(phi2) * Math.sin(lambda2),
    Math.sin(phi2)
  ];

  // Dot product
  let dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  dot = Math.max(-1, Math.min(1, dot));

  const omega = Math.acos(dot);
  if (Math.abs(omega) < 1e-6) {
    return { lat: lat1, lng: lng1 };
  }

  const sinOmega = Math.sin(omega);
  const s1 = Math.sin((1 - f) * omega) / sinOmega;
  const s2 = Math.sin(f * omega) / sinOmega;

  const vx = s1 * v1[0] + s2 * v2[0];
  const vy = s1 * v1[1] + s2 * v2[1];
  const vz = s1 * v1[2] + s2 * v2[2];

  const lat = Math.atan2(vz, Math.sqrt(vx * vx + vy * vy)) * toDeg;
  let lng = Math.atan2(vy, vx) * toDeg;

  return { lat, lng };
}

/**
 * Computes bearing (heading in degrees 0..360) along the great circle path at progress fraction.
 */
export function calculateBearing([lat1, lng1], [lat2, lng2], fraction = 0) {
  const step = 0.01;
  const p1 = interpolateGreatCircle([lat1, lng1], [lat2, lng2], Math.max(0, fraction - step));
  const p2 = interpolateGreatCircle([lat1, lng1], [lat2, lng2], Math.min(1, fraction + step));

  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;

  const phi1 = p1.lat * toRad;
  const phi2 = p2.lat * toRad;
  const dLambda = (p2.lng - p1.lng) * toRad;

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const brng = Math.atan2(y, x) * toDeg;

  return (brng + 360) % 360;
}

/**
 * Generates array of coordinate segments for Leaflet polyline.
 * Splits cleanly across the antimeridian (180th meridian) so paths across the Pacific don't wrap the globe backwards.
 */
export function generateGreatCirclePath([lat1, lng1], [lat2, lng2], numPoints = 80) {
  const segments = [[]];
  let currentSegment = segments[0];

  let prevLng = null;
  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints;
    const pt = interpolateGreatCircle([lat1, lng1], [lat2, lng2], f);

    // If antimeridian crossed (large longitude jump > 180 deg)
    if (prevLng !== null && Math.abs(pt.lng - prevLng) > 180) {
      // Split into new segment
      currentSegment = [];
      segments.push(currentSegment);
    }

    currentSegment.push([pt.lat, pt.lng]);
    prevLng = pt.lng;
  }

  return segments;
}
