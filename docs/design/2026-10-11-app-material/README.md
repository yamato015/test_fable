# アプリ内の写真と素材感 — 2026-10-11

## ユーザーの条件
- 棒人間のような人物イラストは使わない。
- 単調・平面的で安っぽい画面にしない。
- アプリ内を含めて条件を理解して修正する。

## 反映内容
- ガイドの簡略SVG図解6点を削除。実写調の改札写真と番号付き手順に変更。
- 図解用のアニメーション処理を削除。
- 起動画面の写真にフレームと接地する影、開始ボタンに厚みと押下表現。
- 現在駅を路線カラー帯・縁・下端の厚みを持つ駅名標として表現。
- 車内モードの操作は濃い金属色、目的地はきっぷ状の面、設定は独立した物理キーとして区別。
- ライト／ダーク、3色テーマ、黒背景の車内モード、日本語／英語を維持。
- 以前の平面化CSSを末尾から除き、新しい外観を app-design.css に集約。
- 古い未使用人物イラスト3点をオフライン事前キャッシュ対象から除外。

## 素材
- assets/lp/station-gates-photo.jpg（新規生成。実在施設の記録写真ではない）
- assets/lp/train-display.png（既存の承認済み写真素材）
- 生成ツール: built-in image_gen。API/CLI fallbackは不使用。
- 元PNGは生成ツールの保存先に保持し、配信用JPEGをリポジトリ内に保存。

### 生成プロンプト
Use case: photorealistic-natural. Asset type: wide photograph for a Japanese railway app's practical ticket-gate guide. Primary request: an exceptionally realistic editorial photograph of modern Japanese station ticket gates, taken at a low three-quarter angle near the passenger side. Foreground: a brushed stainless-steel automatic gate with a recognizable blue circular IC card touch reader, fine metal texture, small wear marks and precise industrial construction. Several gates recede naturally into the station concourse. Warm white station lighting, believable reflections and soft shadows, rich depth, restrained charcoal/silver palette with subtle blue accents. No visible people, no human silhouettes, no drawings, no vector art, no CGI/plastic rendering, no collage, no captions, no prominent readable signage, no logos or watermarks. Landscape 3:2 composition; important gate and blue reader near the center, safe for wide cropping. This is an atmospheric photograph, not a technical instruction diagram.

## 検証
- JavaScript構文とGit差分の検査。
- 390px／320pxの表示、ライト／ダーク、英語／日本語。
- ガイドのJR Pass等の絞り込み、残存する説明イラストが0点であること。
- 目的地検索（Shinjuku）、デモ機能、車内モードの黒背景。
- 新宿の疑似位置情報を使うローカル専用ページで正常表示を確認（検証用ページは公開しない）。
