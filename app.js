"use strict";

// ---- 設定 ----
const SEARCH_RADIUS_M = 4000;        // 駅を検索する半径
const REFETCH_DISTANCE_M = 1500;     // 前回の取得地点からこれ以上離れたら駅データを再取得
const AT_STATION_THRESHOLD_M = 200;  // この距離以内なら「いまここ！」表示
const NEARBY_COUNT = 3;              // 周辺の駅リストに表示する件数
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// ---- 状態 ----
let stations = [];        // { name, kana, lat, lon }
let lastFetchPos = null;  // 駅データを取得した時点の位置
let fetching = false;
let wakeLock = null;

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const startScreen = $("start-screen");
const mainScreen = $("main-screen");
const gpsStatus = $("gps-status");
const statusLabel = $("status-label");
const stationName = $("station-name");
const stationKana = $("station-kana");
const distanceEl = $("distance");
const nearbyList = $("nearby-list");
const updatedAt = $("updated-at");
const errorBanner = $("error-banner");

// ---- 起動 ----
$("start-btn").addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    showError("この端末では位置情報が利用できません。");
    return;
  }
  startScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
  navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  });
});

$("wakelock-btn").addEventListener("click", toggleWakeLock);

// ---- 位置情報 ----
async function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  gpsStatus.textContent = `GPS精度 ±${Math.round(accuracy)}m`;
  gpsStatus.classList.add("ok");
  hideError();

  if (needsRefetch(lat, lon)) {
    await fetchStations(lat, lon);
  }
  render(lat, lon);
}

function onGeoError(err) {
  const messages = {
    1: "位置情報の利用が許可されていません。ブラウザの設定から許可してください。",
    2: "位置情報を取得できません。地下やトンネル内ではGPSが届かないことがあります。",
    3: "位置情報の取得がタイムアウトしました。",
  };
  showError(messages[err.code] || "位置情報の取得に失敗しました。");
}

function needsRefetch(lat, lon) {
  if (fetching) return false;
  if (!lastFetchPos) return true;
  return haversine(lat, lon, lastFetchPos.lat, lastFetchPos.lon) > REFETCH_DISTANCE_M;
}

// ---- 駅データ取得 (Overpass API / OpenStreetMap) ----
async function fetchStations(lat, lon) {
  fetching = true;
  gpsStatus.textContent = "駅データ取得中…";
  const query = `
    [out:json][timeout:15];
    (
      node(around:${SEARCH_RADIUS_M},${lat},${lon})["railway"="station"];
      node(around:${SEARCH_RADIUS_M},${lat},${lon})["railway"="halt"];
    );
    out body;
  `;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      stations = (data.elements || [])
        .filter((e) => e.tags && e.tags.name)
        .map((e) => ({
          name: e.tags.name,
          kana: e.tags["name:ja-Hira"] || e.tags["name:ja_kana"] || "",
          lat: e.lat,
          lon: e.lon,
        }));
      lastFetchPos = { lat, lon };
      fetching = false;
      return;
    } catch (e) {
      console.warn(`Overpass取得失敗 (${endpoint}):`, e);
    }
  }

  fetching = false;
  showError("駅データの取得に失敗しました。通信状態を確認してください。");
}

// ---- 表示 ----
function render(lat, lon) {
  if (stations.length === 0) {
    stationName.textContent = "---";
    statusLabel.textContent = "周辺に駅が見つかりません";
    return;
  }

  const sorted = stations
    .map((s) => ({ ...s, dist: haversine(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.dist - b.dist);

  const nearest = sorted[0];
  const atStation = nearest.dist <= AT_STATION_THRESHOLD_M;

  statusLabel.textContent = atStation ? "🚉 いまここ！" : "最寄り駅";
  statusLabel.classList.toggle("at-station", atStation);
  stationName.textContent = nearest.name;
  stationKana.textContent = nearest.kana;
  distanceEl.textContent = atStation ? "" : `約 ${formatDistance(nearest.dist)}`;

  nearbyList.innerHTML = "";
  for (const s of sorted.slice(1, 1 + NEARBY_COUNT)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = s.name;
    const dist = document.createElement("span");
    dist.className = "dist";
    dist.textContent = formatDistance(s.dist);
    li.append(name, dist);
    nearbyList.appendChild(li);
  }

  updatedAt.textContent = `更新: ${new Date().toLocaleTimeString("ja-JP")}`;
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

// ---- 距離計算 (ハバーサイン公式) ----
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- 画面常時点灯 (Wake Lock) ----
async function toggleWakeLock() {
  const btn = $("wakelock-btn");
  if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
    btn.classList.remove("active");
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    btn.classList.add("active");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      btn.classList.remove("active");
    });
  } catch {
    showError("この端末では画面の常時点灯に対応していません。");
  }
}

// ---- エラー表示 ----
let errorTimer = null;
function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.remove("hidden");
  clearTimeout(errorTimer);
  errorTimer = setTimeout(hideError, 8000);
}

function hideError() {
  errorBanner.classList.add("hidden");
}

// ---- PWA: Service Worker登録 ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
