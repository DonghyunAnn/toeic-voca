/* 오프라인 캐시. 셸과 단어 데이터를 설치 시 통째로 받아둔다. */

const CACHE = 'toeic-voca-v38';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './words.json',
  './manifest.json',
  './guide.html',
  './guide/home.png',
  './guide/home-dark.png',
  './guide/card-front.png',
  './guide/card-front-dark.png',
  './guide/card-back.png',
  './guide/card-back-dark.png',
  './guide/list.png',
  './guide/list-dark.png',
  './guide/quiz.png',
  './guide/quiz-dark.png',
  './guide/settings.png',
  './guide/settings-dark.png',
  './guide/sheet.png',
  './guide/sheet-dark.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      // 캐시를 먼저 주고, 뒤에서 조용히 갱신한다.
      const net = fetch(e.request)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
