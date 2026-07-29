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
const ACCURACY_WARN_M = 300;         // この誤差半径を超える測位は「精度低め」として警告表示
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

// アイコン付きボタンのラベルだけを差し替える (先頭のSVGを消さないため)
function setBtnLabel(id, text) {
  const span = $(id).querySelector("span");
  if (span) span.textContent = text;
  else $(id).textContent = text;
}

// index.html のスプライトからアイコン要素を作る (絵文字を使わないため)
function icon(name, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls ? `ic ${cls}` : "ic");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
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

// ---- ボトムシート / キーボード操作 ----
// 開閉の時間は style.css の --motion-exit と揃える。
const SHEET_CLOSE_MS = 180;
const sheetReturnFocus = new Map();
const sheetCloseTimers = new Map();

function currentOpenSheet() {
  return [...document.querySelectorAll(".modal-overlay")].find(
    (overlay) =>
      !overlay.classList.contains("hidden") &&
      !overlay.classList.contains("is-closing")
  );
}

function openSheet(id, initialFocus = null, explicitOpener = null) {
  const overlay = $(id);
  const pendingClose = sheetCloseTimers.get(id);
  if (pendingClose) window.clearTimeout(pendingClose);
  sheetCloseTimers.delete(id);

  const opener = explicitOpener || document.activeElement;
  if (opener && opener !== document.body) {
    sheetReturnFocus.set(id, opener);
    if (opener.getAttribute?.("aria-controls") === id) {
      opener.setAttribute("aria-expanded", "true");
    }
  }

  overlay.classList.remove("hidden", "is-closing");
  overlay.querySelector(".modal").scrollTop = 0;
  document.body.classList.add("sheet-open");

  window.requestAnimationFrame(() => {
    const target =
      initialFocus ||
      overlay.querySelector(
        "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"
      );
    target?.focus({ preventScroll: true });
  });
}

function closeSheet(id) {
  const overlay = $(id);
  if (
    overlay.classList.contains("hidden") ||
    overlay.classList.contains("is-closing")
  ) {
    return;
  }

  overlay.classList.add("is-closing");
  const timer = window.setTimeout(() => {
    overlay.classList.add("hidden");
    overlay.classList.remove("is-closing");
    sheetCloseTimers.delete(id);
    if (!currentOpenSheet()) document.body.classList.remove("sheet-open");

    const storedOpener = sheetReturnFocus.get(id);
    const opener = storedOpener?.isConnected
      ? storedOpener
      : document.querySelector(`[aria-controls="${id}"]`);
    if (opener?.getAttribute?.("aria-controls") === id) {
      opener.setAttribute("aria-expanded", "false");
    }
    opener?.focus?.({ preventScroll: true });
    sheetReturnFocus.delete(id);
  }, SHEET_CLOSE_MS);
  sheetCloseTimers.set(id, timer);
}

function makeKeyboardAction(el, action) {
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.addEventListener("click", action);
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    action();
  });
}

document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeSheet(overlay.id);
  });
});

document.addEventListener("keydown", (event) => {
  const overlay = currentOpenSheet();
  if (!overlay) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeSheet(overlay.id);
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = [...overlay.querySelectorAll(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
    "textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"
  )].filter((el) => !el.closest(".hidden") && el.offsetParent !== null);
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

// =====================================================================
// 多言語対応 (日本語 / English)
// =====================================================================
// 静的な文言はHTMLのdata-i18n属性、動的な文言はt()で参照する。
// 駅名は元データが日本語のため両言語で日本語表示 (ローマ字対応は今後の課題)
const STRINGS = {
  ja: {
    appName: "エキココ",
    tagline: "混雑した車内でも、<br>いまどの駅かひと目でわかる。",
    startBtn: "現在地を確認する",
    startNote: "位置情報は端末内だけで使い、保存しません。",
    privacyLink: "プライバシーポリシー",
    gpsWait: "GPS取得中…",
    gpsAcc: (n) => `GPS ±${n}m`,
    gpsAccLow: (n) => `GPS ±${n}m 誤差大`,
    fetching: "駅データ取得中…",
    fetchFail: "駅データを取得できません。通信状態を確認してください。",
    geo1: "位置情報が許可されていません。ブラウザの設定から許可してください。",
    geo2: "位置情報を取得できません。地下やトンネルではGPSが届きません。",
    geo3: "位置情報の取得がタイムアウトしました。",
    geoFail: "位置情報の取得に失敗しました。",
    geoUnsupported: "この端末では位置情報が利用できません。",
    nearest: "最寄り駅",
    here: "いまここ",
    noStations: "周辺に駅が見つかりません",
    about: (d) => `約 ${d}`,
    nextIs: (n, d) => `次は ${n}（${d}）`,
    nextIsShort: (n) => `次は ${n}`,
    ridingBtn: "車内モード",
    destBtn: "目的地",
    destSet: (n) => `目的地 ${n}`,
    alertSet: (n) => `${n} でアラート`,
    stopsLeft: (n) => `あと${n}駅`,
    cancel: "解除",
    soonTitle: "まもなく",
    notifTitle: "まもなく到着",
    notifBody: (n) => `${n} に近づいています`,
    alertDismiss: "アラートを停止",
    nearbyTitle: "周辺の駅",
    nearbyHint: "",
    historyTitle: "乗車履歴",
    adPlaceholder: "広告スペース",
    updated: (t) => `更新: ${t}`,
    privacyFooter: "プライバシー",
    feedback: "フィードバック",
    wipe: "データ削除",
    wipeConfirm: "端末に保存した履歴・目的地・設定をすべて削除します。よろしいですか？",
    credit: "駅データ: © OpenStreetMap contributors",
    lineFilterLabel: "路線で絞り込み",
    allLines: "すべての路線",
    rideChip: (l) => `${l} に乗車中？`,
    tapBack: "タップで戻る",
    destTitle: "目的地を選択",
    close: "閉じる",
    searchTab: "検索",
    linesTab: "路線図",
    backToLines: "← 路線一覧に戻る",
    clearDest: "目的地をクリア",
    searchPh: "駅名・ひらがなで検索...",
    lineSearchPh: "路線名・駅名で検索...",
    apiCredit: "全国の駅を含む",
    guideBtn: "乗り方ガイド",
    guideTitle: "改札の通り方",
    guideAsk: "何で乗りますか？",
    ticketQr: "QR",
    ticketIc: "ICカード",
    ticketPaper: "きっぷ",
    ticketJrpass: "JR Pass",
    gQrTitle: "QRをかざす",
    gQr:
      "<li><b>読み取り面のある改札</b>を探す（上面にガラスの窓）</li>" +
      "<li>画面を明るくして<b>かざして静止</b></li>" +
      "<li><b>出るときも同じQR</b>。捨てない</li>" +
      "<li>通らないときは<b>有人改札</b>へ</li>",
    gIcTitle: "ICカードをタッチ",
    gIc:
      "<li><b>青く光る面に1秒タッチ</b></li>" +
      "<li><b>入るときと同じカード</b>で出る</li>" +
      "<li>残高不足なら精算機へ（下）</li>" +
      "<li>Suica/PASMOは券売機で購入・チャージ</li>",
    gPaperTitle: "きっぷを入れて取る",
    gPaper:
      "<li><b>投入口に入れる</b></li>" +
      "<li>反対側で<b>必ず取る</b></li>" +
      "<li>降りる駅では回収される</li>" +
      "<li>運賃が不明なら<b>最安を買えばOK</b>（後で精算）</li>",
    gJrTitle: "有人改札で見せる",
    gJr:
      "<li><b>有人改札で見せる</b></li>" +
      "<li>新しいPassは自動改札に<b>投入もできる</b></li>" +
      "<li><b>JR線のみ有効</b>。地下鉄・私鉄は別料金</li>",
    gFareTitle: "閉まったら精算機へ",
    gFare:
      "<li>改札近くの<b>のりこし精算機</b>へ</li>" +
      "<li>きっぷ/ICを入れて<b>不足分を払う</b></li>" +
      "<li>出てきた券で改札を通れる</li>",
    ticketHintQr: "出場も同じQRをかざす",
    ticketHintIc: "入場と同じICカードで出る",
    ticketHintPaper: "きっぷは改札で回収される",
    ticketHintJrpass: "有人改札を通る",
    gTransferTitle: "会社が変わる乗り換え",
    gTransfer:
      "<li>JR・メトロ・私鉄は<b>別会社＝運賃も別</b></li>" +
      "<li>基本は<b>一度改札を出て入り直す</b></li>" +
      "<li><b>オレンジの乗換改札</b>ならそのまま通れる</li>",
    stationsCount: (n) => `${n}駅`,
    pwTitle: "プレミアム",
    pw1: "<b>降車アラート</b> — 降りる駅が近づくと通知。寝過ごし防止に",
    pw2: "<b>次の駅予測</b> — 進行方向から次の駅を表示",
    pw3: "<b>路線絞り込み</b> — 乗っている路線だけ表示",
    pw4: "<b>乗車履歴</b> — 通った駅を自動で記録",
    pw5: "<b>広告非表示</b>",
    price: '月額 240円 <span class="price-sub">/ 年額 1,800円（38%おトク）</span>',
    buyMonthly: "月額プランに登録する",
    buyYearly: "年額プランに登録する",
    buyDemo: "アップグレードする（デモ）",
    manageSub: "サブスクリプションを管理・解約する",
    cancelDemo: "プレミアムを解約する（デモ）",
    premiumBtn: "プレミアム",
    premiumMember: "会員",
    headerControls: "表示と端末の設定",
    controlLang: "言語",
    controlMode: "明暗",
    controlTheme: "配色",
    controlWake: "点灯",
    switchLanguage: (target) => `言語を${target}に切り替える`,
    switchToLight: "ライト表示に切り替える",
    switchToDark: "ダーク表示に切り替える",
    changeTheme: (name) => `配色を変更する。現在は${name}`,
    themeAmber: "アンバー",
    themeBlue: "ブルー",
    themePink: "ピンク",
    enableWakeLock: "画面の常時点灯を有効にする",
    disableWakeLock: "画面の常時点灯を解除する",
    openPremiumPlan: "プレミアム案内を開く",
    openMemberPlan: "会員プランを開く",
    toastPremiumOn: "プレミアムが有効になりました",
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
    gpsAccLow: (n) => `GPS ±${n}m low`,
    fetching: "Loading stations…",
    fetchFail: "Failed to load station data. Please check your connection.",
    geo1: "Location access is denied. Please allow it in your browser settings.",
    geo2: "Couldn't get your location. GPS may not work underground or in tunnels.",
    geo3: "Location request timed out.",
    geoFail: "Failed to get your location.",
    geoUnsupported: "Location is not available on this device.",
    nearest: "Nearest station",
    here: "You are here",
    noStations: "No stations found nearby",
    about: (d) => `approx. ${d}`,
    nextIs: (n, d) => `Next: ${n} (${d})`,
    nextIsShort: (n) => `Next: ${n}`,
    ridingBtn: "On-board",
    destBtn: "Destination",
    destSet: (n) => `To ${n}`,
    alertSet: (n) => `Alert at ${n}`,
    stopsLeft: (n) => `${n} ${n === 1 ? "stop" : "stops"} to go`,
    cancel: "Clear",
    soonTitle: "Arriving soon",
    notifTitle: "Arriving soon",
    notifBody: (n) => `Approaching ${n}`,
    alertDismiss: "Stop the alert",
    nearbyTitle: "Nearby stations",
    nearbyHint: "",
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
    rideChip: (l) => `Riding ${l}?`,
    tapBack: "Tap to go back",
    destTitle: "Choose destination",
    close: "Close",
    searchTab: "Search",
    linesTab: "Route map",
    backToLines: "← Back to lines",
    clearDest: "Clear destination",
    searchPh: "Search by station name...",
    lineSearchPh: "Search lines or stations...",
    apiCredit: "Includes nationwide stations",
    guideBtn: "Station guide",
    guideTitle: "Through the gate",
    guideAsk: "What are you traveling with?",
    ticketQr: "QR",
    ticketIc: "IC card",
    ticketPaper: "Ticket",
    ticketJrpass: "JR Pass",
    gQrTitle: "Scan your QR",
    gQr:
      "<li>Find a gate with a <b>glass reader on top</b></li>" +
      "<li>Screen bright, <b>hold it still</b></li>" +
      "<li><b>Same QR to exit</b> — keep it</li>" +
      "<li>Won't scan? Use the <b>staffed gate</b></li>",
    gIcTitle: "Touch your IC card",
    gIc:
      "<li><b>Touch the blue pad for 1 second</b></li>" +
      "<li><b>Same card in and out</b></li>" +
      "<li>Low balance? Fare Adjustment (below)</li>" +
      "<li>Buy/charge Suica at ticket machines</li>",
    gPaperTitle: "Insert, then take it back",
    gPaper:
      "<li><b>Insert into the slot</b></li>" +
      "<li><b>Take it</b> on the other side</li>" +
      "<li>Your last gate keeps it</li>" +
      "<li>Unsure of the fare? <b>Buy the cheapest</b></li>",
    gJrTitle: "Use the staffed gate",
    gJr:
      "<li><b>Show it at the staffed gate</b></li>" +
      "<li>Newer passes also <b>go into the gate</b></li>" +
      "<li><b>JR lines only</b> — subways cost extra</li>",
    gFareTitle: "Gate closed? Fare Adjustment",
    gFare:
      "<li>Find the <b>Fare Adjustment machine</b></li>" +
      "<li>Insert ticket/IC, <b>pay the difference</b></li>" +
      "<li>Use the ticket it gives you</li>",
    ticketHintQr: "Same QR to exit",
    ticketHintIc: "Same IC card to exit",
    ticketHintPaper: "The gate keeps your ticket",
    ticketHintJrpass: "Use the staffed gate",
    gTransferTitle: "Changing companies",
    gTransfer:
      "<li>JR, Metro and private lines are <b>separate fares</b></li>" +
      "<li>Usually <b>exit and enter again</b></li>" +
      "<li><b>Orange transfer gates</b> let you pass straight through</li>",
    stationsCount: (n) => `${n} stations`,
    pwTitle: "Premium",
    pw1: "<b>Get-off alert</b> — a nudge as your stop approaches",
    pw2: "<b>Next station</b> — predicted from your direction",
    pw3: "<b>Line filter</b> — only stations on your line",
    pw4: "<b>Ride history</b> — logs the stations you pass",
    pw5: "<b>No ads</b>",
    price: '¥240/month <span class="price-sub">or ¥1,800/year (save 38%)</span>',
    buyMonthly: "Subscribe monthly",
    buyYearly: "Subscribe yearly",
    buyDemo: "Upgrade (demo)",
    manageSub: "Manage / cancel subscription",
    cancelDemo: "Cancel premium (demo)",
    premiumBtn: "Premium",
    premiumMember: "Member",
    headerControls: "Display and device settings",
    controlLang: "LANG",
    controlMode: "MODE",
    controlTheme: "COLOR",
    controlWake: "AWAKE",
    switchLanguage: (target) => `Switch language to ${target}`,
    switchToLight: "Switch to light display",
    switchToDark: "Switch to dark display",
    changeTheme: (name) => `Change color theme. Current: ${name}`,
    themeAmber: "Amber",
    themeBlue: "Blue",
    themePink: "Pink",
    enableWakeLock: "Keep the screen awake",
    disableWakeLock: "Allow the screen to sleep",
    openPremiumPlan: "Open Premium details",
    openMemberPlan: "Open membership details",
    toastPremiumOn: "Premium is now active",
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

function updateHeaderUI() {
  const mode = document.body.dataset.mode || "dark";
  const theme = document.body.dataset.theme || "amber";
  const premium = isPremium();
  const wakeOn = Boolean(wakeLock);
  const themeNames = {
    amber: t("themeAmber"),
    blue: t("themeBlue"),
    pink: t("themePink"),
  };

  $("lang-btn-value").textContent = lang === "ja" ? "JA" : "EN";
  $("mode-btn-value").textContent = mode === "light" ? "LIGHT" : "DARK";
  $("theme-btn-value").textContent = theme.toUpperCase();
  $("wake-btn-value").textContent = wakeOn ? "ON" : "OFF";

  $("status-actions").setAttribute("aria-label", t("headerControls"));
  $("lang-btn").setAttribute(
    "aria-label",
    t("switchLanguage", lang === "ja" ? "English" : "日本語")
  );
  $("daynight-btn").setAttribute(
    "aria-label",
    t(mode === "light" ? "switchToDark" : "switchToLight")
  );
  $("theme-btn").setAttribute(
    "aria-label",
    t("changeTheme", themeNames[theme] || theme)
  );
  $("wakelock-btn").setAttribute("aria-pressed", String(wakeOn));
  $("wakelock-btn").setAttribute(
    "aria-label",
    t(wakeOn ? "disableWakeLock" : "enableWakeLock")
  );
  $("premium-btn").classList.toggle("is-member", premium);
  $("premium-btn").setAttribute(
    "aria-label",
    t(premium ? "openMemberPlan" : "openPremiumPlan")
  );
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
  setBtnLabel("dest-btn", alertStation ? t("destSet", dispName(alertStation)) : t("destBtn"));
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
const LICENSE_RECHECK_MS = 1 * 3600 * 1000; // サブスク状態の再確認間隔 (解約を約1時間以内に反映)

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
  $("premium-btn-label").textContent = premium ? t("premiumMember") : t("premiumBtn");
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
  updateHeaderUI();
}

// 「プレミアム機能を使おうとしたら案内を出す」ゲート
function requirePremium(opener = null) {
  if (isPremium()) return true;
  openSheet("paywall", null, opener);
  return false;
}

$("premium-btn").addEventListener("click", (event) =>
  openSheet("paywall", null, event.currentTarget)
);
$("paywall-close").addEventListener("click", () => closeSheet("paywall"));

// =====================================================================
// 駅の乗り方ガイド (訪日客向け・無料機能)
// =====================================================================
// きっぷ種別 (QR/IC/紙/JR Pass) を1回選んでもらい、その種別の通り方に
// 案内を絞る。選択は端末内 (localStorage) のみに保存。未選択なら全種別を表示。
// 2027年春からの首都圏QR乗車券移行で、QRの「リーダー付き改札を探す」案内が要になる。
function getTicketType() {
  const v = localStorage.getItem("ticketType");
  return ["qr", "ic", "paper", "jrpass"].includes(v) ? v : null;
}

function renderGuide() {
  const sel = getTicketType();
  document.querySelectorAll("#guide-modal .chip-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.ticket === sel);
    b.setAttribute("aria-pressed", String(b.dataset.ticket === sel));
  });
  document.querySelectorAll("#guide-modal .guide-sec").forEach((sec) => {
    const key = sec.dataset.sec;
    const common = key === "common" || key === "common2";
    sec.classList.toggle("hidden", !common && sel !== null && key !== sel);
  });
}

$("guide-btn").addEventListener("click", (event) => {
  renderGuide();
  openSheet("guide-modal", null, event.currentTarget);
});
$("guide-close").addEventListener("click", () => closeSheet("guide-modal"));
document.querySelectorAll("#guide-modal .chip-btn").forEach((b) => {
  b.addEventListener("click", () => {
    // 同じ種別をもう一度タップすると選択解除 (全種別表示に戻る)
    if (getTicketType() === b.dataset.ticket) {
      localStorage.removeItem("ticketType");
    } else {
      localStorage.setItem("ticketType", b.dataset.ticket);
    }
    renderGuide();
  });
});
$("buy-monthly-btn").addEventListener("click", () => startCheckout("monthly"));
$("buy-yearly-btn").addEventListener("click", () => startCheckout("yearly"));
$("manage-btn").addEventListener("click", openPortal);
$("purchase-btn").addEventListener("click", () => {
  setPlan("premium");
  closeSheet("paywall");
});
$("restore-btn").addEventListener("click", () => {
  setPlan("free");
  closeSheet("paywall");
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
  // 誤差半径が大きい測位 (Wi-Fi/基地局による概算など) は駅を取り違えることがあるため、
  // 「参考程度」と明示する。位置自体はそのまま使う (無視すると更新が止まって見えるため)
  const lowAcc = accuracy > ACCURACY_WARN_M;
  gpsStatus.textContent = t(lowAcc ? "gpsAccLow" : "gpsAcc", Math.round(accuracy));
  gpsStatus.classList.toggle("ok", !lowAcc);
  gpsStatus.classList.toggle("warn", lowAcc);
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
  const on = alertStation?.name === s.name;
  bell.appendChild(icon(on ? "bell" : "bell-off"));
  bell.classList.toggle("on", on);
  bell.title = "この駅で降車アラートを設定";
  bell.addEventListener("click", (event) => setAlert(s, event.currentTarget));
  right.append(dist, bell);
  li.append(name, right);
  return li;
}

// 駅名の下に路線タグを表示 (埋め込みデータ利用時のみ路線名が入る)
function renderLineChips(nearest) {
  const wrap = $("station-lines");
  wrap.innerHTML = "";
  const lines = (nearest.lines || []).slice(0, 4);
  for (const line of lines) {
    const chip = document.createElement("span");
    chip.className = "line-chip";
    chip.textContent = line;
    // 実際の路線カラーを使う (駅名標・路線図と同じ色で揃える)
    chip.style.setProperty("--chip-color", lineColor(line));
    wrap.appendChild(chip);
  }
  // 駅名表示の控えめなアクセントを、その駅の代表路線色に合わせる
  const plate = document.querySelector(".station-display");
  if (plate) {
    plate.style.setProperty("--route-color", lines[0] ? lineColor(lines[0]) : "");
  }
  // 車内モードの上下の帯も同じ色で揃える
  const riding = $("riding-screen");
  if (riding) {
    riding.style.setProperty("--route-color", lines[0] ? lineColor(lines[0]) : "");
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
async function setAlert(station, opener = null) {
  if (!requirePremium(opener)) return;
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
  setBtnLabel("dest-btn", t("destSet", dispName(alertStation)));
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
  setBtnLabel("dest-btn", t("destBtn"));
}

// =====================================================================
// 目的地ピッカー (プレミアム): 駅名・ひらがな検索で降車アラートを設定
// =====================================================================
const DEST_RESULT_MAX = 50;

$("dest-btn").addEventListener("click", (event) => {
  if (!requirePremium(event.currentTarget)) return;
  showDestView("search");
  $("dest-search").value = "";
  $("dest-clear").classList.toggle("hidden", !alertStation);
  renderDestList("");
  openSheet("dest-modal", $("dest-search"), event.currentTarget);
});
$("dest-close").addEventListener("click", closeDestModal);
$("dest-clear").addEventListener("click", () => {
  cancelAlert();
  closeDestModal();
});
$("dest-search").addEventListener("input", (e) =>
  onDestSearchInput(e.target.value.trim())
);

function closeDestModal() {
  closeSheet("dest-modal");
}

// =====================================================================
// 全国駅検索 (自前データ / stations_jp.js を遅延ロード)
// =====================================================================
// 内蔵データ(首都圏+関西)に無い駅も目的地に設定できるよう、全国の駅インデックス
// (約9,000駅・名前/かな/ローマ字/座標のみ) を別ファイルで持つ。初回ロードを
// 軽く保つため目的地検索を使ったときだけ取得し、以降はSWがキャッシュする。
// 検索は端末内で完結し、外部に何も送信しない。
let jpIndex = null;        // window.STATIONS_JP (ロード後)
let jpIndexLoading = null; // 多重ロード防止
let jpResults = [];        // 直近の全国検索結果 (内蔵結果とマージして表示)
let jpSearchSeq = 0;

function loadJpIndex() {
  if (jpIndex) return Promise.resolve(jpIndex);
  if (jpIndexLoading) return jpIndexLoading;
  jpIndexLoading = new Promise((resolve) => {
    if (window.STATIONS_JP) {
      jpIndex = window.STATIONS_JP;
      resolve(jpIndex);
      return;
    }
    const sc = document.createElement("script");
    sc.src = "stations_jp.js";
    sc.onload = () => {
      jpIndex = window.STATIONS_JP || [];
      resolve(jpIndex);
    };
    sc.onerror = () => {
      // オフラインで未キャッシュなら内蔵検索のみで継続
      jpIndex = [];
      resolve(jpIndex);
    };
    document.head.appendChild(sc);
  });
  return jpIndexLoading;
}

function onDestSearchInput(query) {
  renderDestList(query); // まず内蔵データで即時表示
  if (query.length < 2) {
    jpResults = [];
    return;
  }
  loadJpIndex().then((idx) => searchJp(query, idx));
}

function searchJp(query, idx) {
  const seq = ++jpSearchSeq;
  const q = query.toLowerCase();
  const hits = [];
  for (const s of idx) {
    if (
      s.name.includes(query) ||
      (s.k || "").includes(query) ||
      (s.r || "").toLowerCase().includes(q)
    ) {
      hits.push({
        name: s.name,
        kana: s.k || "",
        romaji: s.r || "",
        lat: s.lat,
        lon: s.lng,
        lines: [],
        source: "jp",
      });
      if (hits.length >= 30) break;
    }
  }
  if (seq !== jpSearchSeq) return; // より新しい入力が来ていたら破棄
  jpResults = hits;
  renderDestList(query);
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

// 検索語との一致度 (小さいほど上位): 完全一致 < 前方一致 < かな前方 < ローマ字前方 < 部分一致
function destRelevance(s, query, q) {
  if (s.name === query) return 0;
  if (s.name.startsWith(query)) return 1;
  if ((s.kana || "").startsWith(query)) return 2;
  if ((s.romaji || "").toLowerCase().startsWith(q)) return 3;
  return 4;
}

function renderDestList(query) {
  const listEl = $("dest-list");
  listEl.innerHTML = "";
  const hits = destCandidates().filter(
    (s) =>
      !query ||
      s.name.includes(query) ||
      s.kana.includes(query) ||
      (s.romaji || "").toLowerCase().includes(query.toLowerCase())
  );

  let items;
  if (!query) {
    // 検索語が空のときは「最近の目的地」を先頭に (毎日同じ駅を使う通勤者向け)
    const recents = loadRecentDests().map((s) => ({ ...s, recent: true }));
    const names = new Set(recents.map((s) => s.name));
    items = [...recents, ...hits.filter((s) => !names.has(s.name))].slice(0, DEST_RESULT_MAX);
  } else {
    // 内蔵に無い駅は全国データで補完し、完全一致→前方一致→部分一致の順に並べる
    const localNames = new Set(hits.map((s) => s.name));
    const jpExtra = jpResults.filter((s) => !localNames.has(s.name));
    const q = query.toLowerCase();
    items = [...hits, ...jpExtra]
      .sort((a, b) => {
        const sa = destRelevance(a, query, q);
        const sb = destRelevance(b, query, q);
        if (sa !== sb) return sa - sb;
        const la = a.source === "jp" ? 1 : 0; // 同点なら内蔵(路線情報あり)を優先
        const lb = b.source === "jp" ? 1 : 0;
        if (la !== lb) return la - lb;
        return a.name.length - b.name.length;
      })
      .slice(0, DEST_RESULT_MAX);
  }

  for (const s of items) {
    const li = document.createElement("li");
    li.className = "dest-item";
    const name = document.createElement("span");
    if (s.recent) name.appendChild(icon("clock", "ic-sm"));
    else if (s.source === "jp") name.appendChild(icon("globe", "ic-sm"));
    name.appendChild(document.createTextNode(dispName(s)));
    const line = document.createElement("span");
    line.className = "dist";
    line.textContent = s.lines?.[0] || "";
    li.append(name, line);
    makeKeyboardAction(li, () => {
      setAlert(s);
      closeDestModal();
    });
    listEl.appendChild(li);
  }

  // 全国データ由来の結果を表示しているときは目印を説明
  const credit = $("dest-credit");
  if (credit) {
    const usingJp = items.some((s) => s.source === "jp");
    credit.textContent = usingJp ? t("apiCredit") : "";
    credit.classList.toggle("hidden", !usingJp);
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
  $("dest-tab-search").setAttribute("aria-selected", String(view === "search"));
  $("dest-tab-lines").setAttribute("aria-selected", String(view !== "search"));
  $("dest-modal").querySelector(".modal").scrollTop = 0;
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
    makeKeyboardAction(li, () => renderRouteList(name));
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
    makeKeyboardAction(li, () => {
      setAlert(s);
      closeDestModal();
    });
    listEl.appendChild(li);
  }
  showDestView("stations");
}

// =====================================================================
// テーマ切り替え (アンバー / ブルー / ピンク)
// =====================================================================
const THEMES = ["amber", "blue", "pink"];

function applyTheme(name) {
  document.body.dataset.theme = name;
  localStorage.setItem("theme", name);
  updateHeaderUI();
}

$("theme-btn").addEventListener("click", () => {
  const current = document.body.dataset.theme || "amber";
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  applyTheme(next);
});

applyTheme(
  THEMES.includes(localStorage.getItem("theme"))
    ? localStorage.getItem("theme")
    : "amber"
);

// =====================================================================
// ライト/ダークモード切り替え
// =====================================================================
const MODE_BG = { light: "#f6f2ea", dark: "#0a0b10" };

function applyMode(mode) {
  document.body.dataset.mode = mode;
  localStorage.setItem("mode", mode);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", MODE_BG[mode]);
  updateHeaderUI();
}

$("daynight-btn").addEventListener("click", () => {
  applyMode(document.body.dataset.mode === "light" ? "dark" : "light");
});

applyMode(localStorage.getItem("mode") === "light" ? "light" : "dark");

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
  // 乗り方ガイドで選んだきっぷ種別があれば、改札を通る直前の一言を添える
  // (ガイド自体は自分から開かないと見ないため、必要な瞬間に自動で出す)
  const ticket = getTicketType();
  const hintKey = ticket && { qr: "ticketHintQr", ic: "ticketHintIc", paper: "ticketHintPaper", jrpass: "ticketHintJrpass" }[ticket];
  $("alert-ticket-hint").textContent = hintKey ? t(hintKey) : "";
  $("alert-ticket-hint").classList.toggle("hidden", !hintKey);
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
$("riding-screen").addEventListener("click", (event) => {
  if (event.target.closest?.("#riding-exit-btn")) return;
  exitRidingMode();
});
$("riding-exit-btn").addEventListener("click", exitRidingMode);
$("riding-screen").addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  exitRidingMode();
});

async function enterRidingMode() {
  $("riding-screen").classList.remove("hidden");
  $("riding-btn").setAttribute("aria-expanded", "true");
  $("riding-exit-btn").focus({ preventScroll: true });
  updateRidingClock();
  ridingClockTimer = setInterval(updateRidingClock, 1000);
  // 車内モード中は画面を消灯させない (非対応端末では表示のみ)
  ridingAcquiredWakeLock = !wakeLock && (await acquireWakeLock());
}

function exitRidingMode() {
  $("riding-screen").classList.add("hidden");
  $("riding-btn").setAttribute("aria-expanded", "false");
  clearInterval(ridingClockTimer);
  if (ridingAcquiredWakeLock) releaseWakeLock();
  ridingAcquiredWakeLock = false;
  $("riding-btn").focus({ preventScroll: true });
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
    updateHeaderUI();
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      $("wakelock-btn").classList.remove("active");
      updateHeaderUI();
    });
    return true;
  } catch {
    return false;
  }
}

async function releaseWakeLock() {
  if (wakeLock) await wakeLock.release();
  updateHeaderUI();
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
