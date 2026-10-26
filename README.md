# エキココ / EkiKoko

電車の中で、端末の位置情報をもとに近くの駅を大きく確認するWebアプリです。

- [アプリを開く](https://yamato015.github.io/test_fable/)
- [紹介ページ](https://yamato015.github.io/test_fable/lp.html)
- [プライバシー](https://yamato015.github.io/test_fable/privacy.html)
- [権利・出典](https://yamato015.github.io/test_fable/rights.html)

## 現在の公開版

登録不要の無料ベータ版です。ホーム画面に追加してPWAとして利用できます。
現在駅の表示、車内モード、乗り換えの目安、乗り方ガイドに対応しています。
Plusの目的地設定・降車アラート・次駅予測なども、現在は料金請求のないデモです。
実際の決済は受け付けていません。

表示はGPSによる推定です。地下鉄・トンネル・並走区間などでは更新できない、
または別の駅・路線が表示される場合があります。車内の表示・放送も確認してください。
アプリを閉じた状態や画面ロック中の降車通知は保証しません。

## 使い方

1. アプリを開き、「現在地を確認する」をタップして位置情報を許可します。
2. 表示された駅と、必要に応じて路線を確認します。
3. 車内モードで駅名を大きく表示できます。

感想・不具合は、アプリ内の「メールで感想を送る」から
 ekikoko.app@gmail.com へお寄せください。

## データと権利

独自のコード・文章・図案等の再利用条件は [LICENSE.md](LICENSE.md) に記載しています。
本リポジトリの公開は、自由な再配布や別サービスへの転用を包括的に許諾するものでは
ありません。通常のアプリ利用、リンクによる紹介・レビューは歓迎します。

第三者のデータ・素材には、各権利者のライセンスが適用されます。
独自部分の条件で、第三者のライセンスを制限しません。詳細は [NOTICE.md](NOTICE.md)。

- 内蔵駅データ: [station_database](https://github.com/Seo-4d696b75/station_database)
  by Seo-4d696b75 and contributors — [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。
  対象地域の抽出・形式変換・座標の丸め・ローマ字と検索用索引の生成を行っています。
- 圏外のオンライン駅データ: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
  — [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)。Overpass API経由で取得します。

正確な座標・履歴は運営者のサーバーへ送信・保存しません。内蔵データの圏外では、
駅情報取得のため約1km単位に丸めた座標を外部サービスへ送信します。

## 開発と公開

バニラJavaScript・HTML・CSSで構成し、ビルド工程はありません。
技術上の規約は [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) を参照してください。
`stations.js` と `stations_jp.js` は自動生成物で、手で編集しません。
静的アセットを変更した場合は、公開前に `python3 tools/bump_cache.py` を実行します。

本番ブランチは `claude/practical-babbage-xrtvmo`。
このブランチへの反映でGitHub Pagesが更新されます。

収益計画・未公開の企画・検討資料は、オーナー管理の非公開Notionで扱います。
公開リポジトリには追加しません。過去に公開されていた資料は、旧コミットや
他のブランチ・第三者のコピーに残る場合があります。
