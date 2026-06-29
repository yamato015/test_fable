# エキココ (EkiKoko) — プロジェクトメモ

電車内で「いま自分がどの駅にいるか」を特大表示で確認できるPWA。
混雑時に座っていると車内の電光掲示板が見えない、という課題の解決が出発点。

## 全体像

- **フレームワーク不使用**のバニラJS + HTML + CSS。ビルド工程なし
- **PWA**: ホーム画面追加で全画面起動。Service Workerでオフライン動作
- **ホスティング**: GitHub Pages（静的配信・固定費ゼロ）
- 公開URL: https://yamato015.github.io/test_fable/
- **課金/解析は自前サーバーレス**: 決済はStripe、解析はCloudflare Web Analytics

## 開発ブランチ

- 作業ブランチ: `claude/practical-babbage-xrtvmo`
- このブランチへ push すると GitHub Pages に自動デプロイ（1〜2分）

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 画面構造。文言は `data-i18n` 属性で多言語化 |
| `app.js` | 本体ロジック（位置取得・最寄り判定・課金・i18n・全機能） |
| `stations.js` | 駅データ（`window.STATIONS` / `LINE_ORDER` / `LINE_META`）。**自動生成物・手編集しない** |
| `config.js` | デプロイ環境ごとの設定（後述）。機能のON/OFFはここ |
| `style.css` | スタイル。テーマは `body[data-theme]` で切替 |
| `sw.js` | Service Worker。`CACHE_NAME` がキャッシュのバージョン |
| `privacy.html` | プライバシーポリシー＋特商法表記 |
| `server/` | Stripe課金バックエンド（Cloudflare Workers）。未デプロイ |
| `tools/build_stations.py` | 駅データ再生成スクリプト |
| `tools/bump_cache.py` | デプロイ前のキャッシュ版自動更新 |

## デプロイ手順（重要・順番厳守）

静的アセットを変更したら **必ずキャッシュ版を上げる**。忘れるとユーザーに
古い版が配られ続ける。

```bash
python3 tools/bump_cache.py   # sw.js の CACHE_NAME を自動で +1
git add -A && git commit -m "..." 
git push -u origin claude/practical-babbage-xrtvmo
```

## 駅データの再生成（network必須）

`stations.js` は公式オープンデータ由来（station_database / 原典は国土数値情報・
駅データ.jp）。範囲変更や駅追加はスクリプト経由で行い、手編集しない。

```bash
# 元データを /tmp に取得してから
python3 tools/build_stations.py
```

対象エリアは `tools/build_stations.py` の `PREFS`（都道府県コード）で制御。
現在は首都圏+関西。東海など追加するならここにコードを足すだけ。

## config.js による機能スイッチ

| 設定 | 空のとき | 値を入れたとき |
|---|---|---|
| `backendUrl` | 課金はデモ（即時有効化） | Stripe実課金 |
| `adsenseClient` | 広告枠はプレースホルダ | AdSense配信 |
| `cloudflareAnalyticsToken` | 解析なし | アクセス解析（設定済み） |
| `feedbackUrl` | フィードバック非表示 | フィードバックリンク表示 |
| `transitApiUrl` | 目的地検索は内蔵データのみ | 全国の駅を検索（Transit API・駅名テキストのみ送信） |

## コード規約・注意

- **多言語**: 静的文言は HTML の `data-i18n` / `data-i18n-html` / `data-i18n-ph`、
  動的文言は app.js の `t("key", ...)`。文言追加時は `STRINGS.ja` と `STRINGS.en` の両方に
- **駅の表示名**: データ上は「中津(OsakaMetro)」等の接尾辞付きがある。表示は必ず
  `dispName(s)` / `dispSub(s)` を通す（接尾辞除去・英語ローマ字対応）
- **位置情報は端末内処理が原則**。外部API（Overpass）には約1km丸めた座標のみ送る
- **個人データはサーバーに持たない**設計を維持する（課金状態は署名トークン）
- 駅到着時の「🚉 いまここ！」バッジはブランド名ではなく "you are here" の意味

## この環境での動作確認

リモート（クラウド）実行のため、ローカルプレビュー不可。確認は Playwright で
スクリーンショットを撮る（位置情報は `geolocation` でモックできる）。
例は過去セッションの `/tmp/shot*.cjs` を参照。

## やらないこと（PoC段階の方針）

- AdSense（トラフィック実績が出るまで）
- ストア配信・Apple Developer登録（継続率の証拠が出てから）
- 新機能の実装は、フィードバックの投票結果で優先度を決めてから
