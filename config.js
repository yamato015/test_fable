"use strict";

// デプロイ環境ごとの設定。アプリ本体のロジックは app.js を参照。
window.APP_CONFIG = {
  // 課金バックエンドのURL (server/ をCloudflare Workersにデプロイして得たURL)
  // 例: "https://ekikoko-billing.example.workers.dev"
  // 空文字のままだと課金はデモモード (即時有効化) で動作する
  backendUrl: "",

  // Google AdSense (無料プランの広告枠)
  // 空文字のままだと広告枠はプレースホルダ表示になる
  adsenseClient: "", // 例: "ca-pub-1234567890123456"
  adsenseSlot: "",   // 例: "1234567890"

  // Cloudflare Web Analytics (Cookie不使用・無料)
  // https://dash.cloudflare.com → Web Analytics でサイト登録して得たトークン。
  // 空文字のままだとアクセス解析は一切行わない
  cloudflareAnalyticsToken: "aac7b4535a5644789782592fc6258e2a",

  // ベータ版フィードバックの送り先 (GoogleフォームのURLや "mailto:..." など)
  // 空文字のままだとフィードバックリンクは表示されない
  feedbackUrl: "",

  // 全国の駅検索に使う Transit API (CORS対応・認証不要・読み取り専用)
  // 目的地検索で内蔵データ(首都圏+関西)に無い駅も検索できるようになる。
  // 送るのは入力した駅名テキストのみ (現在地は送らない)。
  // 空文字にすると全国検索は無効になり、内蔵データだけで動作する
  transitApiUrl: "https://api.transit.ls8h.com",
};
