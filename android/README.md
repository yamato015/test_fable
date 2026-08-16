# エキココ TWA (Google Play向けAndroidラッパー)

## 現状（2026-08時点）

このディレクトリはTWA (Trusted Web Activity) — 既存のPWAをそのままGoogle Play
ストアで配信するための薄いAndroidラッパー。**この作業環境ではAndroid SDK
（`dl.google.com`）へのネットワークアクセスがポリシーでブロックされており、
実際のAndroidプロジェクト生成・ビルドはこの環境では完了できなかった。**
以下、できたこと・できなかったこと・次に必要なことを正直にまとめる。

## できたこと（このリポジトリに残っている）

- `twa-manifest.json` — Bubblewrap CLIのプロジェクト設定。packageId
  `app.ekikoko.twa`、既存のPWA (`https://yamato015.github.io/test_fable/`)
  のmanifest.jsonとアイコンを参照する内容で用意済み
- `android.keystore` — リリース署名鍵。**Gitには含めていない**（`.gitignore`
  参照）。オーナー宛てに直接ファイル送付済み。エイリアス `ekikoko`、
  パスワード `ekikoko2026release`
- `assetlinks.json` — 署名鍵のSHA256フィンガープリントから生成した
  Digital Asset Links。**ドメインのルート**（`https://<domain>/.well-known/assetlinks.json`）
  に設置する必要がある。今のGitHub Pagesは `yamato015.github.io/test_fable/`
  というサブパスなので、ドメインのルートはこのリポジトリの管轄外。
  **独自ドメイン取得後、そのドメインのルートに設置すること**
- `../docs/play-store-listing.md` — Play Console入力用のアプリ説明文・
  カテゴリ・データセーフティ申告の下書き
- `.nojekyll`（リポジトリ直下）— 将来 `.well-known/assetlinks.json` を
  このリポジトリで配信する場合に備えて追加済み

## できなかったこと・その理由

Bubblewrap CLIは初回実行時にAndroid SDKのダウンロードを要求する。この
ダウンロード元 `dl.google.com` への接続が、この作業環境のネットワーク
ポリシーで **403 (方針拒否)** となり、Android SDK・ビルドツール一式を
一切取得できなかった。そのため:

- Androidプロジェクト本体（`app/`, `gradlew`, `AndroidManifest.xml` 等）の
  生成ができていない
- 署名済みAAB (`.aab`) のビルドができていない
- したがってPlay Consoleへのアップロードもこの環境からはできない

これは実装のミスではなく、この環境の通信制限による構造的な制約。

## 次にやること（2つの選択肢）

### 選択肢A: 自分のPC (Android Studio) でビルドする
1. Android Studioをインストール（Android SDKが同梱される）
2. このリポジトリを手元にclone
3. `android/` ディレクトリで `npx @bubblewrap/cli build` を実行
   （`twa-manifest.json` は用意済みなので、対話質問には基本Enterで進められる
   はず。署名鍵を聞かれたら、送付済みの `android.keystore` を
   `android/android.keystore` に置いて指定する）
4. 生成された `.aab` ファイルをPlay Consoleにアップロード

### 選択肢B: GitHub Actionsでビルドする（このリポジトリのGitHubアカウント経由）
GitHubのビルド環境はネットワーク制限が無いため、Android SDKのダウンロードが
通る。ワークフローファイル（`.github/workflows/build-twa.yml`）を書けば
push時に自動でAABをビルドできる。ただし署名鍵をGitHub Secretsに登録する
手作業がオーナー側で必要（リポジトリの Settings → Secrets and variables →
Actions で `ANDROID_KEYSTORE_BASE64` 等を設定）。

**この続きを進めるかはオーナー判断**（Bを選ぶ場合、ワークフローファイルの
作成はこちらで対応できる）。
