"use strict";

const CACHE_NAME = "imakoko-v5";
const ASSETS = [
  "./",
  "index.html",
  "privacy.html",
  "style.css",
  "app.js",
  "config.js",
  "stations.js",
  "manifest.json",
  "icon.svg",
  "icon-512.png",
  "apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
  );
  self.clients.claim();
});

// アプリ本体はキャッシュ優先、Overpass APIなど外部リクエストは常にネットワークへ
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
