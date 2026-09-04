// The service worker: what makes the form open with no network at all.
//
// It answers three kinds of request and deliberately ignores everything else.
//
//   the app itself   network first, cache as the fallback
//   the photographs  cache first; they are large and never change
//   everything else  not touched
//
// Network-first for the app is the deliberate choice. Cache-first would load a
// few hundred milliseconds faster and would reintroduce the exact failure the
// `forms` repo already suffered (see its `apps/_headers`): a fix is deployed,
// the iPad keeps serving last week's code, and nobody can tell by looking. On
// kitchen wifi the app is a few hundred kilobytes. Not worth it.
//
// `POST /api/receive` is never intercepted. It is allowed to fail so that the
// queue in lib/offline.js handles it — that queue is tested, and it is visible
// on screen. Two retry mechanisms racing each other is worse than one.

// Bumped on every deploy. A new version means a new cache and the old one is
// deleted, so a stale cache cannot outlive the code it belongs to. It is also
// shown on screen, so the iPad can be asked what it is running rather than
// guessed at.
const VERSION = '2026-09-04.1';

const SHELL_CACHE = `trace-shell-${VERSION}`;
const PHOTO_CACHE = 'trace-photos';

// `/` and not `/index.html`. Workers' static assets answer `/index.html` with
// a 307 to `/`, and a cached redirect cannot satisfy a navigation — the
// browser refuses it with "Response served by service worker has redirected".
// Caching the canonical URL avoids the whole question.
const SHELL = [
  '/', '/goods-in.js', '/lib/offline.js', '/app.css', '/manifest.webmanifest',
  // The stock screen needs a connection anyway, so caching it buys nothing
  // operationally — but caching the shell means it opens and says so, rather
  // than showing a browser error page with no explanation.
  // '/stock' and not '/stock.html': Workers' static assets answer the .html
  // form with a 307 to the extensionless one, and a cached redirect cannot
  // satisfy a navigation. The same trap as '/index.html'.
  '/stock', '/stock.js', '/batching', '/batching.js', '/batches', '/batches.js',
  '/dispatch', '/dispatch.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      // Take over immediately. Waiting for every tab to close means a deploy
      // reaches an iPad that is never closed only when someone reboots it.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('trace-shell-') && name !== SHELL_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Photographs are immutable: the file at /photos/<item id>.jpg is the picture
// of that item. Re-importing them changes the bytes, which is why the cache is
// cleared on demand from the page rather than versioned here — a photo swap is
// rare and does not warrant re-downloading two megabytes on every deploy.
async function photo(request) {
  const cache = await caches.open(PHOTO_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function shell(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const hit = await caches.match(request, { cacheName: SHELL_CACHE });
    if (hit) return hit;
    // A navigation with nothing cached and no network. Serving the app shell
    // is better than a browser error page: the app itself explains what is
    // missing, and the queue on the device is reachable through it.
    if (request.mode === 'navigate') {
      const index = await caches.match('/', { cacheName: SHELL_CACHE });
      if (index) return index;
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The API is never served from this cache. The catalog already has its own
  // cache in localStorage, with its age shown on screen; a second, silent copy
  // here would make "how old is this list" unanswerable.
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/photos/')) {
    event.respondWith(photo(request));
    return;
  }

  if (request.mode === 'navigate' || SHELL.includes(url.pathname)) {
    event.respondWith(shell(request));
  }
});

// The page asks what it is running, so the version can be shown on screen.
self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source.postMessage({ version: VERSION });
  if (event.data === 'drop-photos') event.waitUntil(caches.delete(PHOTO_CACHE));
});
