/**
 * flying mom - Home Location Manager
 * Manages user-defined home location, address geocoding via Kakao Postcode, GPS lookup, and Leaflet interactive map picker.
 */

import { getHomeBase, saveHomeBase, resetHomeBase, GWACHEON_BASE } from './airports.js';
import { getCurrentThemeConfig } from './theme.js';

let pickerMap = null;
let pickerMarker = null;

/**
 * Initializes home location manager event listeners
 */
export function initHomeManager() {
  const btnOpen = document.getElementById('btn-open-home-modal');
  const btnClose = document.getElementById('btn-close-home-modal');
  const btnCancel = document.getElementById('btn-cancel-home');
  const btnSave = document.getElementById('btn-save-home');
  const btnReset = document.getElementById('btn-reset-home-default');
  const btnGps = document.getElementById('btn-home-gps');
  const btnDaum = document.getElementById('btn-daum-postcode');
  const addrInput = document.getElementById('input-home-address');
  const latInput = document.getElementById('input-home-lat');
  const lngInput = document.getElementById('input-home-lng');

  btnOpen?.addEventListener('click', () => {
    openHomeModal();
  });

  btnClose?.addEventListener('click', () => {
    closeHomeModal();
  });

  btnCancel?.addEventListener('click', () => {
    closeHomeModal();
  });

  btnSave?.addEventListener('click', () => {
    handleSaveHome();
  });

  btnReset?.addEventListener('click', () => {
    handleResetHome();
  });

  // Clicking either the address input box or the "주소 검색" button triggers Kakao Postcode
  addrInput?.addEventListener('click', () => {
    handleDaumPostcode();
  });

  btnDaum?.addEventListener('click', () => {
    handleDaumPostcode();
  });

  btnGps?.addEventListener('click', () => {
    handleGpsLocation();
  });

  // Coordinate manual inputs change listener
  const updateFromCoords = () => {
    const lat = parseFloat(latInput?.value);
    const lng = parseFloat(lngInput?.value);
    if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      updatePickerMarker(lat, lng, false);
      if (pickerMap) {
        pickerMap.panTo([lat, lng]);
      }
    }
  };

  latInput?.addEventListener('change', updateFromCoords);
  lngInput?.addEventListener('change', updateFromCoords);
}

/**
 * Opens the home location modal and populates with current data
 */
export function openHomeModal() {
  const modal = document.getElementById('home-modal');
  if (!modal) return;

  const currentHome = getHomeBase();
  const nameInput = document.getElementById('input-home-name');
  const addrInput = document.getElementById('input-home-address');
  const detailInput = document.getElementById('input-home-address-detail');
  const latInput = document.getElementById('input-home-lat');
  const lngInput = document.getElementById('input-home-lng');
  const displayName = document.getElementById('home-display-name');
  const displayAddress = document.getElementById('home-display-address');
  const currentBadge = document.getElementById('home-current-badge');

  if (nameInput) nameInput.value = currentHome.name || '우리 집';
  if (addrInput) addrInput.value = currentHome.address || '';
  if (detailInput) detailInput.value = '';
  if (latInput) latInput.value = Number(currentHome.lat).toFixed(6);
  if (lngInput) lngInput.value = Number(currentHome.lng).toFixed(6);

  if (displayName) displayName.textContent = currentHome.name || '우리 집';
  if (displayAddress) displayAddress.textContent = currentHome.address || '대한민국';

  const isCustom = localStorage.getItem('flyingmom_home_base') !== null;
  if (currentBadge) {
    currentBadge.textContent = isCustom ? '사용자 등록 위치' : '기본값 (과천 본가)';
  }

  modal.classList.add('is-active');
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');

  // Initialize or re-center interactive picker map
  setTimeout(() => {
    setupPickerMap(currentHome.lat, currentHome.lng);
  }, 150);
}

/**
 * Closes the home location modal
 */
export function closeHomeModal() {
  const modal = document.getElementById('home-modal');
  if (!modal) return;
  modal.classList.remove('is-active');
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
}

/**
 * Initializes Leaflet map inside the modal
 */
function setupPickerMap(lat, lng) {
  const canvasEl = document.getElementById('home-picker-map');
  if (!canvasEl || !window.L) return;

  const L = window.L;

  if (!pickerMap) {
    pickerMap = L.map('home-picker-map', {
      center: [lat, lng],
      zoom: 14,
      zoomControl: true,
      attributionControl: false
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      subdomains: ['a', 'b', 'c']
    }).addTo(pickerMap);

    // Map click moves marker
    pickerMap.on('click', (e) => {
      const { lat: clickedLat, lng: clickedLng } = e.latlng;
      updatePickerMarker(clickedLat, clickedLng, true);
      reverseGeocode(clickedLat, clickedLng);
    });
  } else {
    pickerMap.invalidateSize();
    pickerMap.setView([lat, lng], 14);
  }

  updatePickerMarker(lat, lng, false);
}

/**
 * Updates marker on the picker map
 */
function updatePickerMarker(lat, lng, syncInputs = true) {
  if (!pickerMap || !window.L) return;
  const L = window.L;
  const theme = getCurrentThemeConfig();

  const homeSvg = `
    <div style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: #ffffff; border: 2.5px solid ${theme.primaryColor || '#1a73e8'}; border-radius: 50%; box-shadow: 0 3px 8px rgba(0,0,0,0.3);">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="${theme.primaryColor || '#1a73e8'}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
    </div>
  `;

  const customIcon = L.divIcon({
    className: 'picker-home-marker',
    html: homeSvg,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });

  if (pickerMarker) {
    pickerMarker.setLatLng([lat, lng]);
  } else {
    pickerMarker = L.marker([lat, lng], {
      icon: customIcon,
      draggable: true
    }).addTo(pickerMap);

    pickerMarker.on('dragend', () => {
      const pos = pickerMarker.getLatLng();
      updatePickerMarker(pos.lat, pos.lng, true);
      reverseGeocode(pos.lat, pos.lng);
    });
  }

  if (syncInputs) {
    const latInput = document.getElementById('input-home-lat');
    const lngInput = document.getElementById('input-home-lng');
    if (latInput) latInput.value = Number(lat).toFixed(6);
    if (lngInput) lngInput.value = Number(lng).toFixed(6);
  }
}

/**
 * Generates smart address candidates for geocoding.
 */
function generateAddressCandidates(raw) {
  const clean = raw.trim();
  const candidates = [];

  // 1. Korean road names: attach numbers/길/로 (과천대로 8길 -> 과천대로8길)
  const normRoad = clean.replace(/([가-힣]+(?:대로|로|길))\s+(\d+(?:번?길)?)/g, '$1$2');
  if (normRoad !== clean) {
    candidates.push(normRoad);
  }
  candidates.push(clean);

  // 2. Strip trailing building/house number
  const noNum = normRoad.replace(/\s+\d+(?:-\d+)?$/, '').trim();
  if (noNum && noNum !== normRoad && !candidates.includes(noNum)) {
    candidates.push(noNum);
  }

  // 3. Strip sub-road (e.g. '과천대로8길' -> '과천대로')
  const primaryRoad = noNum.replace(/\d+번?길$/, '').trim();
  if (primaryRoad && primaryRoad !== noNum && !candidates.includes(primaryRoad)) {
    candidates.push(primaryRoad);
  }

  // 4. Try words slice if multi-word
  const words = clean.split(/\s+/);
  if (words.length >= 3) {
    const sub = words.slice(-2).join(' ').replace(/([가-힣]+(?:대로|로|길))\s+(\d+(?:번?길)?)/g, '$1$2');
    if (!candidates.includes(sub)) {
      candidates.push(sub);
    }
  }

  return candidates;
}

/**
 * Geocode query via Nominatim and return {lat, lng} or null
 */
async function geocodeAddress(query) {
  const candidates = generateAddressCandidates(query);

  for (const cand of candidates) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cand)}&limit=1`;
      const resp = await fetch(url, {
        headers: { 'Accept-Language': 'ko,en' }
      });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
          return {
            lat: parseFloat(data[0].lat),
            lng: parseFloat(data[0].lon)
          };
        }
      }
    } catch (e) {
      // Continue next candidate
    }
  }
  return null;
}

/**
 * Daum / Kakao Postcode official address search integration
 */
export function handleDaumPostcode() {
  if (!window.daum || !window.daum.Postcode) {
    alert('카카오 주소 검색 모듈을 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
    return;
  }

  new window.daum.Postcode({
    oncomplete: async (data) => {
      // Full road or jibun address
      const roadAddr = data.roadAddress || data.jibunAddress;
      const extraAddr = data.buildingName ? ` (${data.buildingName})` : '';
      const fullDisplayAddr = roadAddr + extraAddr;

      const addrInput = document.getElementById('input-home-address');
      const detailInput = document.getElementById('input-home-address-detail');

      if (addrInput) addrInput.value = fullDisplayAddr;
      if (detailInput) detailInput.focus();

      // Geocode and update coordinates and map
      let coords = await geocodeAddress(roadAddr);

      // Fallback 1: try jibun address if road address geocoding failed
      if (!coords && data.jibunAddress) {
        coords = await geocodeAddress(data.jibunAddress);
      }

      // Fallback 2: try sigungu + bname (e.g. 과천시 갈현동)
      if (!coords && (data.sigungu || data.sido)) {
        const fallbackRegion = `${data.sido || ''} ${data.sigungu || ''} ${data.bname || ''}`.trim();
        if (fallbackRegion) {
          coords = await geocodeAddress(fallbackRegion);
        }
      }

      if (coords && !isNaN(coords.lat) && !isNaN(coords.lng)) {
        updatePickerMarker(coords.lat, coords.lng, true);
        if (pickerMap) {
          pickerMap.setView([coords.lat, coords.lng], 16);
        }
      }
    }
  }).open();
}

/**
 * Reverse geocode coords into human readable address
 */
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
    const resp = await fetch(url, {
      headers: { 'Accept-Language': 'ko,en' }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && data.display_name) {
      const addrInput = document.getElementById('input-home-address');
      if (addrInput && !addrInput.value) {
        addrInput.value = data.display_name;
      }
    }
  } catch (e) {
    // Graceful fallback
  }
}

/**
 * Get device GPS coordinates
 */
function handleGpsLocation() {
  if (!navigator.geolocation) {
    alert('사용 중인 브라우저 또는 기기에서 GPS 위치 기능을 지원하지 않습니다.');
    return;
  }

  const btnGps = document.getElementById('btn-home-gps');
  const originalText = btnGps?.innerHTML;
  if (btnGps) {
    btnGps.disabled = true;
    btnGps.innerHTML = '현재 위치를 찾는 중...';
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (btnGps) {
        btnGps.disabled = false;
        btnGps.innerHTML = originalText;
      }
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      updatePickerMarker(lat, lng, true);
      if (pickerMap) {
        pickerMap.setView([lat, lng], 15);
      }
      reverseGeocode(lat, lng);
      alert('현재 위치 좌표가 설정되었습니다. 상세 주소와 명칭을 확인한 뒤 [저장하기]를 눌러주세요.');
    },
    (err) => {
      if (btnGps) {
        btnGps.disabled = false;
        btnGps.innerHTML = originalText;
      }
      alert('현재 위치를 가져오지 못했습니다. 위치 권한 허용 여부를 확인해주세요. 지도를 직접 터치하여 지정할 수도 있습니다.');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

/**
 * Save home location
 */
function handleSaveHome() {
  const nameInput = document.getElementById('input-home-name');
  const addrInput = document.getElementById('input-home-address');
  const detailInput = document.getElementById('input-home-address-detail');
  const latInput = document.getElementById('input-home-lat');
  const lngInput = document.getElementById('input-home-lng');

  const name = (nameInput?.value || '').trim() || '우리 집';
  const baseAddr = (addrInput?.value || '').trim();
  const detailAddr = (detailInput?.value || '').trim();

  let address = baseAddr;
  if (detailAddr) {
    address = baseAddr ? `${baseAddr} ${detailAddr}` : detailAddr;
  }

  const lat = parseFloat(latInput?.value);
  const lng = parseFloat(lngInput?.value);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    alert('유효한 위도와 경도 좌표를 지정해주세요. (지도를 클릭하거나 주소를 검색하면 자동으로 입력됩니다.)');
    return;
  }

  const city = name;
  const homeData = {
    code: 'HOME',
    name: name,
    address: address || `${name} (대한민국)`,
    city: city,
    cityEn: 'Home',
    country: '대한민국',
    countryEn: 'South Korea',
    lat: lat,
    lng: lng,
    tz: 'Asia/Seoul'
  };

  const ok = saveHomeBase(homeData);
  if (ok) {
    closeHomeModal();
    alert(`집 위치가 "${name}"(으)로 성공적으로 등록되었습니다.`);
  } else {
    alert('저장 중 오류가 발생했습니다.');
  }
}

/**
 * Reset home location to Gwacheon default
 */
function handleResetHome() {
  if (confirm('집 위치를 기본값(과천 본가)으로 복원하시겠습니까?')) {
    resetHomeBase();
    openHomeModal(); // re-populate
    alert('집 위치가 기본값(과천 본가)으로 복원되었습니다.');
  }
}
