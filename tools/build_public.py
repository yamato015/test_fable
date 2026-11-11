#!/usr/bin/env python3
"""Build the static web app for Cloudflare Pages: python3 tools/build_public.py.

Set the Pages output directory to dist. Only explicitly listed public files and
assets are copied; repository instructions, tooling and server code stay out.
"""
from pathlib import Path
import re
import shutil
from build_app_preview import build_preview

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "dist"
PUBLIC_FILES = (
    "index.html", "lp.html", "privacy.html", "rights.html",
    "lp-motion.css", "lp-motion.js", "app-start-motion.css", "app-start-motion.js",
    "style.css", "app-design.css", "app-ux.css", "app.js", "config.js",
    "stations.js", "stations_jp.js", "sw.js", "manifest.json",
    "icon.svg", "icon-512.png", "apple-touch-icon.png",
    "app-start-scene.svg", "lp-hero-desktop.svg", "lp-hero-mobile.svg",
    "lp-hero-rail.svg", "lp-onboard-ui.svg", "lp-product-ui.svg",
    "lp-seated-hero.svg", "lp-seated-mobile.svg", "LICENSE.md", "NOTICE.md",
)


def main():
    # Validate before replacing a previous build.
    for name in PUBLIC_FILES:
        if not (ROOT / name).is_file():
            raise SystemExit(f"Missing public file: {name}")
    if not (ROOT / "assets").is_dir():
        raise SystemExit("Missing assets directory")
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir()
    for name in PUBLIC_FILES:
        shutil.copy2(ROOT / name, OUTPUT / name)
    shutil.copytree(ROOT / "assets", OUTPUT / "assets")
    # Pages redirects *.html to extensionless routes. Cache the canonical routes
    # so a cached redirected response is never returned to a manual navigation.
    # Keep source URLs unchanged for the existing GitHub Pages deployment.
    for name in ("index.html", "lp.html", "privacy.html", "rights.html"):
        path = OUTPUT / name
        html = path.read_text(encoding="utf-8")
        html = re.sub(r'href="(lp|privacy|rights)\.html([#?][^\"]*)?"',
                      lambda m: f'href="{m[1]}{m[2] or ""}"', html)
        path.write_text(html, encoding="utf-8")
    worker = OUTPUT / "sw.js"
    script = worker.read_text(encoding="utf-8")
    script = script.replace('"./","index.html",', '"./",')
    for route in ("lp", "privacy", "rights"):
        script = script.replace(f'"{route}.html"', f'"{route}"')
    worker.write_text(script, encoding="utf-8")
    # A top-level 404 prevents Pages from treating unknown paths as an SPA route.
    (OUTPUT / "404.html").write_text(
        '<!doctype html><html lang="ja"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>ページが見つかりません | エキココ</title>'
        '<main style="max-width:40rem;margin:15vh auto;padding:1.5rem;'
        'font-family:system-ui;line-height:1.8">'
        '<h1>ページが見つかりません</h1>'
        '<p lang="en">This page could not be found.</p>'
        '<p><a href="/">アプリを開く / Open app</a></p>'
        '<p><a href="/lp">エキココの紹介 / About EkiKoko</a></p>'
        '</main></html>\n', encoding="utf-8")
    build_preview(OUTPUT)
    files = [p for p in OUTPUT.rglob("*") if p.is_file()]
    print(f"Built {len(files)} public files in dist ({sum(p.stat().st_size for p in files):,} bytes)")


if __name__ == "__main__":
    main()
