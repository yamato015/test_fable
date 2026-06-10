# ストア配信ガイド（フェーズ3）

PWAをストアに載せる際の手順メモ。**Web版(課金・広告)が安定してから着手する。**

## Android: TWA (Trusted Web Activity)

PWAをそのままラップする方式。Webと同じコードベースで配信できる。

### 手順 (Bubblewrap CLI)

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://<公開URL>/manifest.json
bubblewrap build   # → app-release-signed.apk / .aab が生成される
```

### 必要な準備

1. **アイコン**: ストア用に512x512のPNGが必要
   （`icon.svg`から書き出す。maskable対応版も用意する）
2. **Digital Asset Links**: アプリとサイトの紐付け
   - `bubblewrap build`時に表示されるSHA-256フィンガープリントを
     `https://<公開URL>/.well-known/assetlinks.json` に配置する
3. **Google Play Console** 登録（初回のみ $25）

### 課金の注意点

Google Playで配信する場合、**デジタルコンテンツのサブスクはPlay Billingの
利用が必須**（Stripeへの誘導はポリシー違反になりうる）。TWAでは
[Digital Goods API](https://developer.chrome.com/docs/android/trusted-web-activity/receive-payments-play-billing)
でPlay Billingを呼び出せる。実装方針:

- `config.js` に `platform: "play"` を追加し、課金導線を分岐
- バックエンドにPlayレシート検証エンドポイント (`/api/activate-play`) を追加
- 価格はWebと揃える（Play手数料15%は織り込み済みとする）

## iOS: Capacitor

iOSはTWA相当の仕組みがないため [Capacitor](https://capacitorjs.com/) でラップする。

```bash
npm init -y && npm i @capacitor/core @capacitor/cli
npx cap init いまここ jp.imakoko.app --web-dir .
npx cap add ios
```

- 課金はStoreKit (アプリ内課金) が必須。`@revenuecat/purchases-capacitor` を
  使うとレシート検証とWeb課金の突合が楽になる
- バックグラウンド位置情報 + ローカル通知で**降車アラートを画面オフでも
  動かせる**のがネイティブ化の最大のメリット（プレミアムの訴求力が上がる）
- Apple Developer Program ($99/年) が必要

## 配信後のロードマップ

1. ネイティブ通知でバックグラウンド降車アラートを強化
2. ストアレビュー導線（アラート発火成功直後に評価を依頼）
3. プラットフォーム別の課金状態をバックエンドで統合管理
