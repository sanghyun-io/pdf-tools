// The web build's service worker (written out by vite.config.js with the version and the app's files filled in).
// Every file of the app is kept on this PC when the page is first opened, so the page, installed as an app or
// not, opens and works without the network from then on. A new version is fetched in the background and takes
// over when the app is next opened (no skipWaiting: an open page keeps the files it started with).
const CACHE = 'pdf-tools-__VERSION__'
const FILES = __FILES__

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))))

self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
))

self.addEventListener('fetch', (e) => {
  const { request } = e
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return
  e.respondWith((async () => {
    // one copy of each file: ?v=... only ever skips a web cache, and a server's Vary (Origin, sent with the
    // crossorigin script and stylesheet but not when they were kept) must not hide it
    const kept = await caches.match(request, { ignoreSearch: true, ignoreVary: true })
    if (kept) return kept
    if (request.mode === 'navigate') return (await caches.match('./', { ignoreVary: true })) ?? fetch(request)
    return fetch(request)
  })())
})
