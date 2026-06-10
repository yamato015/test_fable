"use strict";

// デプロイ環境ごとの設定。アプリ本体のロジックは app.js を参照。
window.APP_CONFIG = {
  // 課金バックエンドのURL (server/ をCloudflare Workersにデプロイして得たURL)
  // 例: "https://imakoko-billing.example.workers.dev"
  // 空文字のままだと課金はデモモード (即時有効化) で動作する
  backendUrl: "",

  // Google AdSense (無料プランの広告枠)
  // 空文字のままだと広告枠はプレースホルダ表示になる
  adsenseClient: "", // 例: "ca-pub-1234567890123456"
  adsenseSlot: "",   // 例: "1234567890"
};
