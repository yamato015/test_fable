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
  feedbackUrl: "https://tally.so/r/PdgXxx",
};
