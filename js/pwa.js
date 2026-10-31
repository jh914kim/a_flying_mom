/**
 * PWA Service Worker Registration & Chrome Install Prompt Controller
 */

let deferredPrompt = null;

export function initPwa() {
  // 1. Register Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((registration) => {
          console.log('[PWA] ServiceWorker registered with scope:', registration.scope);
        })
        .catch((error) => {
          console.warn('[PWA] ServiceWorker registration failed:', error);
        });
    });
  }

  const installBtn = document.getElementById('btn-pwa-install');
  if (!installBtn) return;

  // Check if already running in standalone mode (installed)
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                       window.navigator.standalone === true;

  if (isStandalone) {
    installBtn.style.display = 'none';
    return;
  }

  // 2. Capture Chrome's beforeinstallprompt event
  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent mini-infobar on mobile Chrome
    e.preventDefault();
    deferredPrompt = e;

    // Show the custom install button in UI
    installBtn.style.display = 'inline-flex';
    installBtn.classList.remove('pwa-btn-hidden');
    console.log('[PWA] Chrome beforeinstallprompt ready');
  });

  // 3. User clicks Install Button
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) {
      // If prompt event hasn't fired yet or not supported, alert guide
      alert('크롬 브라우저 우측 상단 주소창의 [컴퓨터/화살표 설치 아이콘] 또는 [메뉴(⋮) > flying mom 설치]를 눌러 바로 설치하실 수 있습니다.');
      return;
    }

    // Show native Chrome install prompt dialog
    deferredPrompt.prompt();

    const choiceResult = await deferredPrompt.userChoice;
    console.log('[PWA] User choice:', choiceResult.outcome);

    if (choiceResult.outcome === 'accepted') {
      console.log('[PWA] User accepted the Chrome install prompt');
      installBtn.style.display = 'none';
    }
    deferredPrompt = null;
  });

  // 4. Listen for successful install
  window.addEventListener('appinstalled', () => {
    console.log('[PWA] Application successfully installed as PWA');
    installBtn.style.display = 'none';
    deferredPrompt = null;
  });
}
