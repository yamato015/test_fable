"use strict";

// ---- 設定 ----
const SEARCH_RADIUS_M = 4000;        // 駅を検索する半径
const REFETCH_DISTANCE_M = 1500;     // 前回の取得地点からこれ以上離れたら駅データを再取得
const AT_STATION_THRESHOLD_M = 200;  // この距離以内なら「いまここ！」表示
const NEARBY_COUNT = 5;              // 周辺の駅リストに表示する件数
const ALERT_DISTANCE_M = 600;        // 降車アラートを発火させる距離
const NEXT_MIN_MOVE_M = 25;          // 進行方向を判定するのに必要な移動距離
const NEXT_MAX_ANGLE_DEG = 50;       // 進行方向と駅方向のずれの許容角度
const HISTORY_MAX = 50;              // 乗車履歴の最大保存件数
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// ---- 状態 ----
let stations = [];        // { id, name, kana, lat, lon, lines: [] }
let lineNames = [];       // 周辺で見つかった路線名の一覧
let selectedLine = "";    // 絞り込み中の路線名 ("" = すべて)
let lastFetchPos = null;  // 駅データを取得した時点の位置
let fetching = false;
let wakeLock = null;
let prevPos = null;       // 進行方向判定用の前回位置
let heading = null;       // 進行方向 (度)
let alertStation = null;  // 降車アラート対象 { name, lat, lon }
let lastHistoryName = null;

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const startScreen = $("start-screen");
const mainScreen = $("main-screen");
const gpsStatus = $("gps-status");
const statusLabel = $("status-label");
const stationName = $("station-name");
const stationKana = $("station-kana");
const distanceEl = $("distance");
const nextStationEl = $("next-station");
const nearbyList = $("nearby-list");
const updatedAt = $("updated-at");
const errorBanner = $("error-banner");

// =====================================================================
// プラン管理 (フリーミアム)
// =====================================================================
// config.jsのbackendUrlが設定されていればStripe課金 (server/ 参照)、
// 未設定ならデモモード (localStorageで即時切り替え) で動作する。
// 課金モードでは、バックエンドが発行するHMAC署名付きライセンストークンを
// 保持し、期限が切れる前にStripeのサブスク状態を再検証して更新する。
const CONFIG = window.APP_CONFIG || {};
const BACKEND_URL = (CONFIG.backendUrl || "").replace(/\/+$/, "");
const LICENSE_RECHECK_MS = 24 * 3600 * 1000; // サブスク状態の再確認間隔

function billingEnabled() {
  return BACKEND_URL !== "";
}

function getLicense() {
  try {
    return JSON.parse(localStorage.getItem("license"));
  } catch {
    return null;
  }
}

function saveLicense(lic) {
  localStorage.setItem("license", JSON.stringify(lic));
  localStorage.setItem("licenseCheckedAt", String(Date.now()));
}

function isPremium() {
  if (!billingEnabled()) return localStorage.getItem("plan") === "premium";
  const lic = getLicense();
  return !!lic && lic.exp * 1000 > Date.now();
}

function setPlan(plan) {
  localStorage.setItem("plan", plan);
  applyPlanUI();
}

async function api(path, body) {
  const res = await fetch(BACKEND_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// 起動時: 決済完了リダイレクト (?session_id=) の処理とライセンスの再検証
async function initBilling() {
  if (billingEnabled()) {
    const sessionId = new URLSearchParams(location.search).get("session_id");
    if (sessionId) {
      history.replaceState(null, "", location.pathname);
      try {
        saveLicense(await api("/api/activate", { session_id: sessionId }));
        showToast("プレミアムが有効になりました 🎉", false);
      } catch {
        showToast("購入の確認に失敗しました。時間をおいて再度開いてください。");
      }
    } else {
      await maybeRefreshLicense();
    }
  }
  applyPlanUI();
}

async function maybeRefreshLicense() {
  const lic = getLicense();
  if (!lic) return;
  const checkedAt = Number(localStorage.getItem("licenseCheckedAt") || 0);
  if (Date.now() - checkedAt < LICENSE_RECHECK_MS) return;
  try {
    saveLicense(await api("/api/refresh", { token: lic.token }));
  } catch (e) {
    // 401/402 = 解約済みや不正トークン。それ以外 (通信障害等) は現状維持
    if (e.status === 401 || e.status === 402) {
      localStorage.removeItem("license");
    }
    localStorage.setItem("licenseCheckedAt", String(Date.now()));
  }
}

async function startCheckout(plan) {
  try {
    const r = await api("/api/checkout", { plan });
    location.href = r.url;
  } catch {
    showToast("決済ページを開けませんでした。通信状態を確認してください。");
  }
}

async function openPortal() {
  const lic = getLicense();
  if (!lic) return;
  try {
    const r = await api("/api/portal", { token: lic.token });
    location.href = r.url;
  } catch {
    showToast("管理ページを開けませんでした。通信状態を確認してください。");
  }
}

function applyPlanUI() {
  const premium = isPremium();
  const billing = billingEnabled();
  $("premium-btn").textContent = premium ? "⭐ プレミアム会員" : "⭐ プレミアム";
  $("ad-slot").classList.toggle("hidden", premium);
  $("buy-monthly-btn").classList.toggle("hidden", !billing || premium);
  $("buy-yearly-btn").classList.toggle("hidden", !billing || premium);
  $("purchase-btn").classList.toggle("hidden", billing || premium);
  $("manage-btn").classList.toggle("hidden", !billing || !premium);
  $("restore-btn").classList.toggle("hidden", billing || !premium);
  $("history-section").classList.toggle("hidden", !premium);
  $("line-filter-wrap").classList.toggle(
    "hidden",
    !premium || lineNames.length === 0
  );
  if (!premium) {
    nextStationEl.classList.add("hidden");
    selectedLine = "";
    cancelAlert();
    initAds();
  }
  if (premium) renderHistory();
}

// 「プレミアム機能を使おうとしたら案内を出す」ゲート
function requirePremium() {
  if (isPremium()) return true;
  $("paywall").classList.remove("hidden");
  return false;
}

$("premium-btn").addEventListener("click", () =>
  $("paywall").classList.remove("hidden")
);
$("paywall-close").addEventListener("click", () =>
  $("paywall").classList.add("hidden")
);
$("buy-monthly-btn").addEventListener("click", () => startCheckout("monthly"));
$("buy-yearly-btn").addEventListener("click", () => startCheckout("yearly"));
$("manage-btn").addEventListener("click", openPortal);
$("purchase-btn").addEventListener("click", () => {
  setPlan("premium");
  $("paywall").classList.add("hidden");
});
$("restore-btn").addEventListener("click", () => {
  setPlan("free");
  $("paywall").classList.add("hidden");
});

// =====================================================================
// 広告 (無料プランのみ / Google AdSense)
// =====================================================================
// config.jsのadsenseClientが未設定の間はプレースホルダのまま表示する
let adsInjected = false;

function initAds() {
  if (isPremium() || !CONFIG.adsenseClient || adsInjected) return;
  adsInjected = true;

  const script = document.createElement("script");
  script.async = true;
  script.crossOrigin = "anonymous";
  script.src =
    "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" +
    encodeURIComponent(CONFIG.adsenseClient);
  document.head.appendChild(script);

  const slot = $("ad-slot");
  slot.textContent = "";
  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.display = "block";
  ins.dataset.adClient = CONFIG.adsenseClient;
  if (CONFIG.adsenseSlot) ins.dataset.adSlot = CONFIG.adsenseSlot;
  ins.dataset.adFormat = "auto";
  ins.dataset.fullWidthResponsive = "true";
  slot.appendChild(ins);
  (window.adsbygoogle = window.adsbygoogle || []).push({});
}

// =====================================================================
// 起動
// =====================================================================
$("start-btn").addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    showError("この端末では位置情報が利用できません。");
    return;
  }
  startScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
  applyPlanUI();
  navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  });
});

$("wakelock-btn").addEventListener("click", toggleWakeLock);
$("alert-cancel-btn").addEventListener("click", cancelAlert);
$("alert-dismiss-btn").addEventListener("click", () => {
  $("alert-overlay").classList.add("hidden");
  navigator.vibrate?.(0);
});
$("line-filter").addEventListener("change", (e) => {
  selectedLine = e.target.value;
  if (prevPos) render(prevPos.lat, prevPos.lon);
});

// =====================================================================
// 位置情報
// =====================================================================
async function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  gpsStatus.textContent = `GPS精度 ±${Math.round(accuracy)}m`;
  gpsStatus.classList.add("ok");
  hideError();

  updateHeading(lat, lon, pos.coords.heading);

  if (needsRefetch(lat, lon)) {
    await fetchStations(lat, lon);
  }
  render(lat, lon);
  checkAlert(lat, lon);
}

// 進行方向を更新する。GPSのheadingが取れない端末では位置の差分から算出
function updateHeading(lat, lon, gpsHeading) {
  if (typeof gpsHeading === "number" && !Number.isNaN(gpsHeading)) {
    heading = gpsHeading;
  } else if (prevPos) {
    const moved = haversine(prevPos.lat, prevPos.lon, lat, lon);
    if (moved >= NEXT_MIN_MOVE_M) {
      heading = bearing(prevPos.lat, prevPos.lon, lat, lon);
    }
  }
  if (!prevPos || haversine(prevPos.lat, prevPos.lon, lat, lon) >= NEXT_MIN_MOVE_M) {
    prevPos = { lat, lon };
  }
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

// =====================================================================
// 駅・路線データ取得 (Overpass API / OpenStreetMap)
// =====================================================================
async function fetchStations(lat, lon) {
  fetching = true;
  gpsStatus.textContent = "駅データ取得中…";
  // 駅ノードに加えて、その駅を含む路線リレーションも取得し、
  // 駅→路線名のひも付けを作る (データが無い地域では路線絞り込みを非表示にする)
  const query = `
    [out:json][timeout:15];
    (
      node(around:${SEARCH_RADIUS_M},${lat},${lon})["railway"="station"];
      node(around:${SEARCH_RADIUS_M},${lat},${lon})["railway"="halt"];
    )->.sts;
    .sts out body;
    rel(bn.sts)["route"~"^(train|subway|monorail|tram|light_rail)$"];
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
      parseOverpass(data.elements || []);
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

function parseOverpass(elements) {
  const nodes = elements.filter((e) => e.type === "node" && e.tags?.name);
  const rels = elements.filter((e) => e.type === "relation" && e.tags?.name);

  // 駅ノードID → 路線名の集合
  const linesByNode = new Map();
  for (const rel of rels) {
    for (const m of rel.members || []) {
      if (m.type !== "node") continue;
      if (!linesByNode.has(m.ref)) linesByNode.set(m.ref, new Set());
      linesByNode.get(m.ref).add(rel.tags.name);
    }
  }

  stations = nodes.map((e) => ({
    id: e.id,
    name: e.tags.name,
    kana: e.tags["name:ja-Hira"] || e.tags["name:ja_kana"] || "",
    lat: e.lat,
    lon: e.lon,
    lines: [...(linesByNode.get(e.id) || [])],
  }));

  lineNames = [...new Set(stations.flatMap((s) => s.lines))].sort();
  renderLineFilter();
}

function renderLineFilter() {
  const wrap = $("line-filter-wrap");
  const select = $("line-filter");
  if (lineNames.length === 0 || !isPremium()) {
    wrap.classList.add("hidden");
    return;
  }
  const current = selectedLine;
  select.innerHTML = '<option value="">すべての路線</option>';
  for (const name of lineNames) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = lineNames.includes(current) ? current : "";
  selectedLine = select.value;
  wrap.classList.remove("hidden");
}

// =====================================================================
// 表示
// =====================================================================
function visibleStations() {
  if (!selectedLine) return stations;
  const filtered = stations.filter((s) => s.lines.includes(selectedLine));
  return filtered.length > 0 ? filtered : stations;
}

function render(lat, lon) {
  const list = visibleStations();
  if (list.length === 0) {
    stationName.textContent = "---";
    statusLabel.textContent = "周辺に駅が見つかりません";
    return;
  }

  const sorted = list
    .map((s) => ({ ...s, dist: haversine(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.dist - b.dist);

  const nearest = sorted[0];
  const atStation = nearest.dist <= AT_STATION_THRESHOLD_M;

  if (stationName.textContent !== nearest.name) {
    flashPop(stationName);
    flashPop($("r-station"));
  }

  statusLabel.textContent = atStation ? "🚉 いまここ！" : "最寄り駅";
  statusLabel.classList.toggle("at-station", atStation);
  stationName.textContent = nearest.name;
  stationKana.textContent = nearest.kana;
  distanceEl.textContent = atStation ? "" : `約 ${formatDistance(nearest.dist)}`;

  // 車内モード側にも同じ内容を反映
  $("r-status").textContent = statusLabel.textContent;
  $("r-status").classList.toggle("at-station", atStation);
  $("r-station").textContent = nearest.name;
  $("r-dist").textContent = atStation ? "" : `約 ${formatDistance(nearest.dist)}`;

  if (atStation) recordHistory(nearest.name);
  renderNextStation(lat, lon, sorted, nearest);

  nearbyList.innerHTML = "";
  for (const s of sorted.slice(1, 1 + NEARBY_COUNT)) {
    nearbyList.appendChild(nearbyItem(s));
  }

  updatedAt.textContent = `更新: ${new Date().toLocaleTimeString("ja-JP")}`;
}

function nearbyItem(s) {
  const li = document.createElement("li");
  const name = document.createElement("span");
  name.textContent = s.name;
  const right = document.createElement("span");
  right.className = "item-right";
  const dist = document.createElement("span");
  dist.className = "dist";
  dist.textContent = formatDistance(s.dist);
  const bell = document.createElement("button");
  bell.className = "bell-btn";
  bell.textContent = alertStation?.name === s.name ? "🔔" : "🔕";
  bell.title = "この駅で降車アラートを設定";
  bell.addEventListener("click", () => setAlert(s));
  right.append(dist, bell);
  li.append(name, right);
  return li;
}

// 次の駅予測 (プレミアム): 進行方向と駅方向の角度差が小さい最寄りの駅を表示
function renderNextStation(lat, lon, sorted, nearest) {
  if (!isPremium() || heading === null) {
    nextStationEl.classList.add("hidden");
    $("r-next").textContent = "";
    return;
  }
  const candidate = sorted.find((s) => {
    if (s.name === nearest.name) return false;
    if (s.dist < 250 || s.dist > 5000) return false;
    const diff = angleDiff(heading, bearing(lat, lon, s.lat, s.lon));
    return diff <= NEXT_MAX_ANGLE_DEG;
  });
  if (candidate) {
    nextStationEl.textContent = `次は ${candidate.name}（${formatDistance(candidate.dist)}）`;
    nextStationEl.classList.remove("hidden");
    $("r-next").textContent = `次は ${candidate.name}`;
  } else {
    nextStationEl.classList.add("hidden");
    $("r-next").textContent = "";
  }
}

function flashPop(el) {
  el.classList.remove("pulse");
  void el.offsetWidth; // 再アニメーションのためリフローを挟む
  el.classList.add("pulse");
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

// =====================================================================
// 降車アラート (プレミアム)
// =====================================================================
async function setAlert(station) {
  if (!requirePremium()) return;
  alertStation = { name: station.name, lat: station.lat, lon: station.lon };
  $("alert-status-text").textContent = `🔔 ${station.name} で降車アラート設定中`;
  $("alert-status").classList.remove("hidden");
  $("r-alert").textContent = `🔔 ${station.name} で降車アラート設定中`;
  if ("Notification" in window && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      /* 通知が使えなくても振動と画面表示で知らせる */
    }
  }
  if (prevPos) render(prevPos.lat, prevPos.lon);
}

function cancelAlert() {
  alertStation = null;
  $("alert-status").classList.add("hidden");
  $("r-alert").textContent = "";
}

function checkAlert(lat, lon) {
  if (!alertStation) return;
  const dist = haversine(lat, lon, alertStation.lat, alertStation.lon);
  if (dist > ALERT_DISTANCE_M) return;

  const name = alertStation.name;
  cancelAlert();
  $("alert-overlay-station").textContent = name;
  $("alert-overlay").classList.remove("hidden");
  navigator.vibrate?.([400, 200, 400, 200, 800]);
  beep();
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("🔔 まもなく到着", { body: `${name} に近づいています`, icon: "icon.svg" });
  }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 1.2);
  } catch {
    /* サイレント環境では振動と画面表示のみ */
  }
}

// =====================================================================
// 乗車履歴 (プレミアム)
// =====================================================================
function recordHistory(name) {
  if (!isPremium() || name === lastHistoryName) return;
  lastHistoryName = name;
  const history = loadHistory();
  history.unshift({ name, ts: Date.now() });
  localStorage.setItem("history", JSON.stringify(history.slice(0, HISTORY_MAX)));
  renderHistory();
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem("history")) || [];
  } catch {
    return [];
  }
}

function renderHistory() {
  const listEl = $("history-list");
  listEl.innerHTML = "";
  for (const h of loadHistory().slice(0, 5)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = h.name;
    const time = document.createElement("span");
    time.className = "dist";
    time.textContent = new Date(h.ts).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    });
    li.append(name, time);
    listEl.appendChild(li);
  }
}

// =====================================================================
// 地理計算
// =====================================================================
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

// 2点間の方位角 (北=0度、時計回り)
function bearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// =====================================================================
// 車内モード (起動したまま膝上・手元でチラ見する特大全画面表示)
// =====================================================================
let ridingClockTimer = null;
let ridingAcquiredWakeLock = false;

$("riding-btn").addEventListener("click", enterRidingMode);
$("riding-screen").addEventListener("click", exitRidingMode);

async function enterRidingMode() {
  $("riding-screen").classList.remove("hidden");
  updateRidingClock();
  ridingClockTimer = setInterval(updateRidingClock, 1000);
  // 車内モード中は画面を消灯させない (非対応端末では表示のみ)
  ridingAcquiredWakeLock = !wakeLock && (await acquireWakeLock());
}

function exitRidingMode() {
  $("riding-screen").classList.add("hidden");
  clearInterval(ridingClockTimer);
  if (ridingAcquiredWakeLock) releaseWakeLock();
  ridingAcquiredWakeLock = false;
}

function updateRidingClock() {
  $("r-clock").textContent = new Date().toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// =====================================================================
// 画面常時点灯 (Wake Lock)
// =====================================================================
async function acquireWakeLock() {
  if (wakeLock) return true;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    $("wakelock-btn").classList.add("active");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      $("wakelock-btn").classList.remove("active");
    });
    return true;
  } catch {
    return false;
  }
}

async function releaseWakeLock() {
  if (wakeLock) await wakeLock.release();
}

async function toggleWakeLock() {
  if (wakeLock) {
    await releaseWakeLock();
  } else if (!(await acquireWakeLock())) {
    showError("この端末では画面の常時点灯に対応していません。");
  }
}

// =====================================================================
// エラー表示
// =====================================================================
let errorTimer = null;
function showToast(msg, isError = true) {
  errorBanner.textContent = msg;
  errorBanner.classList.toggle("success", !isError);
  errorBanner.classList.remove("hidden");
  clearTimeout(errorTimer);
  errorTimer = setTimeout(hideError, 8000);
}

function showError(msg) {
  showToast(msg, true);
}

function hideError() {
  errorBanner.classList.add("hidden");
}

// ---- PWA: Service Worker登録 ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---- 起動時に課金状態を初期化 (決済リダイレクト処理・ライセンス再検証) ----
initBilling();
