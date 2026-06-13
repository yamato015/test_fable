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
const EMBEDDED_COVERAGE_M = 8000;    // 埋め込みデータの最寄り駅がこれより遠い場合はOverpassへ切替
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// ---- 埋め込み駅データ (stations.js / 首都圏+関西 約3,100駅・公式座標) ----
// 通信不要・路線名が確実なためこちらを優先し、圏外ではOverpassにフォールバック
const EMBEDDED_STATIONS = (window.STATIONS || []).map((s) => ({
  name: s.name,
  kana: s.nameKana || "",
  romaji: s.r || "",
  lat: s.lat,
  lon: s.lng,
  lines: s.lines || [],
}));

// 駅名の表示用ヘルパー。データ上の駅名は同名駅の区別のため
// 「中津(OsakaMetro)」のような接尾辞が付くことがあるので表示時に外す。
// 英語モードではローマ字があればローマ字を表示する
function dispName(s) {
  const base = (s.name || "").replace(/\(.+?\)$/, "");
  return lang === "en" && s.romaji ? s.romaji : base;
}

function dispSub(s) {
  return lang === "en" ? (s.name || "").replace(/\(.+?\)$/, "") : s.kana || "";
}

// 路線の公式カラー (stations.jsのLINE_META由来)
function lineColor(name) {
  return (window.LINE_META || {})[name]?.c || "#58a6ff";
}

// ---- 状態 ----
let stations = [];        // { name, kana, lat, lon, lines: [] }
let usingEmbedded = false;
let lineNames = [];       // 周辺で見つかった路線名の一覧
let selectedLine = "";    // 絞り込み中の路線名 ("" = すべて)
let lastFetchPos = null;  // 駅データを取得した時点の位置
let fetching = false;
let wakeLock = null;
let curPos = null;        // 最新の現在位置
let prevPos = null;       // 進行方向判定用の前回位置
let heading = null;       // 進行方向 (度)
let headingBuf = [];      // 方位の平滑化バッファ (直近3回が一致したときだけ更新)
let departureAnchor = null; // 直近に停車した駅 (出発後の実移動ベクトル算出用)
let rideLines = null;     // 乗車中と推定した路線名のSet (null = 未推定)
let lastRideStation = null; // 乗車路線推定に使う直近の停車駅
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
// 多言語対応 (日本語 / English)
// =====================================================================
// 静的な文言はHTMLのdata-i18n属性、動的な文言はt()で参照する。
// 駅名は元データが日本語のため両言語で日本語表示 (ローマ字対応は今後の課題)
const STRINGS = {
  ja: {
    appName: "エキココ",
    tagline: "混雑した電車内でも、<br>いまどの駅にいるかすぐわかる。",
    startBtn: "現在地を確認する",
    startNote: "位置情報の利用を許可してください。<br>位置情報は端末内でのみ使用され、保存されません。",
    privacyLink: "プライバシーポリシー",
    gpsWait: "GPS取得中…",
    gpsAcc: (n) => `GPS精度 ±${n}m`,
    fetching: "駅データ取得中…",
    fetchFail: "駅データの取得に失敗しました。通信状態を確認してください。",
    geo1: "位置情報の利用が許可されていません。ブラウザの設定から許可してください。",
    geo2: "位置情報を取得できません。地下やトンネル内ではGPSが届かないことがあります。",
    geo3: "位置情報の取得がタイムアウトしました。",
    geoFail: "位置情報の取得に失敗しました。",
    geoUnsupported: "この端末では位置情報が利用できません。",
    nearest: "最寄り駅",
    here: "🚉 いまここ！",
    noStations: "周辺に駅が見つかりません",
    about: (d) => `約 ${d}`,
    nextIs: (n, d) => `次は ${n}（${d}）`,
    nextIsShort: (n) => `次は ${n}`,
    ridingBtn: "🚆 車内モード（特大表示・画面オフ防止）",
    destBtn: "🎯 目的地を設定（降車アラート）",
    destSet: (n) => `🎯 目的地: ${n}（タップで変更）`,
    alertSet: (n) => `🔔 ${n} で降車アラート設定中`,
    stopsLeft: (n) => `あと${n}駅`,
    cancel: "解除",
    soonTitle: "🔔 まもなく",
    notifTitle: "🔔 まもなく到着",
    notifBody: (n) => `${n} に近づいています`,
    alertDismiss: "OK・アラートを停止",
    nearbyTitle: "周辺の駅",
    nearbyHint: "🔔で降車アラートを設定",
    historyTitle: "乗車履歴",
    adPlaceholder: "広告スペース",
    updated: (t) => `更新: ${t}`,
    privacyFooter: "プライバシー",
    feedback: "フィードバック",
    wipe: "データ削除",
    wipeConfirm: "端末に保存された履歴・目的地・テーマ設定・プレミアム情報をすべて削除します。よろしいですか？",
    credit: "駅データ: © OpenStreetMap contributors",
    lineFilterLabel: "路線で絞り込み",
    allLines: "すべての路線",
    rideChip: (l) => `🚆 ${l} に乗車中？`,
    tapBack: "タップで戻る",
    destTitle: "目的地を選択",
    close: "閉じる",
    searchTab: "🔍 検索",
    linesTab: "🚇 路線図",
    backToLines: "← 路線一覧に戻る",
    clearDest: "目的地をクリア",
    searchPh: "駅名・ひらがなで検索...",
    lineSearchPh: "路線名・駅名で検索...",
    stationsCount: (n) => `${n}駅`,
    pwTitle: "⭐ プレミアムプラン",
    pw1: "🔔 <b>降車アラート</b> — 降りる駅に近づくと振動・通知でお知らせ。寝過ごし防止に",
    pw2: "🧭 <b>次の駅予測</b> — 進行方向から次に到着する駅を表示",
    pw3: "🚃 <b>路線絞り込み</b> — 乗っている路線の駅だけを表示",
    pw4: "📋 <b>乗車履歴</b> — 通過・停車した駅の記録を自動保存",
    pw5: "🚫 <b>広告非表示</b>",
    price: '月額 240円 <span class="price-sub">/ 年額 1,800円（38%おトク）</span>',
    buyMonthly: "月額プランに登録する",
    buyYearly: "年額プランに登録する",
    buyDemo: "アップグレードする（デモ）",
    manageSub: "サブスクリプションを管理・解約する",
    cancelDemo: "プレミアムを解約する（デモ）",
    premiumBtn: "⭐ プレミアム",
    premiumMember: "⭐ プレミアム会員",
    toastPremiumOn: "プレミアムが有効になりました 🎉",
    toastActivateFail: "購入の確認に失敗しました。時間をおいて再度開いてください。",
    toastCheckoutFail: "決済ページを開けませんでした。通信状態を確認してください。",
    toastPortalFail: "管理ページを開けませんでした。通信状態を確認してください。",
    wakeLockFail: "この端末では画面の常時点灯に対応していません。",
  },
  en: {
    appName: "EkiKoko",
    tagline: "Know exactly which station you're at,<br>even on a packed train.",
    startBtn: "Show my location",
    startNote: "Please allow location access.<br>Your location is processed only on this device and never stored.",
    privacyLink: "Privacy Policy",
    gpsWait: "Getting GPS…",
    gpsAcc: (n) => `GPS ±${n}m`,
    fetching: "Loading stations…",
    fetchFail: "Failed to load station data. Please check your connection.",
    geo1: "Location access is denied. Please allow it in your browser settings.",
    geo2: "Couldn't get your location. GPS may not work underground or in tunnels.",
    geo3: "Location request timed out.",
    geoFail: "Failed to get your location.",
    geoUnsupported: "Location is not available on this device.",
    nearest: "Nearest station",
    here: "🚉 You are here!",
    noStations: "No stations found nearby",
    about: (d) => `approx. ${d}`,
    nextIs: (n, d) => `Next: ${n} (${d})`,
    nextIsShort: (n) => `Next: ${n}`,
    ridingBtn: "🚆 Onboard mode (large display, keeps screen on)",
    destBtn: "🎯 Set destination (get-off alert)",
    destSet: (n) => `🎯 Destination: ${n} (tap to change)`,
    alertSet: (n) => `🔔 Get-off alert set for ${n}`,
    stopsLeft: (n) => `${n} ${n === 1 ? "stop" : "stops"} to go`,
    cancel: "Clear",
    soonTitle: "🔔 Arriving soon",
    notifTitle: "🔔 Arriving soon",
    notifBody: (n) => `Approaching ${n}`,
    alertDismiss: "OK, stop the alert",
    nearbyTitle: "Nearby stations",
    nearbyHint: "Tap 🔔 to set a get-off alert",
    historyTitle: "Ride history",
    adPlaceholder: "Ad space",
    updated: (t) => `Updated: ${t}`,
    privacyFooter: "Privacy",
    feedback: "Feedback",
    wipe: "Delete my data",
    wipeConfirm: "This will delete all data saved on this device (history, destination, theme, premium info). Continue?",
    credit: "Station data © OpenStreetMap contributors",
    lineFilterLabel: "Filter by line",
    allLines: "All lines",
    rideChip: (l) => `🚆 Riding ${l}?`,
    tapBack: "Tap to go back",
    destTitle: "Choose destination",
    close: "Close",
    searchTab: "🔍 Search",
    linesTab: "🚇 Lines",
    backToLines: "← Back to lines",
    clearDest: "Clear destination",
    searchPh: "Search by station name...",
    lineSearchPh: "Search lines or stations...",
    stationsCount: (n) => `${n} stations`,
    pwTitle: "⭐ Premium Plan",
    pw1: "🔔 <b>Get-off alert</b> — vibration & notification as you approach your stop. Never sleep past it",
    pw2: "🧭 <b>Next station</b> — predicts the next stop from your direction of travel",
    pw3: "🚃 <b>Line filter</b> — show only stations on your line",
    pw4: "📋 <b>Ride history</b> — automatically logs the stations you pass",
    pw5: "🚫 <b>No ads</b>",
    price: '¥240/month <span class="price-sub">or ¥1,800/year (save 38%)</span>',
    buyMonthly: "Subscribe monthly",
    buyYearly: "Subscribe yearly",
    buyDemo: "Upgrade (demo)",
    manageSub: "Manage / cancel subscription",
    cancelDemo: "Cancel premium (demo)",
    premiumBtn: "⭐ Premium",
    premiumMember: "⭐ Premium member",
    toastPremiumOn: "Premium is now active 🎉",
    toastActivateFail: "Couldn't verify your purchase. Please reopen the app later.",
    toastCheckoutFail: "Couldn't open the checkout page. Please check your connection.",
    toastPortalFail: "Couldn't open the management page. Please check your connection.",
    wakeLockFail: "Keeping the screen on is not supported on this device.",
  },
};

let lang = localStorage.getItem("lang");
if (!STRINGS[lang]) {
  lang = (navigator.language || "ja").startsWith("ja") ? "ja" : "en";
}

function t(key, ...args) {
  const v = STRINGS[lang][key] ?? STRINGS.ja[key] ?? key;
  return typeof v === "function" ? v(...args) : v;
}

function applyLang() {
  document.documentElement.lang = lang;
  localStorage.setItem("lang", lang);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  // 動的に組み立てている文言を現在の状態で再描画
  $("dest-btn").textContent = alertStation
    ? t("destSet", dispName(alertStation))
    : t("destBtn");
  if (alertStation) {
    $("alert-status-text").textContent = t("alertSet", dispName(alertStation));
    $("r-alert").textContent = t("alertSet", dispName(alertStation));
  }
  applyPlanUI();
  renderRideChip();
  renderLineFilter();
  if (curPos) render(curPos.lat, curPos.lon);
}

$("lang-btn").addEventListener("click", () => {
  lang = lang === "ja" ? "en" : "ja";
  applyLang();
});

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
        showToast(t("toastPremiumOn"), false);
      } catch {
        showToast(t("toastActivateFail"));
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
    showToast(t("toastCheckoutFail"));
  }
}

async function openPortal() {
  const lic = getLicense();
  if (!lic) return;
  try {
    const r = await api("/api/portal", { token: lic.token });
    location.href = r.url;
  } catch {
    showToast(t("toastPortalFail"));
  }
}

function applyPlanUI() {
  const premium = isPremium();
  const billing = billingEnabled();
  $("premium-btn").textContent = premium ? t("premiumMember") : t("premiumBtn");
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
    showError(t("geoUnsupported"));
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
  if (curPos) render(curPos.lat, curPos.lon);
});

// =====================================================================
// 位置情報
// =====================================================================
async function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  curPos = { lat, lon };
  gpsStatus.textContent = t("gpsAcc", Math.round(accuracy));
  gpsStatus.classList.add("ok");
  hideError();

  updateHeading(lat, lon, pos.coords.heading, pos.coords.speed);

  await selectStationSource(lat, lon);
  render(lat, lon);
  checkAlert(lat, lon);
}

// 埋め込みデータのカバー圏内ならそれを使い、圏外ならOverpassから取得する
async function selectStationSource(lat, lon) {
  const covered =
    EMBEDDED_STATIONS.length > 0 &&
    nearestEmbeddedDist(lat, lon) <= EMBEDDED_COVERAGE_M;

  if (covered) {
    if (!usingEmbedded) {
      usingEmbedded = true;
      stations = EMBEDDED_STATIONS;
      lineNames = [...new Set(stations.flatMap((s) => s.lines))].sort();
      renderLineFilter();
    }
    return;
  }

  if (usingEmbedded) {
    usingEmbedded = false;
    stations = [];
    lastFetchPos = null;
  }
  if (needsRefetch(lat, lon)) {
    await fetchStations(lat, lon);
  }
}

function nearestEmbeddedDist(lat, lon) {
  let min = Infinity;
  for (const s of EMBEDDED_STATIONS) {
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < min) min = d;
  }
  return min;
}

// 進行方向を更新する。低速時のGPS方位はノイズが大きく逆向きに出ることが
// あるため、信頼度の高い順に3つの情報源を使い、さらに直近3回の方位が
// 一致したときだけ表示用の方向を更新する (1回のノイズで反転させない)
function updateHeading(lat, lon, gpsHeading, speed) {
  let candidate = null;

  // 1) 直近に停車した駅からの実移動ベクトル (最も信頼できる)
  if (departureAnchor) {
    const d = haversine(departureAnchor.lat, departureAnchor.lon, lat, lon);
    if (d >= 250 && d <= 3000) {
      candidate = bearing(departureAnchor.lat, departureAnchor.lon, lat, lon);
    }
  }
  // 2) GPSの方位 (走行速度が十分あるときだけ信用する)
  if (
    candidate === null &&
    typeof gpsHeading === "number" &&
    !Number.isNaN(gpsHeading) &&
    typeof speed === "number" &&
    speed >= 3
  ) {
    candidate = gpsHeading;
  }
  // 3) 位置の差分
  if (candidate === null && prevPos) {
    const moved = haversine(prevPos.lat, prevPos.lon, lat, lon);
    if (moved >= NEXT_MIN_MOVE_M) {
      candidate = bearing(prevPos.lat, prevPos.lon, lat, lon);
    }
  }

  if (candidate !== null) {
    headingBuf.push(candidate);
    if (headingBuf.length > 3) headingBuf.shift();
    const mean = circularMean(headingBuf);
    const consistent = headingBuf.every((h) => angleDiff(h, mean) <= 45);
    if (consistent && headingBuf.length >= 2) heading = mean;
    // 一致しない間は前回の方向を保持し、表示が暴れないようにする
  }

  if (!prevPos || haversine(prevPos.lat, prevPos.lon, lat, lon) >= NEXT_MIN_MOVE_M) {
    prevPos = { lat, lon };
  }
}

// 角度の平均 (0度/360度の境界をまたいでも正しく平均できる円形平均)
function circularMean(arr) {
  let x = 0;
  let y = 0;
  for (const h of arr) {
    x += Math.cos((h * Math.PI) / 180);
    y += Math.sin((h * Math.PI) / 180);
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function onGeoError(err) {
  const messages = { 1: t("geo1"), 2: t("geo2"), 3: t("geo3") };
  showError(messages[err.code] || t("geoFail"));
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
  gpsStatus.textContent = t("fetching");
  // プライバシー保護: 外部APIには約1km単位に丸めた座標のみ送信し、
  // 正確な現在地を外部に出さない (丸め誤差ぶん検索半径を広げて補う)
  const qLat = lat.toFixed(2);
  const qLon = lon.toFixed(2);
  const radius = SEARCH_RADIUS_M + 1500;
  // 駅ノードに加えて、その駅を含む路線リレーションも取得し、
  // 駅→路線名のひも付けを作る (データが無い地域では路線絞り込みを非表示にする)
  const query = `
    [out:json][timeout:15];
    (
      node(around:${radius},${qLat},${qLon})["railway"="station"];
      node(around:${radius},${qLat},${qLon})["railway"="halt"];
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
  showError(t("fetchFail"));
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
  select.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = t("allLines");
  select.appendChild(allOpt);
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
    statusLabel.textContent = t("noStations");
    return;
  }

  const sorted = list
    .map((s) => ({ ...s, dist: haversine(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.dist - b.dist);

  // 乗車中と推定した路線の駅を優先する (並走する別路線の駅が出る問題への対策)。
  // ただし極端に遠い駅は選ばず、絶対的な最寄りに戻す
  let nearest = sorted[0];
  if (rideLines) {
    const onLine = sorted.find((s) => s.lines?.some((l) => rideLines.has(l)));
    if (onLine && onLine.dist <= sorted[0].dist * 1.6 + 200) {
      nearest = onLine;
    }
  }
  const atStation = nearest.dist <= AT_STATION_THRESHOLD_M;

  if (atStation) {
    // 停車駅の履歴から乗車路線を推定し、出発後の方向判定の基準点にする
    updateRideInference(nearest);
    departureAnchor = { name: nearest.name, lat: nearest.lat, lon: nearest.lon };
  }

  if (stationName.dataset.raw !== nearest.name) {
    stationName.dataset.raw = nearest.name;
    flashPop(stationName);
    flashPop($("r-station"));
  }

  statusLabel.textContent = atStation ? t("here") : t("nearest");
  statusLabel.classList.toggle("at-station", atStation);
  stationName.textContent = dispName(nearest);
  stationKana.textContent = dispSub(nearest);
  distanceEl.textContent = atStation ? "" : t("about", formatDistance(nearest.dist));
  renderLineChips(nearest);

  // 車内モード側にも同じ内容を反映
  $("r-status").textContent = statusLabel.textContent;
  $("r-status").classList.toggle("at-station", atStation);
  $("r-station").textContent = dispName(nearest);
  $("r-dist").textContent = atStation ? "" : t("about", formatDistance(nearest.dist));

  if (atStation) recordHistory(nearest.name);
  renderNextStation(lat, lon, sorted, nearest);
  renderAlertProgress(lat, lon, nearest);

  nearbyList.innerHTML = "";
  for (const s of sorted.slice(1, 1 + NEARBY_COUNT)) {
    nearbyList.appendChild(nearbyItem(s));
  }

  updatedAt.textContent = t(
    "updated",
    new Date().toLocaleTimeString(lang === "ja" ? "ja-JP" : "en-US")
  );
}

// =====================================================================
// 乗車路線の自動推定
// =====================================================================
// 連続して停車した2駅に共通する路線を「いま乗っている路線」とみなす。
// 共通路線がない場合 (乗り換えなど) は推定をリセットする
function updateRideInference(station) {
  if (lastRideStation?.name === station.name) return;
  if (lastRideStation) {
    const common = (station.lines || []).filter((l) =>
      (lastRideStation.lines || []).includes(l)
    );
    rideLines = common.length > 0 ? new Set(common) : null;
  }
  lastRideStation = { name: station.name, lines: station.lines || [] };
  renderRideChip();
}

function renderRideChip() {
  const chip = $("ride-chip");
  if (!rideLines || rideLines.size === 0) {
    chip.classList.add("hidden");
    return;
  }
  const names = [...rideLines];
  const label = names[0] + (names.length > 1 ? ` +${names.length - 1}` : "");
  $("ride-chip-text").textContent = t("rideChip", label);
  chip.classList.remove("hidden");
}

$("ride-chip-clear").addEventListener("click", () => {
  rideLines = null;
  lastRideStation = null;
  renderRideChip();
  if (curPos) render(curPos.lat, curPos.lon);
});

function nearbyItem(s) {
  const li = document.createElement("li");
  const name = document.createElement("span");
  name.textContent = dispName(s);
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

// 駅名の下に路線タグを表示 (埋め込みデータ利用時のみ路線名が入る)
function renderLineChips(nearest) {
  const wrap = $("station-lines");
  wrap.innerHTML = "";
  for (const line of (nearest.lines || []).slice(0, 4)) {
    const chip = document.createElement("span");
    chip.className = "line-chip";
    chip.textContent = line;
    wrap.appendChild(chip);
  }
}

// 前の駅・次の駅予測 (プレミアム):
// 進行方向との角度差で前後を判定し、同じ路線の駅を優先する
function renderNextStation(lat, lon, sorted, nearest) {
  const prevNextEl = $("prev-next");
  if (!isPremium() || heading === null) {
    nextStationEl.classList.add("hidden");
    prevNextEl.textContent = "";
    $("r-next").textContent = "";
    return;
  }

  const candidates = sorted.filter(
    (s) => s.name !== nearest.name && s.dist >= 250 && s.dist <= 8000
  );
  const sharesLine = (s) =>
    !nearest.lines?.length ||
    !s.lines?.length ||
    s.lines.some((l) => nearest.lines.includes(l));
  const pick = (test) =>
    candidates.find((s) => test(s) && sharesLine(s)) || candidates.find(test);

  const next = pick(
    (s) => angleDiff(heading, bearing(lat, lon, s.lat, s.lon)) <= NEXT_MAX_ANGLE_DEG
  );
  const prev = pick(
    (s) => angleDiff(heading, bearing(lat, lon, s.lat, s.lon)) >= 180 - NEXT_MAX_ANGLE_DEG
  );

  prevNextEl.textContent =
    prev || next
      ? `${prev ? `← ${dispName(prev)}` : ""}${prev && next ? "　|　" : ""}${next ? `${dispName(next)} →` : ""}`
      : "";

  if (next) {
    nextStationEl.textContent = t("nextIs", dispName(next), formatDistance(next.dist));
    nextStationEl.classList.remove("hidden");
    $("r-next").textContent = t("nextIsShort", dispName(next));
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
  alertStation = {
    name: station.name,
    kana: station.kana || "",
    romaji: station.romaji || "",
    lat: station.lat,
    lon: station.lon,
    lines: station.lines || [],
  };
  $("alert-status-text").textContent = t("alertSet", dispName(alertStation));
  $("alert-status").classList.remove("hidden");
  $("r-alert").textContent = t("alertSet", dispName(alertStation));
  $("dest-btn").textContent = t("destSet", dispName(alertStation));
  rememberDest(alertStation);
  if ("Notification" in window && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      /* 通知が使えなくても振動と画面表示で知らせる */
    }
  }
  if (curPos) render(curPos.lat, curPos.lon);
}

function cancelAlert() {
  alertStation = null;
  $("alert-status").classList.add("hidden");
  $("r-alert").textContent = "";
  $("dest-btn").textContent = t("destBtn");
}

// =====================================================================
// 目的地ピッカー (プレミアム): 駅名・ひらがな検索で降車アラートを設定
// =====================================================================
const DEST_RESULT_MAX = 50;

$("dest-btn").addEventListener("click", () => {
  if (!requirePremium()) return;
  $("dest-modal").classList.remove("hidden");
  showDestView("search");
  $("dest-search").value = "";
  $("dest-clear").classList.toggle("hidden", !alertStation);
  renderDestList("");
  $("dest-search").focus();
});
$("dest-close").addEventListener("click", closeDestModal);
$("dest-clear").addEventListener("click", () => {
  cancelAlert();
  closeDestModal();
});
$("dest-search").addEventListener("input", (e) =>
  renderDestList(e.target.value.trim())
);

function closeDestModal() {
  $("dest-modal").classList.add("hidden");
}

// 検索対象 = 埋め込み全駅 + 取得済みの周辺駅 (同名はマージ)
function destCandidates() {
  const seen = new Map();
  for (const s of [...EMBEDDED_STATIONS, ...stations]) {
    const exist = seen.get(s.name);
    if (!exist) {
      seen.set(s.name, s);
    } else if (s.lines?.length) {
      exist.lines = [...new Set([...(exist.lines || []), ...s.lines])];
    }
  }
  return [...seen.values()];
}

function renderDestList(query) {
  const listEl = $("dest-list");
  listEl.innerHTML = "";
  const hits = destCandidates()
    .filter(
      (s) =>
        !query ||
        s.name.includes(query) ||
        s.kana.includes(query) ||
        (s.romaji || "").toLowerCase().includes(query.toLowerCase())
    )
    .slice(0, DEST_RESULT_MAX);
  // 検索語が空のときは「最近の目的地」を先頭に出す (毎日同じ駅を使う通勤者向け)
  let items = hits;
  if (!query) {
    const recents = loadRecentDests().map((s) => ({ ...s, recent: true }));
    const names = new Set(recents.map((s) => s.name));
    items = [...recents, ...hits.filter((s) => !names.has(s.name))].slice(0, DEST_RESULT_MAX);
  }
  for (const s of items) {
    const li = document.createElement("li");
    li.className = "dest-item";
    const name = document.createElement("span");
    name.textContent = (s.recent ? "🕐 " : "") + dispName(s);
    const line = document.createElement("span");
    line.className = "dist";
    line.textContent = s.lines?.[0] || "";
    li.append(name, line);
    li.addEventListener("click", () => {
      setAlert(s);
      closeDestModal();
    });
    listEl.appendChild(li);
  }
}

// =====================================================================
// 路線図ピッカー: 路線 → 駅の2タップで目的地を設定 (通信ゼロ・端末内データのみ)
// =====================================================================
let lineIndexCache = null;

function getLineIndex() {
  if (!lineIndexCache) {
    lineIndexCache = new Map();
    for (const s of EMBEDDED_STATIONS) {
      for (const l of s.lines) {
        if (!lineIndexCache.has(l)) lineIndexCache.set(l, []);
        lineIndexCache.get(l).push(s);
      }
    }
  }
  return lineIndexCache;
}

// 駅データは路線順に並んでいる保証がないため、地理的に並べ直す:
// 最も離れた2駅を端点とみなし、片端から最近傍をたどる (環状線もそのまま一周になる)
function orderAlongRoute(list) {
  if (list.length <= 2) return list;
  let start = 0;
  let max = -1;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = haversine(list[i].lat, list[i].lon, list[j].lat, list[j].lon);
      if (d > max) {
        max = d;
        start = i;
      }
    }
  }
  const remaining = new Set(list.keys());
  const order = [start];
  remaining.delete(start);
  while (remaining.size > 0) {
    const last = list[order[order.length - 1]];
    let best = -1;
    let bestDist = Infinity;
    for (const i of remaining) {
      const d = haversine(last.lat, last.lon, list[i].lat, list[i].lon);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    order.push(best);
    remaining.delete(best);
  }
  return order.map((i) => list[i]);
}

// 正確な路線順データがあればそれを使い、なければ地理的に並べ直す
function orderedStations(lineName) {
  const members = getLineIndex().get(lineName) || [];
  const order = (window.LINE_ORDER || {})[lineName];
  if (order) {
    const byName = new Map(members.map((s) => [s.name, s]));
    const seq = order.map((n) => byName.get(n)).filter(Boolean);
    if (seq.length >= members.length * 0.8) return seq;
  }
  return orderAlongRoute(members);
}

function showDestView(view) {
  $("dest-search-view").classList.toggle("hidden", view !== "search");
  $("dest-lines-view").classList.toggle("hidden", view !== "lines");
  $("dest-stations-view").classList.toggle("hidden", view !== "stations");
  $("dest-tab-search").classList.toggle("active", view === "search");
  $("dest-tab-lines").classList.toggle("active", view !== "search");
}

$("dest-tab-search").addEventListener("click", () => showDestView("search"));
$("dest-tab-lines").addEventListener("click", () => {
  renderLineList($("line-search").value.trim());
  showDestView("lines");
});
$("line-search").addEventListener("input", (e) =>
  renderLineList(e.target.value.trim())
);
$("dest-back").addEventListener("click", () => showDestView("lines"));

// 路線名・路線かな・経由駅名のいずれかにマッチする路線を表示
function lineMatches(name, members, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  if (name.toLowerCase().includes(q)) return true;
  const kana = (window.LINE_META || {})[name]?.k || "";
  if (kana.includes(query)) return true;
  return members.some(
    (s) =>
      s.name.includes(query) ||
      (s.kana || "").includes(query) ||
      (s.romaji || "").toLowerCase().includes(q)
  );
}

function renderLineList(query = "") {
  const listEl = $("line-list");
  listEl.innerHTML = "";
  const index = getLineIndex();
  for (const name of [...index.keys()].sort()) {
    if (!lineMatches(name, index.get(name), query)) continue;
    const li = document.createElement("li");
    li.className = "dest-item";
    const label = document.createElement("span");
    const dot = document.createElement("span");
    dot.className = "line-dot";
    dot.style.background = lineColor(name);
    label.append(dot, document.createTextNode(name));
    const count = document.createElement("span");
    count.className = "dist";
    count.textContent = t("stationsCount", index.get(name).length);
    li.append(label, count);
    li.addEventListener("click", () => renderRouteList(name));
    listEl.appendChild(li);
  }
}

function renderRouteList(lineName) {
  const color = lineColor(lineName);
  $("dest-line-title").textContent = lineName;
  $("dest-line-title").style.color = color;
  const listEl = $("route-list");
  listEl.style.setProperty("--route-color", color);
  listEl.innerHTML = "";
  for (const s of orderedStations(lineName)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = dispName(s);
    const kana = document.createElement("span");
    kana.className = "kana";
    kana.textContent = lang === "en" ? "" : s.kana;
    li.append(name, kana);
    li.addEventListener("click", () => {
      setAlert(s);
      closeDestModal();
    });
    listEl.appendChild(li);
  }
  showDestView("stations");
}

// =====================================================================
// テーマ切り替え (グリーン / ブルー / ピンク)
// =====================================================================
const THEMES = ["green", "blue", "pink"];

function applyTheme(name) {
  document.body.dataset.theme = name;
  localStorage.setItem("theme", name);
}

$("theme-btn").addEventListener("click", () => {
  const current = document.body.dataset.theme || "green";
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  applyTheme(next);
});

applyTheme(
  THEMES.includes(localStorage.getItem("theme"))
    ? localStorage.getItem("theme")
    : "green"
);

// 目的地までの残り距離と駅数を表示する (路線順データがある場合のみ駅数を計算)
function renderAlertProgress(lat, lon, nearest) {
  if (!alertStation) return;
  const d = haversine(lat, lon, alertStation.lat, alertStation.lon);
  let extra = " ・ " + formatDistance(d);
  const stops = stopsBetween(nearest.name, alertStation.name, nearest.lines);
  if (stops !== null && stops > 0) extra += " ・ " + t("stopsLeft", stops);
  const text = t("alertSet", dispName(alertStation)) + extra;
  $("alert-status-text").textContent = text;
  $("r-alert").textContent = text;
}

function stopsBetween(fromName, toName, lines) {
  const orderMap = window.LINE_ORDER || {};
  for (const l of lines || []) {
    const arr = orderMap[l];
    if (!arr) continue;
    const i = arr.indexOf(fromName);
    const j = arr.indexOf(toName);
    if (i >= 0 && j >= 0) return Math.abs(i - j);
  }
  return null;
}

// 最近の目的地 (最大5件・端末内のみ)
function loadRecentDests() {
  try {
    return JSON.parse(localStorage.getItem("recentDests")) || [];
  } catch {
    return [];
  }
}

function rememberDest(st) {
  const list = loadRecentDests().filter((s) => s.name !== st.name);
  list.unshift({
    name: st.name,
    kana: st.kana || "",
    romaji: st.romaji || "",
    lat: st.lat,
    lon: st.lon,
    lines: st.lines || [],
  });
  localStorage.setItem("recentDests", JSON.stringify(list.slice(0, 5)));
}

function checkAlert(lat, lon) {
  if (!alertStation) return;
  const dist = haversine(lat, lon, alertStation.lat, alertStation.lon);
  if (dist > ALERT_DISTANCE_M) return;

  const name = dispName(alertStation);
  cancelAlert();
  $("alert-overlay-station").textContent = name;
  $("alert-overlay").classList.remove("hidden");
  navigator.vibrate?.([400, 200, 400, 200, 800]);
  beep();
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(t("notifTitle"), { body: t("notifBody", name), icon: "icon.svg" });
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
    showError(t("wakeLockFail"));
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

// =====================================================================
// ベータ運用: フィードバック導線・データ削除・アクセス解析
// =====================================================================
if (CONFIG.feedbackUrl) {
  const link = $("feedback-link");
  link.href = CONFIG.feedbackUrl;
  link.classList.remove("hidden");
}

// 端末内に保存した全データ (履歴・設定・ライセンス) をユーザー自身で削除できる
$("wipe-btn").addEventListener("click", () => {
  const ok = confirm(t("wipeConfirm"));
  if (!ok) return;
  localStorage.clear();
  location.reload();
});

// Cookie不使用のCloudflare Web Analytics (トークン設定時のみ読み込む)
if (CONFIG.cloudflareAnalyticsToken) {
  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.dataset.cfBeacon = JSON.stringify({
    token: CONFIG.cloudflareAnalyticsToken,
  });
  document.head.appendChild(s);
}

// ---- PWA: Service Worker登録 ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---- 起動時に言語と課金状態を初期化 ----
applyLang();
initBilling();
