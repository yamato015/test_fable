"""Create a GPS-free review route only on the app UX review branch.

The shipped app.js remains unchanged. The sample has namespaced preferences,
no notifications, analytics or service worker, and never calls device GPS.
"""
import os

PREVIEW_BRANCH = "codex/app-ux-preview-20261107"


def build_preview(output):
    if os.environ.get("CF_PAGES_BRANCH") != PREVIEW_BRANCH:
        return
    html = (output / "index.html").read_text(encoding="utf-8")
    html = html.replace('<main id="app">', '''<main id="app">
      <aside class="ux-preview-banner" aria-label="Preview">
        <strong data-i18n="previewTitle">画面プレビュー</strong>
        <span data-i18n="previewNote">新宿駅のサンプルです。実際の現在地は使用しません。</span>
        <a href="https://ekikoko.pages.dev/" data-i18n="previewLive">公開中のアプリを開く</a>
      </aside>''', 1)
    html = html.replace('<script src="app.js"></script>', '<script src="app-preview-runtime.js"></script>', 1)
    html = html.replace('<head>', '<head>\n  <meta name="robots" content="noindex,nofollow">', 1)
    script = (output / "app.js").read_text(encoding="utf-8")
    script = script.replace('navigator.geolocation', 'previewGeolocation')
    script = script.replace('"geolocation" in navigator', 'true')
    script = script.replace('"Notification" in window', 'false')
    script = script.replace('if (CONFIG.cloudflareAnalyticsToken)', 'if (false)')
    worker = '''if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
}'''
    if worker not in script:
        raise SystemExit("Sample build could not disable service worker")
    script = script.replace(worker, '// Sample route: no service worker.')
    script = script.replace('localStorage', 'previewStorage')
    # Strings must be replaced before the normal initialization at file end.
    insert_at = script.rfind('\napplyLang();')
    if insert_at < 0:
        raise SystemExit("Sample build could not find app initialization")
    labels = '''
Object.assign(STRINGS.ja, {
  startBtn: "サンプルで試す", startNote: "実際の位置情報は取得・送信しません。", startHelp: "新宿駅のサンプル画面を開きます。位置情報の許可は不要です。",
  previewTitle: "画面プレビュー", previewNote: "新宿駅のサンプルです。実際の現在地は使用しません。",
  previewLive: "公開中のアプリを開く"
});
Object.assign(STRINGS.en, {
  startBtn: "Try the sample", startNote: "Your real location is not collected or sent.", startHelp: "Open a Shinjuku sample. No location permission is needed.",
  previewTitle: "Interface preview", previewNote: "Shinjuku sample. Your real location is not used.",
  previewLive: "Open the live app"
});
'''
    script = script[:insert_at] + labels + script[insert_at:]
    provider = '''"use strict";
const previewStorage = {
  getItem(key) { return localStorage.getItem("ux-preview:" + key); },
  setItem(key, value) { localStorage.setItem("ux-preview:" + key, value); },
  removeItem(key) { localStorage.removeItem("ux-preview:" + key); },
  clear() { Object.keys(localStorage).filter(key => key.startsWith("ux-preview:")).forEach(key => localStorage.removeItem(key)); }
};
const previewGeolocation = (() => {
  let nextId = 0;
  const watches = new Map();
  const position = () => ({ coords: { latitude: 35.690921, longitude: 139.700258, accuracy: 12, speed: 0, heading: null, altitude: null, altitudeAccuracy: null }, timestamp: Date.now() });
  return {
    getCurrentPosition(success) { setTimeout(() => success(position()), 80); },
    watchPosition(success) {
      const id = ++nextId;
      const first = setTimeout(() => success(position()), 80);
      const interval = setInterval(() => success(position()), 15000);
      watches.set(id, { first, interval });
      return id;
    },
    clearWatch(id) { const timers = watches.get(id); if (timers) { clearTimeout(timers.first); clearInterval(timers.interval); watches.delete(id); } }
  };
})();
'''
    (output / "app-preview.html").write_text(html, encoding="utf-8")
    (output / "app-preview-runtime.js").write_text(provider + script, encoding="utf-8")
