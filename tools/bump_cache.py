#!/usr/bin/env python3
"""sw.js のキャッシュ版 (CACHE_NAME = "ekikoko-vN") を自動で 1 つ上げる。

静的アセットを変更したらデプロイ前にこれを実行する。これを忘れると
Service Worker が古いキャッシュを配り続け、ユーザーに更新が届かない。

使い方:
    python3 tools/bump_cache.py
"""
import re
import pathlib

sw_path = pathlib.Path(__file__).resolve().parent.parent / "sw.js"
text = sw_path.read_text(encoding="utf-8")

m = re.search(r'CACHE_NAME = "ekikoko-v(\d+)"', text)
if not m:
    raise SystemExit("sw.js に CACHE_NAME = \"ekikoko-vN\" が見つかりません")

new_version = int(m.group(1)) + 1
text = text[: m.start()] + f'CACHE_NAME = "ekikoko-v{new_version}"' + text[m.end() :]
sw_path.write_text(text, encoding="utf-8")
print(f"キャッシュ版を v{new_version} に更新しました")
