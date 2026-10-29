const SHELL_CACHE = "vinyl-archive-shell-v40";
// Not versioned: cover photos stay valid across app updates.
const COVER_CACHE = "vinyl-archive-covers";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./cloud-config.js",
  "./cloud-sync.js",
  "./app.js",
  "./manifest.webmanifest",
];
const VENDOR_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
const COVER_PATH = "/storage/v1/object/sign/record-covers/";

self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(ASSETS.map((path) => new Request(path, { cache: "reload" })))),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== COVER_CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
  ),
);

// Same-origin app files: network first so updates show up, cache as offline fallback.
// "no-cache" revalidates with the server instead of trusting the HTTP cache, so
// file names need no ?v= version. Keyed without the query string.
async function networkFirst(request, url) {
  const key = url.origin + url.pathname;
  try {
    const response = await fetch(request, { cache: "no-cache" });
    if (response.ok) (await caches.open(SHELL_CACHE)).put(key, response.clone());
    return response;
  } catch (error) {
    const cached =
      (await caches.match(key)) ||
      (request.mode === "navigate" && (await caches.match("./index.html")));
    if (cached) return cached;
    throw error;
  }
}

// Pinned library and font URLs never change, so serve them from cache when possible.
// Fetched in CORS mode so the cached response is not opaque.
async function cacheFirst(url) {
  const cached = await caches.match(url.href);
  if (cached) return cached;
  const response = await fetch(url.href, { mode: "cors", credentials: "omit" });
  if (response.ok) (await caches.open(SHELL_CACHE)).put(url.href, response.clone());
  return response;
}

// Signed cover URLs carry a token that changes on every refresh; key by the
// storage path so each photo is stored once and still loads offline.
async function cachedCover(url) {
  const key = url.origin + url.pathname;
  const cache = await caches.open(COVER_CACHE);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await fetch(url.href, { mode: "cors", credentials: "omit" });
  if (response.ok) cache.put(key, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) event.respondWith(networkFirst(request, url));
  else if (url.pathname.startsWith(COVER_PATH)) event.respondWith(cachedCover(url));
  else if (VENDOR_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(url));
  // Everything else (Supabase API, auth, Realtime, external links) is never cached.
});
