/* 오프라인 캐시.
 *
 * 캐시를 둘로 나눈다. 셸(앱 파일 + 단어 데이터)은 버전을 올릴 때마다 통째로
 * 갈아엎지만, 발음은 사용자가 24MB를 직접 내려받은 것이라 절대 지우지 않는다.
 * 하나로 합쳐두면 앱을 고칠 때마다 발음이 날아가 셀룰러로 다시 받게 된다.
 */

const SHELL = 'toeic-voca-de427319';
const AUDIO = 'toeic-voca-audio';       // 버전을 붙이지 않는다. 지우면 안 되니까.

/* 이게 없으면 앱이 아예 안 뜬다. 하나라도 실패하면 설치를 실패시킨다. */
const CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './words.json',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

/* 없어도 앱은 돌아간다. 지하철에서 한 장 실패했다고 설치 전체를 망치지 않는다. */
const EXTRA = [
  './guide.html',
  './guide/home.png', './guide/home-dark.png',
  './guide/card-front.png', './guide/card-front-dark.png',
  './guide/card-back.png', './guide/card-back-dark.png',
  './guide/list.png', './guide/list-dark.png',
  './guide/quiz.png', './guide/quiz-dark.png',
  './guide/settings.png', './guide/settings-dark.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // reload를 줘야 브라우저 HTTP 캐시에 남은 옛 파일을 집어오지 않는다.
    await c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })));
    await Promise.allSettled(EXTRA.map(u => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== SHELL && k !== AUDIO)   // 발음 캐시는 건드리지 않는다
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    // 캐시에 있으면 그걸로 끝낸다. 뒤에서 몰래 다시 받지 않는다.
    // 셸이 바뀔 때는 어차피 SHELL 버전이 올라가 install이 새로 받는다.
    // 매 요청마다 배경 다운로드를 걸면 실행할 때마다 통신을 깨워 배터리만 먹는다.
    if (hit) return hit;

    const res = await fetch(req);
    if (res.ok) {
      // 응답을 넘기기 전에 '즉시' 복제해야 한다. caches.open()을 먼저 기다리면
      // 그 사이 페이지가 본문을 다 읽어버려 clone()이 'body already used'로 던진다.
      // 이것 때문에 지금까지 발음이 단 한 개도 캐시에 들어가지 않았다.
      const copy = res.clone();
      const target = req.url.includes('/audio/') ? AUDIO : SHELL;
      e.waitUntil(caches.open(target).then(c => c.put(req, copy)));
    }
    return res;
  })());
});
