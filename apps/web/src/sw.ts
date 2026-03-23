/**
 * @file sw.ts — Calypso PWA service worker (TypeScript source)
 *
 * This file is compiled to `dist/sw.js` by Vite (see vite.config.ts
 * build.rollupOptions.input). The compiled output is registered from
 * `main.tsx` at `/sw.js`.
 *
 * Strategy summary
 * ----------------
 * - App-shell assets (HTML, JS, CSS, icons): cache-first with network fallback.
 * - API calls (/api/*): network-first with no caching.
 * - If both cache and network fail for a navigation request: serve an offline
 *   fallback page embedded in this file.
 *
 * Cache versioning
 * ----------------
 * Increment CACHE_VERSION whenever app-shell assets change in a way that
 * requires old caches to be busted.  The old cache is deleted in the `activate`
 * event so no stale assets are served after the new SW takes control.
 *
 * Platform notes
 * ---------------
 * - iOS Safari (browser tab): the origin's cache is evicted after 7 days of
 *   non-use.  This is expected behaviour; the cache is rebuilt on the next
 *   visit.
 * - iOS Safari (standalone / home-screen PWA): 7-day eviction does NOT apply
 *   and cache persists normally.
 * - Background Sync API is not available on iOS — this SW does not use it.
 *
 * Canonical docs
 * ---------------
 * - Service Worker spec:  https://w3c.github.io/ServiceWorker/
 * - Cache API:            https://developer.mozilla.org/en-US/docs/Web/API/Cache
 * - Fetch event:          https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent
 */

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_VERSION = 'v1';
const CACHE_NAME = `calypso-shell-${CACHE_VERSION}`;

/**
 * App-shell resources to pre-cache on install.
 *
 * The Vite build injects content-hashed filenames for JS/CSS bundles, so we
 * pre-cache the entry-point paths that are stable across builds.
 */
const APP_SHELL: string[] = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-180.png',
];

/**
 * Minimal offline fallback page returned when both cache and network fail
 * for a navigation (document) request.
 */
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Calypso – Offline</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f8fafc; }
    .card { text-align: center; padding: 2rem; max-width: 360px; }
    h1 { color: #1e293b; font-size: 1.5rem; margin-bottom: .5rem; }
    p  { color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>You're offline</h1>
    <p>Check your connection and try again.</p>
  </div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Install — pre-cache the app shell
// ---------------------------------------------------------------------------

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

// ---------------------------------------------------------------------------
// Activate — delete stale caches from previous versions
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// ---------------------------------------------------------------------------
// Fetch — route requests to the appropriate strategy
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin requests
  if (url.origin !== self.location.origin) return;

  // Network-first for API calls — never serve API responses from cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Cache-first for all other same-origin requests (static assets)
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          // Cache successful responses for static assets
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Network failed — serve offline fallback for navigation requests
          if (request.mode === 'navigate') {
            return new Response(OFFLINE_HTML, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            });
          }
          // For non-navigation requests (e.g. sub-resources), propagate the error
          return new Response('Offline', { status: 503 });
        });
    }),
  );
});
