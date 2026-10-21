/**
 * a flying mom - Theme Manager Module
 * 
 * Supports 3 distinct airline/flight themes:
 * 1. 'default'   : Google Flights (https://www.google.com/travel/flights)
 * 2. 'asiana'    : Asiana Airlines (https://flyasiana.com/ - Official Tail Fin Saekdong Favicon)
 * 3. 'koreanair' : Korean Air (https://www.koreanair.com/ - 2025 New CI Monochrome Dark Blue Taegeuk)
 * 
 * Changing the theme updates:
 * - CSS variables via html[data-theme="..."]
 * - Header brand icon & theme toggle button icon
 * - Browser favicon SVG
 * - Interactive map pin, airplane marker, and flight path colors
 */

const THEME_STORAGE_KEY = 'flyingmom_theme';

// Korean Air 2025 New CI Monochrome Dark Blue Taegeuk SVG Path
const KOREAN_AIR_2025_PATH = 'M19.7218 222.0202l-1.1905.8189C42.7729 267.5282 88.6529 297.7182 141 297.7182c77.8539 0 140.9099-66.626 140.9099-148.7171 0-22.6069-9.3689-41.642-20.4479-56.0679-14.723-19.185-35.692-28.405-56.587-28.554-17.251-.1481-35.096 5.652-47.665 17.028-14.351 13.013-17.548 29.745-21.266 56.8849-4.089 29.744-28.0331 50.267-58.8171 50.267-39.857 0-64.5433-24.538-62.9082-62.09.1494-2.6029.3717-5.2039.8185-7.732C22.547 74.4192 70.212 28.6886 141.893 28.8361c48.1099 0 84.248 10.7819 120.3869 47.1431l1.191-.816C239.2289 30.4731 193.424.2819 141 .2819 63.221.2819.09 66.9072.09 149.0011c0 22.604 9.3692 41.64 20.4502 56.065 14.648 19.185 35.6928 28.33 56.5867 28.5551 17.251.2219 35.0971-5.6531 47.663-17.029 14.3531-13.0131 17.5501-29.7431 21.2671-56.8841 4.09-29.745 28.1069-50.2679 58.818-50.2679 39.93 0 64.618 24.539 62.981 62.0899-.1471 2.6031-.3721 5.206-.8161 7.735-7.6599 44.317-55.0999 90.0481-126.9309 89.8981-48.1111 0-84.248-10.781-120.3872-47.143';

function getAsianaTailFinSvg(size = 22, clipId = 'asiana-tail-clip') {
  return `
    <svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clip-path="url(#${clipId})">
        <!-- Upper Warm Gray Tip -->
        <path d="M 4 56 L 44 10 L 62 10 L 42 56 Z" fill="#9E9B95"/>
        <!-- Left Crimson Red Leading Edge -->
        <path d="M 4 56 L 40 15 L 30 56 Z" fill="#C60C30"/>
        <!-- Inner Red-Orange Band -->
        <path d="M 18 56 L 34 32 L 26 56 Z" fill="#EF4123"/>
        <!-- Middle Saekdong Yellow Band -->
        <path d="M 33 34 L 54 21 L 47 38 L 28 48 Z" fill="#F6C500"/>
        <!-- Bottom Saekdong Deep Blue Base -->
        <path d="M 26 56 L 30 46 L 47 38 L 42 56 Z" fill="#1F2A8C"/>
      </g>
      <defs>
        <clipPath id="${clipId}">
          <path d="M 6 54 L 44 10 C 45 9 46.5 8.5 48 8.5 L 59 8.5 C 60.5 8.5 61 9.5 60.5 11 L 43 54 C 42.5 55.2 41.2 56 39.5 56 L 7.5 56 C 6 56 5.2 55 6 54 Z"/>
        </clipPath>
      </defs>
    </svg>
  `;
}

function getKoreanAir2025Svg(size = 22) {
  return `
    <svg viewBox="-20 -12 322 322" width="${size}" height="${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="141" cy="149" r="158" fill="#ffffff"/>
      <path d="${KOREAN_AIR_2025_PATH}" fill="#051766"/>
    </svg>
  `;
}

export const THEMES = {
  default: {
    id: 'default',
    name: '기본 (Google Flights)',
    shortName: '기본',
    primaryColor: '#1A73E8',
    destPinColor: '#10b981',
    depPinColor: '#6b7280',
    flightPathColor: '#8AB4F8',
    airplaneColor: '#1A73E8',
    airplaneStroke: '#ffffff',
    brandIconHtml: `
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#1a73e8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.3c.4-.2.6-.6.5-1.1z"/>
      </svg>
    `,
    toggleIconHtml: `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#1a73e8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.3c.4-.2.6-.6.5-1.1z"/>
      </svg>
    `,
    faviconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#1a73e8"/><path d="M45 47 41 29l8-8c3-3 4-7 2.5-8.5-1.5-1.5-5.5-.5-8.5 2.5l-8 8-18-4-3 3 13 8-5 7h-6l-2 2 7 4 4 7 2-2v-6l7-5 8 13 3-3z" fill="#ffffff"/></svg>`
  },
  asiana: {
    id: 'asiana',
    name: '아시아나항공 (Asiana Airlines)',
    shortName: '아시아나',
    primaryColor: '#D60815',
    destPinColor: '#F39800',
    depPinColor: '#737272',
    flightPathColor: '#E45A63',
    airplaneColor: '#D60815',
    airplaneStroke: '#ffffff',
    // Asiana Homepage Favicon (Tail Fin Saekdong Icon)
    brandIconHtml: getAsianaTailFinSvg(23, 'asiana-brand-clip'),
    toggleIconHtml: getAsianaTailFinSvg(18, 'asiana-toggle-clip'),
    faviconSvg: getAsianaTailFinSvg(64, 'asiana-fav-clip').trim()
  },
  koreanair: {
    id: 'koreanair',
    name: '대한항공 (Korean Air)',
    shortName: '대한항공',
    primaryColor: '#051766',
    destPinColor: '#1D57A5',
    depPinColor: '#5B6B7C',
    flightPathColor: '#3B68B5',
    airplaneColor: '#051766',
    airplaneStroke: '#ffffff',
    // Korean Air 2025 New CI Monochrome Dark Blue Taegeuk Icon
    brandIconHtml: getKoreanAir2025Svg(22),
    toggleIconHtml: getKoreanAir2025Svg(18),
    faviconSvg: getKoreanAir2025Svg(64).trim()
  }
};

let currentThemeId = 'default';
const themeChangeListeners = new Set();

/**
 * Get current active theme configuration object
 */
export function getCurrentThemeConfig() {
  return THEMES[currentThemeId] || THEMES.default;
}

/**
 * Subscribe to theme changes
 */
export function onThemeChange(callback) {
  if (typeof callback === 'function') {
    themeChangeListeners.add(callback);
  }
  return () => themeChangeListeners.delete(callback);
}

/**
 * Initialize theme switcher UI and apply saved theme
 */
export function initThemeSwitcher() {
  // Load saved theme from localStorage
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved && THEMES[saved]) {
      currentThemeId = saved;
    }
  } catch (_) {}

  applyTheme(currentThemeId, false);

  const toggleBtn = document.getElementById('btn-theme-toggle');
  const popover = document.getElementById('theme-selector-popover');
  const wrapper = document.getElementById('theme-switcher-wrapper');

  if (!toggleBtn || !popover) return;

  // Toggle o o o popover on button click
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = popover.classList.contains('is-open');
    setPopoverOpen(!isOpen);
  });

  // Theme option click handlers
  const optionButtons = popover.querySelectorAll('[data-theme-option]');
  optionButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetTheme = btn.getAttribute('data-theme-option');
      if (targetTheme && THEMES[targetTheme]) {
        applyTheme(targetTheme, true);
        setPopoverOpen(false);
      }
    });
  });

  // Close popover when clicking outside
  document.addEventListener('click', (e) => {
    if (wrapper && !wrapper.contains(e.target)) {
      setPopoverOpen(false);
    }
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setPopoverOpen(false);
    }
  });

  // Listen for cross-tab theme changes
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY && e.newValue && THEMES[e.newValue]) {
      applyTheme(e.newValue, false);
    }
  });
}

function setPopoverOpen(open) {
  const toggleBtn = document.getElementById('btn-theme-toggle');
  const popover = document.getElementById('theme-selector-popover');
  if (!toggleBtn || !popover) return;

  if (open) {
    popover.classList.add('is-open');
    popover.setAttribute('aria-hidden', 'false');
    toggleBtn.setAttribute('aria-expanded', 'true');
  } else {
    popover.classList.remove('is-open');
    popover.setAttribute('aria-hidden', 'true');
    toggleBtn.setAttribute('aria-expanded', 'false');
  }
}

/**
 * Apply the selected theme across DOM, icons, favicon, and notify map
 */
export function applyTheme(themeId, persist = true) {
  const theme = THEMES[themeId] ? THEMES[themeId] : THEMES.default;
  currentThemeId = theme.id;

  // 1. Set data-theme attribute on <html>
  if (currentThemeId === 'default') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', currentThemeId);
  }

  // 2. Persist in localStorage
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, currentThemeId);
    } catch (_) {}
  }

  // 3. Update Header Brand Logo Icon
  const brandLogoIcon = document.getElementById('brand-logo-icon');
  if (brandLogoIcon) {
    brandLogoIcon.innerHTML = theme.brandIconHtml;
  }

  // 4. Update Theme Toggle Button Tooltip (Keep the palette icon itself constant)
  const toggleBtn = document.getElementById('btn-theme-toggle');
  if (toggleBtn) {
    toggleBtn.title = `테마 변경 (현재: ${theme.name})`;
  }

  // 5. Update Browser Favicon SVG
  const faviconEl = document.getElementById('app-favicon');
  if (faviconEl && theme.faviconSvg) {
    faviconEl.href = `data:image/svg+xml,${encodeURIComponent(theme.faviconSvg)}`;
  }

  // 6. Update active state of the 3 circles (o o o)
  const popover = document.getElementById('theme-selector-popover');
  if (popover) {
    popover.querySelectorAll('[data-theme-option]').forEach((btn) => {
      const isSelected = btn.getAttribute('data-theme-option') === currentThemeId;
      btn.classList.toggle('is-selected', isSelected);
      btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    });
  }

  // 7. Notify listeners (e.g. map markers & flight path colors)
  for (const fn of themeChangeListeners) {
    try {
      fn(theme);
    } catch (err) {
      console.error('Theme listener error:', err);
    }
  }
}
