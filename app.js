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
let pendingDestination = null; // モーダル内で選択中、未確定の目的地
let lastHistoryName = null;
let geoWatchId = null;
let geoState = "idle";
let lastGpsAccuracy = null;

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

// ---- モーション / オーバーレイ / キーボード操作 ----
const reduceMotionQuery = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
);
const motionMs = (normalMs) => (reduceMotionQuery.matches ? 1 : normalMs);
const SHEET_CLOSE_MS = 180;
const sheetReturnFocus = new Map();
const sheetCloseTimers = new Map();
const overlayStack = [];
const overlayFrames = new Map();

function currentOpenSheet() {
  return [...overlayStack]
    .reverse()
    .map((frame) => frame.overlay)
    .find((overlay) => overlay.classList.contains("modal-overlay")) || null;
}

function topOverlay() {
  return overlayStack.at(-1)?.overlay || null;
}

function activateOverlay(overlay) {
  if (overlayFrames.has(overlay.id)) return;
  const siblings = [...$("app").children].filter(
    (item) => item !== overlay && item.id !== "error-banner"
  );
  const snapshot = siblings.map((item) => ({
    item,
    inert: item.inert,
    ariaHidden: item.getAttribute("aria-hidden"),
  }));
  for (const { item } of snapshot) {
    item.inert = true;
    item.setAttribute("aria-hidden", "true");
  }
  overlay.inert = false;
  overlay.setAttribute("aria-hidden", "false");
  const frame = { overlay, snapshot };
  overlayFrames.set(overlay.id, frame);
  overlayStack.push(frame);
}

function deactivateOverlay(overlay) {
  const frame = overlayFrames.get(overlay.id);
  if (!frame) return;
  for (const { item, inert, ariaHidden } of frame.snapshot) {
    item.inert = inert;
    if (ariaHidden === null) item.removeAttribute("aria-hidden");
    else item.setAttribute("aria-hidden", ariaHidden);
  }
  overlay.inert = true;
  overlay.setAttribute("aria-hidden", "true");
  overlayFrames.delete(overlay.id);
  const index = overlayStack.indexOf(frame);
  if (index >= 0) overlayStack.splice(index, 1);
}

function focusableIn(container) {
  return [...container.querySelectorAll(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
    "textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"
  )].filter(
    (element) =>
      !element.closest(".hidden") &&
      element.getClientRects().length > 0 &&
      element.tabIndex >= 0 &&
      !element.closest("[inert]")
  );
}

function trapOverlayFocus(event, overlay) {
  if (event.key !== "Tab") return;
  const focusable = focusableIn(overlay);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
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

  overlay.dataset.state = "opening";
  overlay.classList.remove("hidden", "is-closing");
  overlay.querySelector(".modal").scrollTop = 0;
  document.body.classList.add("sheet-open");
  activateOverlay(overlay);

  window.requestAnimationFrame(() => {
    overlay.dataset.state = "open";
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
  if (id === "guide-modal") stopGuideAnimation();
  if (
    overlay.classList.contains("hidden") ||
    overlay.classList.contains("is-closing")
  ) {
    return;
  }

  overlay.classList.add("is-closing");
  overlay.dataset.state = "closing";
  const controlledOpener =
    sheetReturnFocus.get(id) ||
    document.querySelector(`[aria-controls="${id}"]`);
  if (controlledOpener?.getAttribute?.("aria-controls") === id) {
    controlledOpener.setAttribute("aria-expanded", "false");
  }
  const timer = window.setTimeout(() => {
    overlay.classList.add("hidden");
    overlay.classList.remove("is-closing");
    overlay.dataset.state = "closed";
    sheetCloseTimers.delete(id);
    deactivateOverlay(overlay);
    if (!topOverlay()) document.body.classList.remove("sheet-open");

    const storedOpener = sheetReturnFocus.get(id);
    const opener = storedOpener?.isConnected
      ? storedOpener
      : document.querySelector(`[aria-controls="${id}"]`);
    opener?.focus?.({ preventScroll: true });
    sheetReturnFocus.delete(id);
  }, motionMs(SHEET_CLOSE_MS));
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
  const overlay = topOverlay();
  if (!overlay) return;

  if (event.key === "Escape") {
    event.preventDefault();
    if (overlay.id === "alert-overlay") dismissArrivalAlert();
    else if (overlay.id === "settings-overlay") setSettingsOpen(false, true);
    else closeSheet(overlay.id);
    return;
  }
  trapOverlayFocus(event, overlay);
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
    brandDescriptor: "駅位置インストゥルメント",
    settingsLabel: "表示設定",
    gpsWait: "GPS取得中…",
    gpsRequestingDetail: "現在地を確認しています。",
    gpsReady: "現在地を取得しました",
    gpsDenied: "位置情報がオフです",
    gpsUnavailable: "現在地を取得できません",
    gpsTimedOut: "取得がタイムアウトしました",
    gpsRetry: "もう一度試す",
    gpsSettingsHint: "端末の設定で、このサイトの位置情報を許可してください。",
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
    ridingHint: "駅名を拡大し、低照度で表示",
    destBtn: "目的地",
    destinationLabel: "降りる駅",
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
    historyEmpty: "乗車履歴はまだありません。移動した駅がここに記録されます。",
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
    tapBack: "通常表示に戻る",
    destTitle: "どこで降りますか？",
    destPrompt: "降りる駅を選ぶ",
    destPromptHint: "地図・駅名・路線から",
    destChangeHint: "タップして目的地を変更",
    destIntro: "地図、駅名検索、路線から降りる駅を選べます。",
    close: "閉じる",
    mapTab: "地図",
    searchTab: "検索",
    linesTab: "路線",
    mapCurrent: "現在地へ",
    mapHint: "ドラッグ／矢印で移動、＋−でズーム、Enterで駅を選択",
    mapLoading: "全国の駅を読み込み中…",
    mapNoLocation: "現在地を取得できていません",
    mapVisible: (n) => `${n}駅を表示`,
    mapLimited: (n) => `中心に近い${n}駅を表示しています`,
    mapZoomIn: "地図を拡大",
    mapZoomOut: "地図を縮小",
    mapRegionLabel: "目的地の駅を選ぶ地図",
    mapNoStations: "この範囲に駅が見つかりません",
    mapZoomMore: "拡大すると駅を選べます",
    destMapStatus: "現在地周辺の駅",
    destMapLocate: "現在地へ",
    destMapZoomIn: "地図を拡大",
    destMapZoomOut: "地図を縮小",
    destMapHint: "ドラッグ／矢印で移動、＋−でズーム、Enterで駅を選択",
    destSelected: (n) => `${n}を選択中`,
    destProvisionalSelected: (n) => `${n}を仮選択しました`,
    provisionalSelection: "仮選択",
    currentSelection: "設定済み",
    destConfirm: "この駅を目的地にする",
    destDistance: (d) => `現在地から${d}`,
    backToLines: "← 路線一覧に戻る",
    clearDest: "目的地をクリア",
    searchLabel: "駅名から探す",
    lineSearchLabel: "路線名・駅名から探す",
    searchPh: "駅名・ひらがなで検索...",
    lineSearchPh: "路線名・駅名で検索...",
    searchIdle: "最近の目的地と現在地周辺から8件を表示します。",
    searchLoading: "全国の駅を検索しています…",
    searchEmpty: (q) => `「${q}」に一致する駅はありません。`,
    lineEmpty: (q) => q ? `「${q}」に一致する路線はありません。` : "路線が見つかりません。",
    resultsCount: (shown, total) => `${total}件中${shown}件を表示`,
    clearSearch: "検索をクリア",
    showMore20: "さらに20件表示",
    apiCredit: "全国の駅を含む",
    guideBtn: "乗り方ガイド",
    guideTitle: "改札の通り方",
    guideAsk: "何で乗りますか？",
    ticketAll: "すべて",
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
    pwTitle: "EKIKOKO Plus",
    pw1: "<b>降車アラート</b> — 降りる駅が近づくと通知。寝過ごし防止に",
    pw2: "<b>次の駅予測</b> — 進行方向から次の駅を表示",
    pw3: "<b>路線絞り込み</b> — 乗っている路線だけ表示",
    pw4: "<b>乗車履歴</b> — 通った駅を自動で記録",
    pw5: "<b>広告非表示</b>",
    price: '月額 240円 <span class="price-sub">/ 年額 1,800円（38%おトク）</span>',
    buyMonthly: "月額プランに登録する",
    buyYearly: "年額プランに登録する",
    buyDemo: "デモ機能を有効にする",
    manageSub: "サブスクリプションを管理・解約する",
    cancelDemo: "デモを終了する",
    premiumBtn: "機能を見る",
    premiumMember: "会員機能",
    plusDescription: "降車前通知・次駅予測・乗車履歴",
    plusPreviewTitle: "Plus 機能プレビュー",
    plusPreviewDetail: "デモ環境です。課金は発生しません。",
    plusDemoTitle: "デモ機能を利用中",
    plusDemoDetail: "降車前通知などのPlus機能を端末内で試せます。",
    plusAvailableTitle: "Plus を利用できます",
    plusAvailableDetail: "プランを選ぶと決済ページへ移動します。",
    plusActiveTitle: "Plus を利用中",
    plusActiveDetail: "現在の契約内容は管理画面で確認できます。",
    plusPending: "処理しています…",
    plusDemoEnabled: "デモ機能を有効にしました。",
    plusDemoEnded: "デモを終了しました。",
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
    brandDescriptor: "Station location instrument",
    settingsLabel: "Display",
    gpsWait: "Getting GPS…",
    gpsRequestingDetail: "Checking your current location.",
    gpsReady: "Location found",
    gpsDenied: "Location is turned off",
    gpsUnavailable: "Location unavailable",
    gpsTimedOut: "Location request timed out",
    gpsRetry: "Try again",
    gpsSettingsHint: "Allow location access for this site in your device settings.",
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
    ridingHint: "Enlarge the station name in low light",
    destBtn: "Destination",
    destinationLabel: "Your stop",
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
    historyEmpty: "No ride history yet. Stations you pass will appear here.",
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
    tapBack: "Return to standard view",
    destTitle: "Where are you getting off?",
    destPrompt: "Choose where to get off",
    destPromptHint: "From the map, station name, or line",
    destChangeHint: "Tap to change destination",
    destIntro: "Choose your stop from the map, station search, or line.",
    close: "Close",
    mapTab: "Map",
    searchTab: "Search",
    linesTab: "Lines",
    mapCurrent: "My location",
    mapHint: "Drag or use arrow keys to move; +/− to zoom; Enter for stations",
    mapLoading: "Loading stations across Japan…",
    mapNoLocation: "Your location is not available yet",
    mapVisible: (n) => `Showing ${n} stations`,
    mapLimited: (n) => `Showing the ${n} stations nearest the center`,
    mapZoomIn: "Zoom in",
    mapZoomOut: "Zoom out",
    mapRegionLabel: "Map for choosing a destination station",
    mapNoStations: "No stations found in this area",
    mapZoomMore: "Zoom in to choose a station",
    destMapStatus: "Stations around this area",
    destMapLocate: "My location",
    destMapZoomIn: "Zoom in",
    destMapZoomOut: "Zoom out",
    destMapHint: "Drag or use arrow keys to move; +/− to zoom; Enter for stations",
    destSelected: (n) => `${n} selected`,
    destProvisionalSelected: (n) => `${n} provisionally selected`,
    provisionalSelection: "Provisional",
    currentSelection: "Current destination",
    destConfirm: "Set this station as destination",
    destDistance: (d) => `${d} from your location`,
    backToLines: "← Back to lines",
    clearDest: "Clear destination",
    searchLabel: "Search by station",
    lineSearchLabel: "Search lines or stations",
    searchPh: "Search by station name...",
    lineSearchPh: "Search lines or stations...",
    searchIdle: "Showing up to 8 recent and nearby stations.",
    searchLoading: "Searching stations across Japan…",
    searchEmpty: (q) => `No stations match “${q}”.`,
    lineEmpty: (q) => q ? `No lines match “${q}”.` : "No lines found.",
    resultsCount: (shown, total) => `Showing ${shown} of ${total}`,
    clearSearch: "Clear search",
    showMore20: "Show 20 more",
    apiCredit: "Includes nationwide stations",
    guideBtn: "Station guide",
    guideTitle: "Through the gate",
    guideAsk: "What are you traveling with?",
    ticketAll: "All",
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
    pwTitle: "EKIKOKO Plus",
    pw1: "<b>Get-off alert</b> — a nudge as your stop approaches",
    pw2: "<b>Next station</b> — predicted from your direction",
    pw3: "<b>Line filter</b> — only stations on your line",
    pw4: "<b>Ride history</b> — logs the stations you pass",
    pw5: "<b>No ads</b>",
    price: '¥240/month <span class="price-sub">or ¥1,800/year (save 38%)</span>',
    buyMonthly: "Subscribe monthly",
    buyYearly: "Subscribe yearly",
    buyDemo: "Enable demo features",
    manageSub: "Manage / cancel subscription",
    cancelDemo: "End demo",
    premiumBtn: "View features",
    premiumMember: "Member features",
    plusDescription: "Arrival alerts, next station and ride history",
    plusPreviewTitle: "Plus feature preview",
    plusPreviewDetail: "This is a demo environment. You will not be charged.",
    plusDemoTitle: "Demo features active",
    plusDemoDetail: "Try Plus features such as arrival alerts on this device.",
    plusAvailableTitle: "Plus is available",
    plusAvailableDetail: "Choose a plan to continue to checkout.",
    plusActiveTitle: "Plus is active",
    plusActiveDetail: "View or change your subscription in the management page.",
    plusPending: "Working…",
    plusDemoEnabled: "Demo features are now active.",
    plusDemoEnded: "The demo has ended.",
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
  $("settings-btn").setAttribute("aria-label", t("settingsLabel"));
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

function updateDestinationAction() {
  const label = $("dest-btn-label");
  const hint = $("dest-btn-hint");
  const primary = alertStation
    ? t("destSet", dispName(alertStation))
    : t("destPrompt");
  const hintText = t(alertStation ? "destChangeHint" : "destPromptHint");

  if (label) label.textContent = primary;
  else if ($("dest-btn")) setBtnLabel("dest-btn", primary);
  if (hint) hint.textContent = hintText;
  $("dest-btn")?.setAttribute("aria-label", `${primary}. ${hintText}`);
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
  for (const id of ["dest-close", "guide-close", "paywall-close"]) {
    const closeButton = $(id);
    if (!closeButton) continue;
    closeButton.title = t("close");
    closeButton.setAttribute("aria-label", t("close"));
  }
  // 動的に組み立てている文言を現在の状態で再描画
  updateDestinationAction();
  if (alertStation) {
    $("alert-status-text").textContent = t("alertSet", dispName(alertStation));
    $("r-alert").textContent = t("alertSet", dispName(alertStation));
  }
  updateDestinationI18n();
  renderPendingDestination();
  if (isDestMapVisible()) renderDestMap();
  applyPlanUI();
  renderGuide(false);
  if (geoState !== "idle") {
    setGpsState(geoState);
    $("screen-live").textContent =
      geoState === "success"
        ? t("gpsReady")
        : `${gpsStatus.textContent}. ${$("gps-state-detail").textContent}`;
  }
  if (!$("dest-modal").classList.contains("hidden")) {
    renderDestList($("dest-search").value.trim());
    renderLineList($("line-search").value.trim());
  }
  renderRideChip();
  renderLineFilter();
  if (isPremium()) renderHistory();
  if (curPos) render(curPos.lat, curPos.lon);
}

$("lang-btn").addEventListener("click", () => {
  lang = lang === "ja" ? "en" : "ja";
  applyLang();
});

// 表示設定は常時並べず、ヘッダーの一つの操作から必要なときだけ展開する。
const settingsPanel = $("settings-panel");
const settingsButton = $("settings-btn");
const settingsOverlay = $("settings-overlay");
let settingsCloseTimer = null;

function setSettingsOpen(open, returnFocus = false) {
  if (open) {
    if (settingsOverlay.dataset.state === "open") return;
    window.clearTimeout(settingsCloseTimer);
    settingsOverlay.dataset.state = "opening";
    settingsOverlay.classList.remove("hidden", "is-closing");
    settingsButton.setAttribute("aria-expanded", "true");
    document.body.classList.add("sheet-open");
    activateOverlay(settingsOverlay);
    requestAnimationFrame(() => {
      settingsOverlay.dataset.state = "open";
      $("settings-close").focus({ preventScroll: true });
    });
    return;
  }
  if (
    settingsOverlay.classList.contains("hidden") ||
    settingsOverlay.dataset.state === "closing"
  ) return;
  settingsOverlay.dataset.state = "closing";
  settingsOverlay.classList.add("is-closing");
  settingsButton.setAttribute("aria-expanded", "false");
  settingsCloseTimer = window.setTimeout(() => {
    settingsOverlay.classList.add("hidden");
    settingsOverlay.classList.remove("is-closing");
    settingsOverlay.dataset.state = "closed";
    deactivateOverlay(settingsOverlay);
    if (!topOverlay()) document.body.classList.remove("sheet-open");
    if (returnFocus) settingsButton.focus({ preventScroll: true });
  }, motionMs(140));
}

settingsButton.addEventListener("click", () => {
  setSettingsOpen(settingsOverlay.classList.contains("hidden"));
});
$("settings-close").addEventListener("click", () => setSettingsOpen(false, true));
$("settings-scrim").addEventListener("click", () => setSettingsOpen(false, true));

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
let plusPending = false;
let plusStatusMessage = "";

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
  if (plusPending) return;
  setPlusPending(true);
  clearPlusError();
  try {
    const r = await api("/api/checkout", { plan });
    location.href = r.url;
  } catch {
    setPlusError(t("toastCheckoutFail"));
    setPlusPending(false);
  }
}

async function openPortal() {
  const lic = getLicense();
  if (!lic) return;
  if (plusPending) return;
  setPlusPending(true);
  clearPlusError();
  try {
    const r = await api("/api/portal", { token: lic.token });
    location.href = r.url;
  } catch {
    setPlusError(t("toastPortalFail"));
    setPlusPending(false);
  }
}

function setPlusPending(pending) {
  plusPending = pending;
  applyPlanUI();
}

function setPlusError(message) {
  const error = $("plus-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function clearPlusError() {
  setPlusError("");
}

function applyPlanUI() {
  const premium = isPremium();
  const billing = billingEnabled();
  const plusState = plusPending
    ? "pending"
    : billing
      ? (premium ? "active" : "available")
      : (premium ? "demo-active" : "preview");
  const stateCopy = {
    preview: ["plusPreviewTitle", "plusPreviewDetail"],
    "demo-active": ["plusDemoTitle", "plusDemoDetail"],
    available: ["plusAvailableTitle", "plusAvailableDetail"],
    active: ["plusActiveTitle", "plusActiveDetail"],
    pending: [
      billing
        ? (premium ? "plusActiveTitle" : "plusAvailableTitle")
        : (premium ? "plusDemoTitle" : "plusPreviewTitle"),
      "plusPending",
    ],
  };
  const [titleKey, detailKey] = stateCopy[plusState];
  $("paywall").dataset.plusState = plusState;
  $("paywall").querySelector(".modal").setAttribute(
    "aria-busy",
    String(plusPending)
  );
  $("plus-mode-label").textContent = t(titleKey);
  $("plus-status").textContent =
    plusStatusMessage ? t(plusStatusMessage) : t(detailKey);
  $("premium-btn-label").textContent = premium
    ? (billing ? t("premiumMember") : t("plusDemoTitle"))
    : t("premiumBtn");
  $("ad-slot").classList.toggle("hidden", premium);
  $("plus-price").classList.toggle("hidden", !billing || premium);
  $("buy-monthly-btn").classList.toggle("hidden", !billing || premium);
  $("buy-yearly-btn").classList.toggle("hidden", !billing || premium);
  $("purchase-btn").classList.toggle("hidden", billing || premium);
  $("manage-btn").classList.toggle("hidden", !billing || !premium);
  $("restore-btn").classList.toggle("hidden", billing || !premium);
  for (const button of [
    $("buy-monthly-btn"),
    $("buy-yearly-btn"),
    $("purchase-btn"),
    $("manage-btn"),
    $("restore-btn"),
  ]) {
    button.disabled = plusPending;
  }
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
  {
    plusStatusMessage = "";
    clearPlusError();
    applyPlanUI();
    openSheet("paywall", $("paywall-close"), event.currentTarget);
  }
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
  return ["qr", "ic", "paper", "jrpass"].includes(v) ? v : "all";
}

const GUIDE_OPEN_SETTLE_MS = 280;
const GUIDE_ANIMATION_CLEANUP_MS = 1980;
let guideAnimationStartTimer = null;
let guideAnimationTimer = null;
let guideAnimationFrame = null;
let guideAnimationRunId = 0;
let guideReadyAt = 0;

function clearGuideAnimationRun() {
  const body = $("guide-body");
  guideAnimationRunId += 1;
  window.clearTimeout(guideAnimationStartTimer);
  window.clearTimeout(guideAnimationTimer);
  window.cancelAnimationFrame(guideAnimationFrame);
  guideAnimationStartTimer = null;
  guideAnimationTimer = null;
  guideAnimationFrame = null;
  body.querySelectorAll(".scene.guide-animating").forEach((scene) => {
    scene.classList.remove("guide-animating");
  });
}

function stopGuideAnimation() {
  clearGuideAnimationRun();
  guideReadyAt = 0;
}

function playGuideAnimation() {
  clearGuideAnimationRun();
  if (reduceMotionQuery.matches) return;
  const body = $("guide-body");
  const runId = guideAnimationRunId;
  const selected = getTicketType();
  const animationTarget = body.querySelector(
    `.guide-sec[data-sec="${selected === "all" ? "qr" : selected}"] .scene`
  );
  if (!animationTarget) return;
  const begin = () => {
    guideAnimationStartTimer = null;
    if (
      runId !== guideAnimationRunId ||
      reduceMotionQuery.matches ||
      $("guide-modal").classList.contains("hidden") ||
      $("guide-modal").classList.contains("is-closing")
    ) {
      return;
    }
    guideAnimationFrame = window.requestAnimationFrame(() => {
      guideAnimationFrame = null;
      if (runId !== guideAnimationRunId) return;
      animationTarget.classList.add("guide-animating");
      // 1600ms本編 + ICの追加280ms + 100ms余白。
      guideAnimationTimer = window.setTimeout(() => {
        if (runId !== guideAnimationRunId) return;
        animationTarget.classList.remove("guide-animating");
        guideAnimationTimer = null;
      }, GUIDE_ANIMATION_CLEANUP_MS);
    });
  };
  const delay = Math.max(0, guideReadyAt - performance.now());
  if (delay > 0) {
    guideAnimationStartTimer = window.setTimeout(begin, delay);
  } else {
    begin();
  }
}

function renderGuide(animate = false) {
  const sel = getTicketType();
  const buttons = [...document.querySelectorAll("#guide-modal .chip-btn")];
  buttons.forEach((b) => {
    b.classList.toggle("active", b.dataset.ticket === sel);
    b.setAttribute("aria-checked", String(b.dataset.ticket === sel));
    b.tabIndex = b.dataset.ticket === sel ? 0 : -1;
  });
  document.querySelectorAll("#guide-modal .guide-sec").forEach((sec) => {
    const key = sec.dataset.sec;
    const common = key === "common" || key === "common2";
    sec.classList.toggle("hidden", !common && sel !== "all" && key !== sel);
  });
  if ($("guide-status")) {
    const selectedButton = buttons.find((button) => button.dataset.ticket === sel);
    $("guide-status").textContent =
      selectedButton?.textContent.trim() || t("ticketAll");
  }
  if (animate) playGuideAnimation();
}

$("guide-btn").addEventListener("click", (event) => {
  renderGuide(false);
  openSheet("guide-modal", $("guide-close"), event.currentTarget);
  guideReadyAt = performance.now() + motionMs(GUIDE_OPEN_SETTLE_MS);
  playGuideAnimation();
});
$("guide-close").addEventListener("click", () => closeSheet("guide-modal"));
const guideTicketButtons = [...document.querySelectorAll(
  "#guide-modal .chip-btn"
)];
guideTicketButtons.forEach((b) => {
  b.addEventListener("click", () => {
    if (b.dataset.ticket === getTicketType()) return;
    if (b.dataset.ticket === "all") {
      localStorage.removeItem("ticketType");
    } else {
      localStorage.setItem("ticketType", b.dataset.ticket);
    }
    renderGuide(true);
  });
  b.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const current = guideTicketButtons.indexOf(event.currentTarget);
    let next = current;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (current - 1 + guideTicketButtons.length) % guideTicketButtons.length;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (current + 1) % guideTicketButtons.length;
    }
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = guideTicketButtons.length - 1;
    guideTicketButtons[next].click();
    guideTicketButtons[next].focus();
  });
});
$("buy-monthly-btn").addEventListener("click", () => startCheckout("monthly"));
$("buy-yearly-btn").addEventListener("click", () => startCheckout("yearly"));
$("manage-btn").addEventListener("click", openPortal);
$("purchase-btn").addEventListener("click", () => {
  if (plusPending) return;
  setPlusPending(true);
  clearPlusError();
  window.setTimeout(() => {
    setPlan("premium");
    plusStatusMessage = "plusDemoEnabled";
    setPlusPending(false);
  }, motionMs(160));
});
$("restore-btn").addEventListener("click", () => {
  if (plusPending) return;
  setPlusPending(true);
  clearPlusError();
  window.setTimeout(() => {
    setPlan("free");
    plusStatusMessage = "plusDemoEnded";
    setPlusPending(false);
  }, motionMs(160));
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
  startScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
  applyPlanUI();
  requestAnimationFrame(() => {
    document.querySelector(".station-display")?.focus?.({ preventScroll: true });
  });
  startLocationWatch();
});

$("gps-retry-btn").addEventListener("click", startLocationWatch);

function startLocationWatch() {
  if (geoWatchId !== null && "geolocation" in navigator) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  if (!("geolocation" in navigator)) {
    setGpsState("unavailable", t("geoUnsupported"));
    return;
  }
  setGpsState("requesting");
  geoWatchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  });
}

function setGpsState(state, detail = "") {
  const previous = geoState;
  geoState = state;
  const stateEl = $("gps-state");
  const detailEl = $("gps-state-detail");
  const retry = $("gps-retry-btn");
  const settingsHint = $("gps-settings-hint");
  stateEl.dataset.state = state;
  const isSuccess = state === "success";
  const isRequesting = state === "requesting";
  const isDenied = state === "permission-denied";
  const labelKeys = {
    requesting: "gpsWait",
    success: "gpsReady",
    "permission-denied": "gpsDenied",
    timeout: "gpsTimedOut",
    unavailable: "gpsUnavailable",
  };
  const lowAccuracy =
    isSuccess &&
    Number.isFinite(lastGpsAccuracy) &&
    lastGpsAccuracy > ACCURACY_WARN_M;
  gpsStatus.textContent =
    isSuccess && Number.isFinite(lastGpsAccuracy)
      ? t(lowAccuracy ? "gpsAccLow" : "gpsAcc", Math.round(lastGpsAccuracy))
      : t(labelKeys[state] || "gpsUnavailable");
  gpsStatus.classList.toggle("ok", isSuccess && !lowAccuracy);
  gpsStatus.classList.toggle(
    "warn",
    lowAccuracy || (!isSuccess && !isRequesting)
  );
  detailEl.textContent =
    detail ||
    (isRequesting
      ? t("gpsRequestingDetail")
      : isDenied
        ? t("geo1")
        : state === "timeout"
          ? t("geo3")
          : state === "unavailable"
            ? t("geo2")
            : "");
  stateEl.classList.toggle("is-compact", isSuccess);
  detailEl.classList.toggle("hidden", isSuccess);
  retry.classList.toggle("hidden", isSuccess || isRequesting || isDenied);
  settingsHint.classList.toggle("hidden", !isDenied);
  if (!isSuccess && !isRequesting && !curPos) {
    stationName.textContent = gpsStatus.textContent;
    stationName.classList.add("is-state-message");
    stationKana.textContent = "";
  }
  if (isRequesting && !curPos) {
    stationName.textContent = "---";
    stationName.classList.remove("is-state-message");
  }
  if (isSuccess) stationName.classList.remove("is-state-message");
  if (previous !== state) {
    $("screen-live").textContent = isSuccess
      ? t("gpsReady")
      : `${gpsStatus.textContent}. ${detailEl.textContent}`;
  }
}

$("wakelock-btn").addEventListener("click", toggleWakeLock);
$("alert-cancel-btn").addEventListener("click", cancelAlert);
$("alert-dismiss-btn").addEventListener("click", dismissArrivalAlert);
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
  lastGpsAccuracy = accuracy;
  syncDestMapPosition();
  // 誤差半径が大きい測位 (Wi-Fi/基地局による概算など) は駅を取り違えることがあるため、
  // 「参考程度」と明示する。位置自体はそのまま使う (無視すると更新が止まって見えるため)
  setGpsState("success");

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
  const state = err.code === 1
    ? "permission-denied"
    : err.code === 3
      ? "timeout"
      : "unavailable";
  setGpsState(state, messages[err.code] || t("geoFail"));
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
  $("screen-live").textContent = t("fetching");
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
  const displayName = dispName(nearest);
  stationName.textContent = displayName;
  stationName.classList.remove("is-state-message");
  stationName.classList.toggle(
    "is-long",
    displayName.length > (lang === "en" ? 14 : 7)
  );
  stationKana.textContent = dispSub(nearest);
  distanceEl.textContent = atStation ? "" : t("about", formatDistance(nearest.dist));
  renderLineChips(nearest);

  // 車内モード側にも同じ内容を反映
  $("r-status").textContent = statusLabel.textContent;
  $("r-status").classList.toggle("at-station", atStation);
  $("r-station").textContent = displayName;
  $("r-station").classList.toggle(
    "is-long",
    displayName.length > (lang === "en" ? 14 : 7)
  );
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
  const line = (s.lines || [])[0] || "";
  li.style.setProperty("--route-color", line ? lineColor(line) : "var(--accent)");

  const rail = document.createElement("span");
  rail.className = "nearby-route-rail";
  rail.setAttribute("aria-hidden", "true");

  const copy = document.createElement("span");
  copy.className = "nearby-copy";
  const name = document.createElement("span");
  name.className = "nearby-name";
  name.textContent = dispName(s);
  const sub = document.createElement("span");
  sub.className = "nearby-sub";
  sub.textContent = [dispSub(s), line].filter(Boolean).join(" · ");
  copy.append(name, sub);

  const right = document.createElement("span");
  right.className = "item-right";
  const direction = document.createElement("span");
  direction.className = "nearby-direction";
  direction.setAttribute("aria-hidden", "true");
  if (curPos) {
    direction.style.setProperty(
      "--bearing",
      `${Math.round(bearing(curPos.lat, curPos.lon, s.lat, s.lon))}deg`
    );
  }
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
  right.append(direction, dist, bell);
  li.append(rail, copy, right);
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
  alertStation = normalizeDestination(station);
  pendingDestination = { ...alertStation };
  $("alert-status-text").textContent = t("alertSet", dispName(alertStation));
  $("alert-status").classList.remove("hidden");
  $("r-alert").textContent = t("alertSet", dispName(alertStation));
  updateDestinationAction();
  renderPendingDestination();
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
  pendingDestination = null;
  $("alert-status").classList.add("hidden");
  $("r-alert").textContent = "";
  updateDestinationAction();
  renderPendingDestination();
  if (isDestMapVisible()) renderDestMap();
}

// =====================================================================
// 目的地ピッカー (プレミアム): 駅名・ひらがな検索で降車アラートを設定
// =====================================================================
const DEST_IDLE_MAX = 8;
const RESULT_BATCH_SIZE = 20;
const DEST_SEARCH_CAP = 200;
let destVisibleLimit = RESULT_BATCH_SIZE;
let lineVisibleLimit = RESULT_BATCH_SIZE;

$("dest-btn").addEventListener("click", (event) => {
  if (!requirePremium(event.currentTarget)) return;
  $("dest-search").value = "";
  $("dest-clear").classList.toggle("hidden", !alertStation);
  pendingDestination = alertStation ? { ...alertStation } : null;
  destVisibleLimit = RESULT_BATCH_SIZE;
  lineVisibleLimit = RESULT_BATCH_SIZE;
  renderPendingDestination();
  renderDestList("");
  const mapTarget = curPos || alertStation || loadRecentDests()[0] || null;
  const initialView = "map";
  initializeDestMapCenter(mapTarget);
  showDestView(initialView);
  openSheet(
    "dest-modal",
    initialView === "search" ? $("dest-search") : $("dest-tab-map"),
    event.currentTarget
  );
});
$("dest-close").addEventListener("click", closeDestModal);
$("dest-clear").addEventListener("click", () => {
  cancelAlert();
  closeDestModal();
});
$("dest-search").addEventListener("input", (e) =>
  onDestSearchInput(e.target.value.trim())
);
$("dest-more").addEventListener("click", () => {
  destVisibleLimit += RESULT_BATCH_SIZE;
  renderDestList($("dest-search").value.trim(), true);
});
$("dest-search-reset").addEventListener("click", () => {
  $("dest-search").value = "";
  onDestSearchInput("");
  $("dest-search").focus();
});
$("dest-confirm").addEventListener("click", async (event) => {
  if (!pendingDestination) return;
  await setAlert(pendingDestination, event.currentTarget);
  closeDestModal();
});

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
  const seq = ++jpSearchSeq;
  destVisibleLimit = RESULT_BATCH_SIZE;
  jpResults = [];
  $("dest-list").setAttribute("aria-busy", String(query.length >= 2));
  renderDestList(query); // まず内蔵データで即時表示
  if (query.length < 2) {
    $("dest-list").setAttribute("aria-busy", "false");
    return;
  }
  $("dest-search-status").textContent = t("searchLoading");
  loadJpIndex().then((idx) => searchJp(query, idx, seq));
}

function searchJp(query, idx, seq) {
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
      if (hits.length >= DEST_SEARCH_CAP) break;
    }
  }
  if (seq !== jpSearchSeq) return; // より新しい入力が来ていたら破棄
  jpResults = hits;
  $("dest-list").setAttribute("aria-busy", "false");
  renderDestList(query);
}

// 検索対象 = 埋め込み全駅 + 取得済みの周辺駅 (同名はマージ)
function destCandidates() {
  const seen = new Map();
  for (const s of [...EMBEDDED_STATIONS, ...stations]) {
    const key = mapStationKey(s);
    const exist = seen.get(key);
    if (!exist) {
      seen.set(key, s);
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

function renderDestList(query, fromMore = false) {
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
    const recentKeys = new Set(recents.map(mapStationKey));
    const listAnchor = curPos || {
      lat: destMapState.centerLat,
      lon: destMapState.centerLon,
    };
    const nearby = hits
      .filter((s) => !recentKeys.has(mapStationKey(s)))
      .sort(
        (a, b) =>
          haversine(listAnchor.lat, listAnchor.lon, a.lat, a.lon) -
          haversine(listAnchor.lat, listAnchor.lon, b.lat, b.lon)
      );
    items = [
      ...recents,
      ...nearby,
    ];
  } else {
    // 内蔵に無い駅は全国データで補完し、完全一致→前方一致→部分一致の順に並べる
    const localKeys = new Set(hits.map(mapStationKey));
    const jpExtra = jpResults.filter((s) => !localKeys.has(mapStationKey(s)));
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
      });
  }

  const total = items.length;
  const visibleItems = items.slice(
    0,
    query ? destVisibleLimit : DEST_IDLE_MAX
  );
  const fragment = document.createDocumentFragment();
  for (const s of visibleItems) {
    const li = document.createElement("li");
    li.className = "dest-item";
    const name = document.createElement("span");
    if (s.recent) name.appendChild(icon("clock", "ic-sm"));
    else if (s.source === "jp") name.appendChild(icon("globe", "ic-sm"));
    name.appendChild(document.createTextNode(dispName(s)));
    const line = document.createElement("span");
    line.className = "dist";
    const meta = [];
    if (s.lines?.[0]) meta.push(s.lines[0]);
    if (curPos) {
      meta.push(
        formatDistance(haversine(curPos.lat, curPos.lon, s.lat, s.lon))
      );
    }
    line.textContent = meta.join(" · ");
    li.append(name, line);
    makeKeyboardAction(li, () => {
      selectPendingDestination(s, { source: "search", focus: li });
    });
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);

  const status = $("dest-search-status");
  const reset = $("dest-search-reset");
  const more = $("dest-more");
  reset.classList.toggle("hidden", !query);
  if (!query) {
    status.textContent = t("searchIdle");
  } else if (total === 0 && listEl.getAttribute("aria-busy") !== "true") {
    status.textContent = t("searchEmpty", query);
  } else if (listEl.getAttribute("aria-busy") !== "true") {
    status.textContent = t("resultsCount", visibleItems.length, total);
  }
  const hasMore = Boolean(query && visibleItems.length < total);
  if (fromMore && !hasMore && document.activeElement === more) {
    status.tabIndex = -1;
    status.focus({ preventScroll: true });
  }
  more.classList.toggle("hidden", !hasMore);

  // 全国データ由来の結果を表示しているときは目印を説明
  const credit = $("dest-credit");
  if (credit) {
    const usingJp = visibleItems.some((s) => s.source === "jp");
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

let currentDestView = "map";
let destLineReturnFocus = null;
const DEST_TABS = [
  { name: "map", tabId: "dest-tab-map", panelId: "dest-map-view" },
  { name: "search", tabId: "dest-tab-search", panelId: "dest-search-view" },
  { name: "lines", tabId: "dest-tab-lines", panelId: "dest-lines-view" },
];

function showDestView(view, focusTab = false) {
  currentDestView = view;
  if (view !== "map") {
    destMapKeyboardMode = false;
    destMapFocusedKey = "";
    $("dest-map-svg").tabIndex = 0;
  }
  const activeTab = view === "stations" ? "lines" : view;
  const panelIds = [
    "dest-map-view",
    "dest-search-view",
    "dest-lines-view",
    "dest-stations-view",
  ];
  for (const id of panelIds) {
    $(id).classList.toggle("hidden", id !== `dest-${view}-view`);
  }
  for (const item of DEST_TABS) {
    const selected = item.name === activeTab;
    const tab = $(item.tabId);
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    if (item.name === "lines") {
      tab.setAttribute(
        "aria-controls",
        view === "stations" ? "dest-stations-view" : "dest-lines-view"
      );
    }
    tab.tabIndex = selected ? 0 : -1;
  }
  $("dest-modal").querySelector(".modal").scrollTop = 0;
  if (view === "map") {
    initializeDestMapCenter();
    requestAnimationFrame(renderDestMap);
    loadDestMapStations();
  }
  if (focusTab) {
    const target = DEST_TABS.find((item) => item.name === activeTab);
    if (target) $(target.tabId).focus();
  }
}

$("dest-tab-map").addEventListener("click", () => showDestView("map"));
$("dest-tab-search").addEventListener("click", () => showDestView("search"));
$("dest-tab-lines").addEventListener("click", () => {
  renderLineList($("line-search").value.trim());
  showDestView("lines");
});
for (const item of DEST_TABS) {
  $(item.tabId).addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = DEST_TABS.findIndex(({ tabId }) => tabId === event.currentTarget.id);
    let next = current;
    if (event.key === "ArrowLeft") next = (current - 1 + DEST_TABS.length) % DEST_TABS.length;
    if (event.key === "ArrowRight") next = (current + 1) % DEST_TABS.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = DEST_TABS.length - 1;
    const target = DEST_TABS[next];
    if (target.name === "lines") renderLineList($("line-search").value.trim());
    showDestView(target.name, true);
  });
}
$("line-search").addEventListener("input", (e) => {
  lineVisibleLimit = RESULT_BATCH_SIZE;
  renderLineList(e.target.value.trim());
});
$("line-more").addEventListener("click", () => {
  lineVisibleLimit += RESULT_BATCH_SIZE;
  renderLineList($("line-search").value.trim(), true);
});
$("line-search-reset").addEventListener("click", () => {
  $("line-search").value = "";
  lineVisibleLimit = RESULT_BATCH_SIZE;
  renderLineList("");
  $("line-search").focus();
});
$("dest-back").addEventListener("click", () => {
  showDestView("lines");
  requestAnimationFrame(() => {
    const target = destLineReturnFocus?.isConnected
      ? destLineReturnFocus
      : $("dest-tab-lines");
    target?.focus({ preventScroll: true });
  });
});

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

function renderLineList(query = "", fromMore = false) {
  const listEl = $("line-list");
  listEl.innerHTML = "";
  const index = getLineIndex();
  const matches = [...index.keys()]
    .sort()
    .filter((name) => lineMatches(name, index.get(name), query));
  const visible = matches.slice(0, lineVisibleLimit);
  const fragment = document.createDocumentFragment();
  for (const name of visible) {
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
    makeKeyboardAction(li, () => {
      destLineReturnFocus = li;
      renderRouteList(name);
    });
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);
  const status = $("line-search-status");
  const reset = $("line-search-reset");
  const more = $("line-more");
  reset.classList.toggle("hidden", !query);
  status.textContent = matches.length
    ? t("resultsCount", visible.length, matches.length)
    : t("lineEmpty", query);
  const hasMore = visible.length < matches.length;
  if (fromMore && !hasMore && document.activeElement === more) {
    status.tabIndex = -1;
    status.focus({ preventScroll: true });
  }
  more.classList.toggle("hidden", !hasMore);
}

function renderRouteList(lineName) {
  const color = lineColor(lineName);
  $("dest-line-title").textContent = lineName;
  $("dest-line-title").style.borderLeftColor = color;
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
      selectPendingDestination(s, { source: "lines", focus: li });
    });
    listEl.appendChild(li);
  }
  showDestView("stations");
  requestAnimationFrame(() => $("dest-back").focus({ preventScroll: true }));
}

// =====================================================================
// 目的地の仮選択と、端末内データだけで描く駅地図
// =====================================================================
const SVG_NS = "http://www.w3.org/2000/svg";
const DEST_MAP_SIZE = 1000;
const DEST_MAP_WORLD_VIEW_PX = 440;
const DEST_MAP_MIN_ZOOM = 9;
const DEST_MAP_MAX_ZOOM = 15;
const DEST_MAP_STATION_ZOOM = 9.8;
const DEST_MAP_MARKER_MAX = 36;
const DEST_MAP_LINE_MAX = 12;
const DEST_MAP_FALLBACK = { lat: 35.68139, lon: 139.7661 };

let destMapNationwide = [];
let destMapLoadStarted = false;
let destMapLineGeometry = null;
let destMapPointer = null;
let destMapKeyboardMode = false;
let destMapFocusedKey = "";
let destMapWheelTimer = null;
let destMapWheelDirection = 0;
let destMapWheelAnchor = { x: 500, y: 500 };
const destMapState = {
  centerLat: DEST_MAP_FALLBACK.lat,
  centerLon: DEST_MAP_FALLBACK.lon,
  zoom: 12,
  initialized: false,
  userMoved: false,
  loading: false,
};

function isDestMapVisible() {
  const modal = $("dest-modal");
  const panel = $("dest-map-view");
  return Boolean(
    modal &&
      panel &&
      !modal.classList.contains("hidden") &&
      !modal.classList.contains("is-closing") &&
      !panel.classList.contains("hidden")
  );
}

function normalizeDestination(station) {
  return {
    name: station?.name || "",
    kana: station?.kana || station?.k || station?.nameKana || "",
    romaji: station?.romaji || station?.r || "",
    lat: Number(station?.lat),
    lon: Number(station?.lon ?? station?.lng),
    lines: [...(station?.lines || [])],
    ...(station?.source ? { source: station.source } : {}),
  };
}

function sameDestination(a, b) {
  return Boolean(
    a &&
      b &&
      a.name === b.name &&
      Math.abs(a.lat - b.lat) < 0.00001 &&
      Math.abs(a.lon - b.lon) < 0.00001
  );
}

function selectPendingDestination(station, { source = "", focus = false } = {}) {
  const normalized = normalizeDestination(station);
  if (
    !normalized.name ||
    !Number.isFinite(normalized.lat) ||
    !Number.isFinite(normalized.lon)
  ) {
    return;
  }
  pendingDestination = normalized;
  if (source) {
    $("dest-selection-live").textContent = t(
      "destProvisionalSelected",
      dispName(normalized)
    );
  }
  if (source) destMapState.userMoved = true;
  if (source && source !== "map") {
    destMapState.centerLat = normalized.lat;
    destMapState.centerLon = normalized.lon;
    destMapState.zoom = Math.max(destMapState.zoom, 12);
    destMapState.initialized = true;
  }
  renderPendingDestination(source);
  if (isDestMapVisible()) renderDestMap();
  if (focus) {
    const target = focus?.focus ? focus : $("dest-confirm");
    requestAnimationFrame(() => target?.focus({ preventScroll: false }));
  }
}

function renderPendingDestination(source = "") {
  const tray = $("dest-selection");
  if (!tray) return;
  const hasSelection = Boolean(pendingDestination);
  tray.classList.toggle("hidden", !hasSelection);
  $("dest-confirm").disabled = !hasSelection;
  if (!hasSelection) {
    $("dest-selection-name").textContent = "";
    $("dest-selection-sub").textContent = "";
    $("dest-selection-meta").textContent = "";
    tray.removeAttribute("aria-label");
    delete tray.dataset.source;
    return;
  }

  const name = dispName(pendingDestination);
  const sub = dispSub(pendingDestination);
  const meta = [];
  if (pendingDestination.lines?.length) {
    meta.push(pendingDestination.lines.slice(0, 2).join(" / "));
  }
  if (curPos) {
    const distance = haversine(
      curPos.lat,
      curPos.lon,
      pendingDestination.lat,
      pendingDestination.lon
    );
    meta.push(t("destDistance", formatDistance(distance)));
  }
  $("dest-selection-name").textContent = name;
  $("dest-selection-sub").textContent = sub;
  $("dest-selection-sub").classList.toggle("hidden", !sub);
  $("dest-selection-meta").textContent = meta.join(" · ");
  const selectionLabel = tray.querySelector(".selection-label");
  if (selectionLabel) {
    selectionLabel.textContent = t(
      sameDestination(pendingDestination, alertStation)
        ? "currentSelection"
        : "provisionalSelection"
    );
  }
  tray.setAttribute("aria-label", t("destSelected", name));
  if (source) tray.dataset.source = source;
}

function updateDestinationI18n() {
  const close = $("dest-close");
  if (close) {
    close.title = t("close");
    close.setAttribute("aria-label", t("close"));
  }
  const locateLabel = $("dest-map-locate")?.querySelector("span");
  if (locateLabel) locateLabel.textContent = t("mapCurrent");
  const zoomIn = $("dest-map-zoom-in");
  const zoomOut = $("dest-map-zoom-out");
  zoomIn?.setAttribute("aria-label", t("mapZoomIn"));
  zoomOut?.setAttribute("aria-label", t("mapZoomOut"));
  const zoomInText = zoomIn?.querySelector(".sr-only");
  const zoomOutText = zoomOut?.querySelector(".sr-only");
  if (zoomInText) zoomInText.textContent = t("mapZoomIn");
  if (zoomOutText) zoomOutText.textContent = t("mapZoomOut");
  const hint = $("dest-map-hint");
  if (hint) hint.textContent = t("mapHint");
  const status = $("dest-map-status");
  if (status) {
    // パンやズームごとの件数更新をスクリーンリーダーへ連続通知しない。
    status.removeAttribute("role");
    status.removeAttribute("aria-live");
  }
  const svg = $("dest-map-svg");
  if (svg) {
    svg.setAttribute("role", "region");
    svg.setAttribute("aria-label", t("mapRegionLabel"));
    svg.removeAttribute("aria-labelledby");
  }
  if ($("dest-confirm")) $("dest-confirm").textContent = t("destConfirm");
}

function setDestMapStatus(text) {
  const status = $("dest-map-status");
  if (status) status.textContent = text;
}

function initializeDestMapCenter(target = null, force = false) {
  if (destMapState.initialized && !target && !force) return;
  const recent = loadRecentDests()[0];
  const center = target || curPos || alertStation || recent || DEST_MAP_FALLBACK;
  const lat = Number(center.lat);
  const lon = Number(center.lon ?? center.lng);
  destMapState.centerLat = Number.isFinite(lat) ? lat : DEST_MAP_FALLBACK.lat;
  destMapState.centerLon = Number.isFinite(lon) ? lon : DEST_MAP_FALLBACK.lon;
  destMapState.zoom = curPos && center === curPos ? 13 : 12;
  destMapState.initialized = true;
  destMapState.userMoved = false;
}

function syncDestMapPosition() {
  if (!curPos || !isDestMapVisible()) return;
  if (!destMapState.initialized) initializeDestMapCenter(curPos);
  if (currentDestView === "map" && !destMapState.userMoved) {
    destMapState.centerLat = curPos.lat;
    destMapState.centerLon = curPos.lon;
    destMapState.zoom = Math.max(destMapState.zoom, 13);
    renderDestMap();
  }
}

async function loadDestMapStations() {
  if (destMapLoadStarted) return;
  destMapLoadStarted = true;
  destMapState.loading = true;
  setDestMapStatus(t("mapLoading"));
  const index = await loadJpIndex();
  destMapNationwide = index
    .map((station) => normalizeDestination({ ...station, source: "jp" }))
    .filter(
      (station) =>
        station.name &&
        Number.isFinite(station.lat) &&
        Number.isFinite(station.lon)
    );
  destMapState.loading = false;
  if (isDestMapVisible()) renderDestMap();
}

function mercatorPoint(lat, lon, zoom) {
  const clippedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const scale = 256 * 2 ** zoom;
  const sin = Math.sin((clippedLat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y:
      (0.5 -
        Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) *
      scale,
  };
}

function mercatorLatLon(x, y, zoom) {
  const scale = 256 * 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return {
    lat: Math.max(-85.05112878, Math.min(85.05112878, lat)),
    lon: ((lon + 540) % 360) - 180,
  };
}

function projectDestMap(lat, lon) {
  const center = mercatorPoint(
    destMapState.centerLat,
    destMapState.centerLon,
    destMapState.zoom
  );
  const point = mercatorPoint(lat, lon, destMapState.zoom);
  const scale = DEST_MAP_SIZE / DEST_MAP_WORLD_VIEW_PX;
  return {
    x: DEST_MAP_SIZE / 2 + (point.x - center.x) * scale,
    y: DEST_MAP_SIZE / 2 + (point.y - center.y) * scale,
  };
}

function getDestMapBounds(padding = 0.08) {
  const center = mercatorPoint(
    destMapState.centerLat,
    destMapState.centerLon,
    destMapState.zoom
  );
  const half = DEST_MAP_WORLD_VIEW_PX * (0.5 + padding);
  const northWest = mercatorLatLon(
    center.x - half,
    center.y - half,
    destMapState.zoom
  );
  const southEast = mercatorLatLon(
    center.x + half,
    center.y + half,
    destMapState.zoom
  );
  return {
    minLat: Math.min(northWest.lat, southEast.lat),
    maxLat: Math.max(northWest.lat, southEast.lat),
    minLon: northWest.lon,
    maxLon: southEast.lon,
  };
}

function stationWithinMapBounds(station, bounds) {
  if (station.lat < bounds.minLat || station.lat > bounds.maxLat) return false;
  return bounds.minLon <= bounds.maxLon
    ? station.lon >= bounds.minLon && station.lon <= bounds.maxLon
    : station.lon >= bounds.minLon || station.lon <= bounds.maxLon;
}

function createMapSvgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function mapStationKey(station) {
  const lat = Number(station?.lat);
  const lon = Number(station?.lon ?? station?.lng);
  return `${station?.name || ""}|${
    Number.isFinite(lat) ? lat.toFixed(5) : ""
  }|${Number.isFinite(lon) ? lon.toFixed(5) : ""}`;
}

let destMapCandidateCache = {
  stationsRef: null,
  nationwideRef: null,
  value: [],
};

function destinationMapCandidates() {
  if (
    destMapCandidateCache.stationsRef === stations &&
    destMapCandidateCache.nationwideRef === destMapNationwide
  ) {
    return destMapCandidateCache.value;
  }
  const unique = new Map();
  const candidates = [
    ...destCandidates().map(normalizeDestination),
    ...destMapNationwide,
  ];
  for (const station of candidates) {
    if (
      !station.name ||
      !Number.isFinite(station.lat) ||
      !Number.isFinite(station.lon)
    ) {
      continue;
    }
    // 同名駅は全国に複数あるため、位置まで含めて別の駅として残す。
    const key = mapStationKey(station);
    const existing = unique.get(key);
    if (!existing || (!existing.lines.length && station.lines.length)) {
      unique.set(key, station);
    }
  }
  const value = [...unique.values()];
  destMapCandidateCache = {
    stationsRef: stations,
    nationwideRef: destMapNationwide,
    value,
  };
  return value;
}

function getDestMapLineGeometry() {
  if (destMapLineGeometry) return destMapLineGeometry;
  destMapLineGeometry = [];
  for (const lineName of Object.keys(window.LINE_ORDER || {})) {
    const members = orderedStations(lineName);
    if (members.length < 2) continue;
    destMapLineGeometry.push({ name: lineName, stations: members });
  }
  return destMapLineGeometry;
}

function renderDestMapLines(content) {
  const bounds = getDestMapBounds();
  const visibleLines = [];
  for (const line of getDestMapLineGeometry()) {
    const visibleStations = line.stations.filter((station) =>
      stationWithinMapBounds(station, bounds)
    );
    if (visibleStations.length < 2) continue;
    const nearest = visibleStations.reduce(
      (min, station) =>
        Math.min(
          min,
          haversine(
            destMapState.centerLat,
            destMapState.centerLon,
            station.lat,
            station.lon
          )
        ),
      Infinity
    );
    visibleLines.push({
      ...line,
      score: visibleStations.length * 1000000 - nearest,
    });
  }
  visibleLines
    .sort((a, b) => b.score - a.score)
    .slice(0, DEST_MAP_LINE_MAX)
    .forEach((line) => {
      const points = line.stations.map((station) =>
        projectDestMap(station.lat, station.lon)
      );
      const path = createMapSvgElement("polyline", {
        class: "dest-map-line",
        points: points
          .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
          .join(" "),
        fill: "none",
        stroke: lineColor(line.name),
        "vector-effect": "non-scaling-stroke",
        "aria-hidden": "true",
      });
      content.appendChild(path);
    });
}

function mapMarkerAriaLabel(station) {
  const parts = [dispName(station)];
  if (station.lines?.length) parts.push(station.lines.slice(0, 2).join(", "));
  if (curPos) {
    parts.push(
      t(
        "destDistance",
        formatDistance(haversine(curPos.lat, curPos.lon, station.lat, station.lon))
      )
    );
  }
  return parts.join(". ");
}

function renderDestMapStation(
  content,
  item,
  showLabel,
  isTabStop,
  mapOrder
) {
  const { station, point } = item;
  const selected = sameDestination(station, pendingDestination);
  const group = createMapSvgElement("g", {
    class: `dest-map-node${selected ? " is-selected" : ""}`,
    transform: `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`,
    role: "button",
    tabindex: isTabStop ? "0" : "-1",
    "aria-pressed": String(selected),
    "aria-label": mapMarkerAriaLabel(station),
  });
  group.dataset.stationKey = mapStationKey(station);
  group.dataset.mapOrder = String(mapOrder);
  group.dataset.mapX = String(point.x);
  group.dataset.mapY = String(point.y);
  group.appendChild(
    createMapSvgElement("circle", {
      class: "dest-map-hit",
      r: 82,
      fill: "transparent",
    })
  );
  group.appendChild(
    createMapSvgElement("circle", {
      class: "dest-map-dot",
      r: selected ? 15 : 8,
    })
  );
  if (showLabel) {
    const label = createMapSvgElement("text", {
      class: "dest-map-label",
      x: 0,
      y: -25,
      "text-anchor": "middle",
      "aria-hidden": "true",
    });
    label.textContent = dispName(station);
    group.appendChild(label);
  }
  group.addEventListener("click", (event) => {
    event.stopPropagation();
    selectPendingDestination(station, { source: "map" });
  });
  group.addEventListener("focus", () => {
    // フォーカス中の駅をGPS更新で作り直さないよう、自動追従を止める。
    destMapState.userMoved = true;
    destMapFocusedKey = group.dataset.stationKey;
  });
  group.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      exitDestMapMarkerMode();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      destMapFocusedKey = group.dataset.stationKey;
      selectPendingDestination(station, { source: "map" });
      return;
    }
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    const nodes = [...content.querySelectorAll(".dest-map-node")].sort(
      (a, b) => Number(a.dataset.mapOrder) - Number(b.dataset.mapOrder)
    );
    let nextNode = null;
    if (event.key === "Home") nextNode = nodes[0];
    else if (event.key === "End") nextNode = nodes.at(-1);
    else nextNode = mapNodeInDirection(group, nodes, event.key);
    if (!nextNode) return;
    nodes.forEach((node) => {
      node.tabIndex = node === nextNode ? 0 : -1;
    });
    destMapFocusedKey = nextNode.dataset.stationKey;
    nextNode.focus({ preventScroll: true });
  });
  content.appendChild(group);
}

function mapNodeInDirection(current, nodes, key) {
  const x = Number(current.dataset.mapX);
  const y = Number(current.dataset.mapY);
  const direction = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }[key];
  if (!direction) return null;
  let best = null;
  let bestScore = Infinity;
  for (const node of nodes) {
    if (node === current) continue;
    const dx = Number(node.dataset.mapX) - x;
    const dy = Number(node.dataset.mapY) - y;
    const forward = dx * direction[0] + dy * direction[1];
    if (forward <= 1) continue;
    const sideways = Math.abs(dx * direction[1] - dy * direction[0]);
    const score = Math.hypot(dx, dy) + sideways * 1.4;
    if (score < bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

function exitDestMapMarkerMode() {
  destMapKeyboardMode = false;
  destMapFocusedKey = "";
  const svg = $("dest-map-svg");
  svg.tabIndex = 0;
  svg.querySelectorAll(".dest-map-node").forEach((node) => {
    node.tabIndex = -1;
  });
  svg.focus({ preventScroll: true });
}

function renderDestMapCurrentPosition(content) {
  if (!curPos) return;
  const point = projectDestMap(curPos.lat, curPos.lon);
  if (point.x < -80 || point.x > 1080 || point.y < -80 || point.y > 1080) return;
  const marker = createMapSvgElement("g", {
    class: "dest-map-current",
    transform: `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`,
    "aria-hidden": "true",
  });
  marker.append(
    createMapSvgElement("circle", { class: "dest-map-current-ring", r: 25 }),
    createMapSvgElement("circle", { class: "dest-map-current-dot", r: 9 })
  );
  content.appendChild(marker);
}

function renderDestMap() {
  const content = $("dest-map-content");
  if (!content || !destMapState.initialized) return;
  const mapSvg = $("dest-map-svg");
  mapSvg.tabIndex = destMapKeyboardMode ? -1 : 0;
  const focusedStationKey = document.activeElement?.classList?.contains(
    "dest-map-node"
  )
    ? document.activeElement.dataset.stationKey
    : "";
  const preferredFocusKey = focusedStationKey || destMapFocusedKey;
  content.removeAttribute("transform");
  content.replaceChildren();

  const ground = createMapSvgElement("rect", {
    class: "dest-map-ground",
    x: 0,
    y: 0,
    width: DEST_MAP_SIZE,
    height: DEST_MAP_SIZE,
    "aria-hidden": "true",
  });
  content.appendChild(ground);
  renderDestMapLines(content);

  if (destMapState.zoom < DEST_MAP_STATION_ZOOM) {
    destMapKeyboardMode = false;
    destMapFocusedKey = "";
    mapSvg.tabIndex = 0;
    setDestMapStatus(t("mapZoomMore"));
    if ($("dest-map-hint")) $("dest-map-hint").textContent = t("mapZoomMore");
    renderDestMapCurrentPosition(content);
    return;
  }

  const bounds = getDestMapBounds();
  const projected = destinationMapCandidates()
    .filter((station) => stationWithinMapBounds(station, bounds))
    .map((station) => ({
      station,
      point: projectDestMap(station.lat, station.lon),
      distance: haversine(
        destMapState.centerLat,
        destMapState.centerLon,
        station.lat,
        station.lon
      ),
    }))
    .filter(
      ({ point }) =>
        point.x >= -70 && point.x <= 1070 && point.y >= -70 && point.y <= 1070
    )
    .sort((a, b) => a.distance - b.distance);

  const markerLimit =
    window.innerWidth <= 370 ? 28 : DEST_MAP_MARKER_MAX;
  let visible = projected.slice(0, markerLimit);
  const selectedItem = projected.find(({ station }) =>
    sameDestination(station, pendingDestination)
  );
  if (
    selectedItem &&
    !visible.some(({ station }) => sameDestination(station, selectedItem.station))
  ) {
    visible = [...visible.slice(0, markerLimit - 1), selectedItem];
  }
  if (visible.length === 0 && destMapKeyboardMode) {
    destMapKeyboardMode = false;
    destMapFocusedKey = "";
    mapSvg.tabIndex = 0;
  }
  // 小さい画面でも駅名が重ならないよう、低ズームでは中心付近だけを表示する。
  const labelCount =
    destMapState.zoom >= 15
      ? 8
      : destMapState.zoom >= 14
        ? 6
        : destMapState.zoom >= 13
          ? 4
          : 1;
  const labelled = new Set(
    (selectedItem ? [] : visible.slice(0, labelCount)).map(({ station }) =>
      mapStationKey(station)
    )
  );
  if (selectedItem) labelled.add(mapStationKey(selectedItem.station));
  const visibleKeys = new Set(
    visible.map(({ station }) => mapStationKey(station))
  );
  const tabStopKey =
    (preferredFocusKey && visibleKeys.has(preferredFocusKey)
      ? preferredFocusKey
      : selectedItem
        ? mapStationKey(selectedItem.station)
        : mapStationKey(visible[0]?.station || DEST_MAP_FALLBACK));
  destMapFocusedKey = destMapKeyboardMode ? tabStopKey : "";
  const markerStack = visible
    .map((item, mapOrder) => ({ item, mapOrder }))
    .sort((a, b) => {
      const aSelected = sameDestination(a.item.station, pendingDestination);
      const bSelected = sameDestination(b.item.station, pendingDestination);
      if (aSelected !== bSelected) return aSelected ? 1 : -1;
      return b.mapOrder - a.mapOrder;
    });
  for (const { item, mapOrder } of markerStack) {
    const key = mapStationKey(item.station);
    renderDestMapStation(
      content,
      item,
      labelled.has(key),
      destMapKeyboardMode && key === tabStopKey,
      mapOrder
    );
  }
  renderDestMapCurrentPosition(content);
  if (destMapKeyboardMode && destMapFocusedKey) {
    requestAnimationFrame(() => {
      const match = [...content.querySelectorAll(".dest-map-node")].find(
        (node) => node.dataset.stationKey === destMapFocusedKey
      );
      match?.focus({ preventScroll: true });
    });
  }

  if (destMapState.loading) {
    setDestMapStatus(t("mapLoading"));
  } else if (projected.length === 0) {
    setDestMapStatus(t("mapNoStations"));
  } else if (projected.length > markerLimit) {
    setDestMapStatus(t("mapLimited", markerLimit));
  } else {
    setDestMapStatus(t("mapVisible", projected.length));
  }
  if ($("dest-map-hint")) $("dest-map-hint").textContent = t("mapHint");
}

function setDestMapZoom(nextZoom, anchorX = 500, anchorY = 500) {
  const zoom = Math.max(DEST_MAP_MIN_ZOOM, Math.min(DEST_MAP_MAX_ZOOM, nextZoom));
  if (zoom === destMapState.zoom) return;
  const oldCenter = mercatorPoint(
    destMapState.centerLat,
    destMapState.centerLon,
    destMapState.zoom
  );
  const viewScale = DEST_MAP_WORLD_VIEW_PX / DEST_MAP_SIZE;
  const anchorLatLon = mercatorLatLon(
    oldCenter.x + (anchorX - 500) * viewScale,
    oldCenter.y + (anchorY - 500) * viewScale,
    destMapState.zoom
  );
  const newAnchor = mercatorPoint(anchorLatLon.lat, anchorLatLon.lon, zoom);
  const nextCenter = mercatorLatLon(
    newAnchor.x - (anchorX - 500) * viewScale,
    newAnchor.y - (anchorY - 500) * viewScale,
    zoom
  );
  destMapState.zoom = zoom;
  destMapState.centerLat = nextCenter.lat;
  destMapState.centerLon = nextCenter.lon;
  destMapState.userMoved = true;
  renderDestMap();
}

function mapEventPoint(event) {
  const rect = $("dest-map-svg").getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * DEST_MAP_SIZE,
    y: ((event.clientY - rect.top) / rect.height) * DEST_MAP_SIZE,
  };
}

function startDestMapPan(event) {
  if (
    event.button !== 0 ||
    event.target.closest?.(".dest-map-node, button")
  ) {
    return;
  }
  const center = mercatorPoint(
    destMapState.centerLat,
    destMapState.centerLon,
    destMapState.zoom
  );
  destMapPointer = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    center,
    moved: false,
  };
  $("dest-map-stage").setPointerCapture?.(event.pointerId);
}

function moveDestMap(event) {
  if (!destMapPointer || event.pointerId !== destMapPointer.id) return;
  const dx = event.clientX - destMapPointer.x;
  const dy = event.clientY - destMapPointer.y;
  if (Math.hypot(dx, dy) > 3) destMapPointer.moved = true;
  if (!destMapPointer.moved) return;
  event.preventDefault();
  const width = Math.max(1, $("dest-map-svg").getBoundingClientRect().width);
  const worldPerCssPixel = DEST_MAP_WORLD_VIEW_PX / width;
  const center = mercatorLatLon(
    destMapPointer.center.x - dx * worldPerCssPixel,
    destMapPointer.center.y - dy * worldPerCssPixel,
    destMapState.zoom
  );
  destMapState.centerLat = center.lat;
  destMapState.centerLon = center.lon;
  destMapState.userMoved = true;
  const dxView = (dx / width) * DEST_MAP_SIZE;
  const dyView = (dy / width) * DEST_MAP_SIZE;
  $("dest-map-content").setAttribute(
    "transform",
    `translate(${dxView.toFixed(1)} ${dyView.toFixed(1)})`
  );
}

function endDestMapPan(event) {
  if (!destMapPointer || event.pointerId !== destMapPointer.id) return;
  $("dest-map-stage").releasePointerCapture?.(event.pointerId);
  const moved = destMapPointer.moved;
  destMapPointer = null;
  $("dest-map-content").removeAttribute("transform");
  if (moved) renderDestMap();
}

const destMapStage = $("dest-map-stage");
const destMapSvg = $("dest-map-svg");

function panDestMapByKeyboard(key, largeStep = false) {
  const center = mercatorPoint(
    destMapState.centerLat,
    destMapState.centerLon,
    destMapState.zoom
  );
  const step = largeStep ? 180 : 64;
  if (key === "ArrowLeft") center.x -= step;
  if (key === "ArrowRight") center.x += step;
  if (key === "ArrowUp") center.y -= step;
  if (key === "ArrowDown") center.y += step;
  const next = mercatorLatLon(center.x, center.y, destMapState.zoom);
  destMapState.centerLat = next.lat;
  destMapState.centerLon = next.lon;
  destMapState.userMoved = true;
  renderDestMap();
}

destMapSvg.addEventListener("keydown", (event) => {
  if (event.target !== destMapSvg) return;
  if (event.key === "Enter") {
    const nodes = [...destMapSvg.querySelectorAll(".dest-map-node")];
    if (nodes.length === 0) {
      setDestMapStatus(t("mapNoStations"));
      return;
    }
    event.preventDefault();
    destMapKeyboardMode = true;
    const selected =
      nodes.find((node) => node.getAttribute("aria-pressed") === "true") ||
      nodes[0];
    destMapFocusedKey = selected.dataset.stationKey;
    destMapSvg.tabIndex = -1;
    nodes.forEach((node) => {
      node.tabIndex = node === selected ? 0 : -1;
    });
    selected.focus({ preventScroll: true });
    return;
  }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    panDestMapByKeyboard(event.key, event.shiftKey);
    return;
  }
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    setDestMapZoom(destMapState.zoom + 1);
    return;
  }
  if (event.key === "-") {
    event.preventDefault();
    setDestMapZoom(destMapState.zoom - 1);
    return;
  }
  if (event.key === "0") {
    event.preventDefault();
    initializeDestMapCenter(curPos || alertStation || null, true);
    renderDestMap();
  }
});

destMapStage.addEventListener("pointerdown", startDestMapPan);
destMapStage.addEventListener("pointermove", moveDestMap);
destMapStage.addEventListener("pointerup", endDestMapPan);
destMapStage.addEventListener("pointercancel", endDestMapPan);
destMapStage.addEventListener(
  "wheel",
  (event) => {
    const direction = event.deltaY < 0 ? 1 : -1;
    const atLimit =
      (direction > 0 && destMapState.zoom >= DEST_MAP_MAX_ZOOM) ||
      (direction < 0 && destMapState.zoom <= DEST_MAP_MIN_ZOOM);
    if (atLimit) return;
    event.preventDefault();
    const anchor = mapEventPoint(event);
    destMapWheelDirection = direction;
    destMapWheelAnchor = anchor;
    window.clearTimeout(destMapWheelTimer);
    destMapWheelTimer = window.setTimeout(() => {
      setDestMapZoom(
        destMapState.zoom + destMapWheelDirection,
        destMapWheelAnchor.x,
        destMapWheelAnchor.y
      );
      destMapWheelDirection = 0;
    }, 80);
  },
  { passive: false }
);
$("dest-map-zoom-in").addEventListener("click", () =>
  setDestMapZoom(destMapState.zoom + 1)
);
$("dest-map-zoom-out").addEventListener("click", () =>
  setDestMapZoom(destMapState.zoom - 1)
);
$("dest-map-locate").addEventListener("click", () => {
  if (!curPos) {
    setDestMapStatus(t("mapNoLocation"));
    return;
  }
  initializeDestMapCenter(curPos, true);
  destMapState.zoom = Math.max(destMapState.zoom, 13);
  renderDestMap();
});

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
const MODE_BG = { light: "#f4f2ec", dark: "#131517" };

function applyMode(mode) {
  document.body.dataset.mode = mode;
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.backgroundColor = MODE_BG[mode];
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
  const list = loadRecentDests().filter((s) => !sameDestination(s, st));
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

let alertReturnFocus = null;

function showArrivalAlert() {
  const overlay = $("alert-overlay");
  if (!overlay.classList.contains("hidden")) return;
  alertReturnFocus =
    document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
  overlay.classList.remove("hidden");
  activateOverlay(overlay);
  requestAnimationFrame(() => {
    $("alert-dismiss-btn").focus({ preventScroll: true });
  });
}

function dismissArrivalAlert() {
  const overlay = $("alert-overlay");
  if (overlay.classList.contains("hidden")) return;
  overlay.classList.add("hidden");
  deactivateOverlay(overlay);
  navigator.vibrate?.(0);
  const connectedReturn = alertReturnFocus?.isConnected
    ? alertReturnFocus
    : null;
  const fallback =
    connectedReturn ||
    (!$("riding-screen").classList.contains("hidden")
      ? $("riding-exit-btn")
      : currentOpenSheet()
        ? focusableIn(currentOpenSheet())[0]
        : $("dest-btn"));
  fallback?.focus?.({ preventScroll: true });
  alertReturnFocus = null;
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
  showArrivalAlert();
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
  const historyItems = loadHistory().slice(0, 5);
  $("history-empty").classList.toggle("hidden", historyItems.length > 0);
  listEl.classList.toggle("hidden", historyItems.length === 0);
  for (const h of historyItems) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = h.name;
    const time = document.createElement("span");
    time.className = "dist";
    time.textContent = new Date(h.ts).toLocaleTimeString(
      lang === "ja" ? "ja-JP" : "en-US",
      {
      hour: "2-digit",
      minute: "2-digit",
      }
    );
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
let ridingExitTimer = null;
let ridingGeneration = 0;
let ridingThemeColor = null;

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
  if (!$("riding-screen").classList.contains("hidden")) return;
  const generation = ++ridingGeneration;
  clearTimeout(ridingExitTimer);
  const ridingScreen = $("riding-screen");
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  ridingThemeColor = themeMeta?.getAttribute("content") || MODE_BG.dark;
  document.documentElement.classList.add("riding-active");
  document.documentElement.style.backgroundColor = "#000";
  document.body.classList.add("riding-active");
  if (themeMeta) themeMeta.setAttribute("content", "#000");
  ridingScreen.classList.remove("hidden", "is-leaving");
  activateOverlay(ridingScreen);
  $("riding-btn").setAttribute("aria-expanded", "true");
  $("riding-exit-btn").focus({ preventScroll: true });
  updateRidingClock();
  ridingClockTimer = setInterval(updateRidingClock, 1000);
  // 車内モード中は画面を消灯させない。手動設定とは別の所有理由として管理する。
  wakeReasons.add("riding");
  const acquired = await syncWakeLock();
  if (generation !== ridingGeneration || $("riding-screen").classList.contains("is-leaving")) {
    wakeReasons.delete("riding");
    void syncWakeLock();
    return;
  }
  ridingAcquiredWakeLock = acquired;
}

function exitRidingMode() {
  const ridingScreen = $("riding-screen");
  if (ridingScreen.classList.contains("hidden") || ridingScreen.classList.contains("is-leaving")) {
    return;
  }
  ridingGeneration += 1;
  ridingScreen.classList.add("is-leaving");
  $("riding-btn").setAttribute("aria-expanded", "false");
  clearInterval(ridingClockTimer);
  wakeReasons.delete("riding");
  void syncWakeLock();
  ridingAcquiredWakeLock = false;
  ridingExitTimer = setTimeout(() => {
    ridingScreen.classList.add("hidden");
    ridingScreen.classList.remove("is-leaving");
    deactivateOverlay(ridingScreen);
    document.documentElement.classList.remove("riding-active");
    document.documentElement.style.backgroundColor =
      MODE_BG[document.body.dataset.mode || "dark"];
    document.body.classList.remove("riding-active");
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute(
        "content",
        ridingThemeColor || MODE_BG[document.body.dataset.mode || "dark"]
      );
    }
    ridingThemeColor = null;
    $("riding-btn").focus({ preventScroll: true });
  }, motionMs(160));
}

function updateRidingClock() {
  $("r-clock").textContent = new Date().toLocaleTimeString(
    lang === "ja" ? "ja-JP" : "en-US",
    {
    hour: "2-digit",
    minute: "2-digit",
    }
  );
}

// =====================================================================
// 画面常時点灯 (Wake Lock)
// =====================================================================
const wakeReasons = new Set();
let wakeLockReleasePromise = null;
let wakeLockAcquirePromise = null;

async function acquireWakeLock() {
  if (wakeLockReleasePromise) await wakeLockReleasePromise;
  if (wakeLock) return true;
  if (wakeLockAcquirePromise) return wakeLockAcquirePromise;
  wakeLockAcquirePromise = (async () => {
    try {
      const acquiredLock = await navigator.wakeLock.request("screen");
      wakeLock = acquiredLock;
      $("wakelock-btn").classList.add("active");
      updateHeaderUI();
      acquiredLock.addEventListener("release", () => {
        if (wakeLock !== acquiredLock) return;
        wakeLock = null;
        $("wakelock-btn").classList.remove("active");
        updateHeaderUI();
        if (wakeReasons.size > 0 && document.visibilityState === "visible") {
          void syncWakeLock();
        }
      });
      return true;
    } catch {
      return false;
    } finally {
      wakeLockAcquirePromise = null;
    }
  })();
  return wakeLockAcquirePromise;
}

async function releaseWakeLock() {
  if (wakeLockReleasePromise) {
    await wakeLockReleasePromise;
    return;
  }
  const lockToRelease = wakeLock;
  if (!lockToRelease) {
    updateHeaderUI();
    return;
  }
  wakeLockReleasePromise = lockToRelease
    .release()
    .catch(() => {})
    .finally(() => {
      if (wakeLock === lockToRelease) wakeLock = null;
      wakeLockReleasePromise = null;
      updateHeaderUI();
    });
  await wakeLockReleasePromise;
}

async function toggleWakeLock() {
  const button = $("wakelock-btn");
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  const enabling = !wakeReasons.has("manual");
  if (enabling) wakeReasons.add("manual");
  else wakeReasons.delete("manual");
  const success = await syncWakeLock();
  button.setAttribute("aria-busy", "false");
  if (enabling && !success) {
    wakeReasons.delete("manual");
    showError(t("wakeLockFail"));
  }
}

async function syncWakeLock() {
  if (wakeReasons.size > 0) return acquireWakeLock();
  await releaseWakeLock();
  return true;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wakeReasons.size > 0) {
    void syncWakeLock();
  }
});

// =====================================================================
// エラー表示
// =====================================================================
let errorTimer = null;
function showToast(msg, isError = true) {
  errorBanner.textContent = msg;
  errorBanner.setAttribute("role", isError ? "alert" : "status");
  errorBanner.setAttribute("aria-live", isError ? "assertive" : "polite");
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
