// 서비스 워커: 앱 파일을 기기에 담아 두고, 인터넷이 안 될 때 그걸로 앱을 연다.
// 방식: 인터넷이 되면 항상 최신 파일을 받아오고(받은 김에 기기에도 담아 둠),
//       안 되거나 3초 넘게 걸리면 기기에 담아 둔 파일을 쓴다.
// 원고는 여기가 아니라 IndexedDB에 따로 저장되므로 이 파일과 무관하게 안전하다.

const CACHE = 'jipil-v26';
const FONT_CACHE = 'jipil-fonts-v1'; // 글꼴 전용(앱을 고쳐 올려도 지우지 않는다)
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/db.js',
  'js/count.js',
  'js/settings.js',
  'js/dialogs.js',
  'js/symbols.js',
  'js/config.js',
  'js/drive.js',
  'js/sync.js',
  'js/history.js',
  'js/pdf.js',
  'js/wiki.js',
  'js/ai.js',
  'js/proof.js',
  'js/status.js',
  'js/review.js',
  'js/context.js',
  'js/ask.js',
  'js/check.js',
  'js/hooks.js',
  'js/draft.js',
  'js/lore.js',
  'js/aimarks.js',
  'js/nav.js',
  'js/notes.js',
  'js/meeting.js',
  'js/idea.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
const TIMEOUT = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // 다른 사이트(구글·AI) 요청은 건드리지 않는다

  // 글꼴은 크고 바뀌지 않으니, 한 번 받으면 계속 기기에 담아 둔 걸 쓴다.
  if (new URL(req.url).pathname.includes('/fonts/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FONT_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const fromNetwork = fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      fromNetwork.catch(() => {}); // 실패는 아래에서 처리
      const timeout = new Promise((resolve) => setTimeout(resolve, TIMEOUT, null));

      try {
        const res = await Promise.race([fromNetwork, timeout]);
        if (res) return res;
      } catch {
        // 오프라인 → 아래로
      }
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      return fromNetwork; // 담아 둔 것도 없으면 끝까지 기다려 본다
    })(),
  );
});
