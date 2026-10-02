# AGENTS.md — エキココ (EkiKoko)

Codexなど、このリポジトリを編集するAIエージェント向けの入口。

## 最初に読むもの

1. `docs/ai-roles.md` — AIの役割分担と受け渡しルール（**必読**）
2. `CLAUDE.md` — リポジトリの構成・規約・デプロイ手順（Claude Code向けだが、
   技術的な規約はすべてのエージェントに共通）
3. `docs/decision-log.md` — オーナーが決めたこと。これと矛盾する変更はしない

## 必ず守ること（CLAUDE.mdの要約）

- 作業ブランチは `claude/practical-babbage-xrtvmo`。このブランチへ push すると
  GitHub Pages（https://yamato015.github.io/test_fable/）に**そのまま本番反映**される
- 静的アセットを変えたら、push前に `python3 tools/bump_cache.py` でキャッシュ版を上げる
- `stations.js` / `stations_jp.js` は自動生成物。手で編集しない
- 文言を足すときは `app.js` の `STRINGS.ja` と `STRINGS.en` の両方に入れる
- 位置情報は端末内で処理する設計を崩さない。個人データをサーバーに持たない
- 署名鍵（`*.keystore`）・パスワード・APIキーなどの秘密情報をコミットしない
- 新機能はオーナーの判断（フィードバックの結果など）が出てから実装する

## デザインの反映について

LP・HPのデザインはChatGPTが担当している。`docs/design/` にある決定済みの
デザインを反映するときは、`docs/ai-roles.md` の「デザイン」の手順に従うこと。
