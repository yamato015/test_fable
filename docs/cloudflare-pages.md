# Cloudflare Pagesへの静的公開

ドメイン取得費用のない `*.pages.dev` のURLを利用する。独自ドメイン、有料プラン、課金バックエンドはこの設定に含めない。

## ビルド設定

| 項目 | 値 |
|---|---|
| GitHubリポジトリ | `yamato015/test_fable` |
| 本番ブランチ | `claude/practical-babbage-xrtvmo` |
| Framework preset | None |
| Build command | `python3 tools/build_public.py` |
| Build output directory | `dist` |
| Root directory | リポジトリのルート |

環境変数や秘密情報の追加は不要。リポジトリのルートをそのまま公開せず、必ず `dist` を公開する。`dist` は生成物で、コミットしない。

GitHub連携後は、本番ブランチへのpushが新しいデプロイを開始する。他のAIが更新するときも、このブランチと既存のキャッシュ更新手順を使う。

## 公開対象

`tools/build_public.py` に列挙したアプリ・LP・利用情報・ライセンス表記・駅データと、`assets/` の素材をコピーする。新しい参照ファイルを追加した場合は、この一覧も更新する。

`docs/`、`tools/`、`server/`、`android/`、AI向け指示やGit情報は出力しない。存在しないURLがアプリ本体に置き換わらないよう、トップレベルの `404.html` を生成する。

PagesはHTMLを拡張子のないURLへ転送するため、出力するHTMLの内部リンクとService Workerのキャッシュ対象は `/lp`、`/privacy`、`/rights` に揃える。転送後のレスポンスを `.html` のキーで保存すると、ページ遷移でエラーになる場合がある。GitHub Pages向けのソースは従来の `.html` 指定を維持し、この調整はビルド出力にだけ適用する。

## 公開後の確認

- HTTPSでアプリ・LP・プライバシー・権利表記を開けること。
- CSS・写真・アイコン・駅データを取得できること。
- Service Workerの事前キャッシュと全国駅検索用データの参照先に欠落がないこと。
- 存在しないURLや公開対象外の資料が404になること。
- 実際に割り当てられたURLを確認してから、READMEや告知文・管理先の案内リンクを更新すること。

URLのホストを変えても、旧URLに保存された設定・履歴は新URLへ自動では引き継がれない。位置情報の許可やホーム画面追加も新URLで必要になる場合がある。
