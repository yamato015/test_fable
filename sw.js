"use strict";

const CACHE_NAME = "ekikoko-v24";
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

// アプリ本体はキャッシュ優先、Overpass APIなど外部リクエストは常にネットワークへ。
// 遅延ロードする stations_jp.js などは初回取得時に実行時キャッシュする
// (プリキャッシュに入れないことで初回ロードを軽く保つ)。
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && event.request.method === "GET") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
