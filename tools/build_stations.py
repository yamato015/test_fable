# 使い方: python3 tools/build_stations.py (要: /tmp/sdb_station.json, /tmp/sdb_line.json)
# stations.js を station_database (https://github.com/Seo-4d696b75/station_database) から生成
import json, re, subprocess, time

PREFS = {8, 11, 12, 13, 14, 25, 26, 27, 28, 29, 30}  # 首都圏+関西
EXCLUDE = re.compile(r'新幹線|ケーブル|ロープウェ|リフト|成田エクスプレス')

stations = [s for s in json.load(open('/tmp/sdb_station.json'))
            if not s['closed'] and s['prefecture'] in PREFS]
lines_all = {l['code']: l for l in json.load(open('/tmp/sdb_line.json'))}

# 対象路線 = 対象駅が参照する路線のうち除外パターン以外
line_codes = set()
for s in stations:
    line_codes.update(s['lines'])
line_codes = {c for c in line_codes
              if c in lines_all and not lines_all[c]['closed']
              and not EXCLUDE.search(lines_all[c]['name'])}
print('駅:', len(stations), '路線:', len(line_codes))

# ---- かな → ローマ字 (ヘボン式簡易) ----
BASE = {
 'あ':'a','い':'i','う':'u','え':'e','お':'o','か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko',
 'さ':'sa','し':'shi','す':'su','せ':'se','そ':'so','た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to',
 'な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no','は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho',
 'ま':'ma','み':'mi','む':'mu','め':'me','も':'mo','や':'ya','ゆ':'yu','よ':'yo',
 'ら':'ra','り':'ri','る':'ru','れ':'re','ろ':'ro','わ':'wa','ゐ':'i','ゑ':'e','を':'o',
 'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go','ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo',
 'だ':'da','ぢ':'ji','づ':'zu','で':'de','ど':'do','ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo',
 'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po','ん':'n','ー':'',
}
DIGRAPH = {
 'きゃ':'kya','きゅ':'kyu','きょ':'kyo','しゃ':'sha','しゅ':'shu','しょ':'sho',
 'ちゃ':'cha','ちゅ':'chu','ちょ':'cho','にゃ':'nya','にゅ':'nyu','にょ':'nyo',
 'ひゃ':'hya','ひゅ':'hyu','ひょ':'hyo','みゃ':'mya','みゅ':'myu','みょ':'myo',
 'りゃ':'rya','りゅ':'ryu','りょ':'ryo','ぎゃ':'gya','ぎゅ':'gyu','ぎょ':'gyo',
 'じゃ':'ja','じゅ':'ju','じょ':'jo','びゃ':'bya','びゅ':'byu','びょ':'byo',
 'ぴゃ':'pya','ぴゅ':'pyu','ぴょ':'pyo','ふぁ':'fa','ふぃ':'fi','ふぇ':'fe','ふぉ':'fo',
 'うぃ':'wi','うぇ':'we','うぉ':'wo','ゔぁ':'va','ゔぃ':'vi','ゔぇ':'ve','ゔぉ':'vo','ゔ':'bu',
 'てぃ':'ti','でぃ':'di','とぅ':'tu','どぅ':'du','ちぇ':'che','しぇ':'she','じぇ':'je',
}
def kana_to_romaji(kana):
    out, i = [], 0
    while i < len(kana):
        if kana[i] == 'っ':
            # 次の子音を重ねる
            j = i + 1
            nxt = DIGRAPH.get(kana[j:j+2]) or BASE.get(kana[j:j+1], '') if j < len(kana) else ''
            out.append(nxt[0] if nxt and nxt[0] not in 'aiueo' else '')
            i += 1
            continue
        two = kana[i:i+2]
        if two in DIGRAPH:
            out.append(DIGRAPH[two]); i += 2; continue
        out.append(BASE.get(kana[i], '')); i += 1
    r = ''.join(out)
    # 長音の簡略化 (とうきょう → tokyo)
    r = re.sub(r'ou', 'o', r)
    r = re.sub(r'uu', 'u', r)
    r = re.sub(r'([aiueo])\1', r'\1', r)
    return r.capitalize()

# ---- 全国の検索用最小インデックス (stations_jp.js) ----
# 目的地の「全国検索」用。名前・かな・ローマ字・座標のみで路線情報は持たない。
# stations.js とは別ファイルにして遅延ロードし、初回ロードを軽く保つ。
all_st = [s for s in json.load(open('/tmp/sdb_station.json')) if not s['closed']]
jp_seen = {}
for s in all_st:
    if s['name'] in jp_seen:
        continue
    jp_seen[s['name']] = {
        'name': s['name'],
        'k': s.get('name_kana') or '',
        'r': kana_to_romaji(s['name_kana']) if s.get('name_kana') else '',
        'lat': round(s['lat'], 5),
        'lng': round(s['lng'], 5),
    }
jp_arr = list(jp_seen.values())
jp_body = ('// 全国の駅 検索用最小インデックス (遅延ロード)。出典/再生成は stations.js と同じ。\n'
           '"use strict";\nwindow.STATIONS_JP = '
           + json.dumps(jp_arr, ensure_ascii=False, separators=(',', ':')) + ';\n')
open('/home/user/test_fable/stations_jp.js', 'w').write(jp_body)
print('全国インデックス:', len(jp_arr), '駅 /', len(jp_body.encode()) // 1024, 'KB')

# ---- 路線詳細 (駅順・公式カラー) を取得 ----
order, meta = {}, {}
for n, code in enumerate(sorted(line_codes)):
    url = f'https://raw.githubusercontent.com/Seo-4d696b75/station_database/main/out/main/line/{code}.json'
    for attempt in range(3):
        try:
            raw = subprocess.run(['curl','-s','-m','20',url], capture_output=True, check=True).stdout
            d = json.loads(raw)
            break
        except Exception as e:
            time.sleep(2)
    else:
        print('SKIP', code); continue
    name = d['name']
    order[name] = [s['name'] for s in d.get('station_list', []) if not s.get('closed')]
    kana = ''
    meta[name] = {'c': d.get('color') or '', 'k': d.get('name_kana') or ''}
    if n % 30 == 0: print(f'{n}/{len(line_codes)} lines...')

# ---- 駅リスト生成 ----
out = []
for s in stations:
    lnames = sorted({lines_all[c]['name'] for c in s['lines'] if c in line_codes})
    if not lnames: continue
    out.append({
        'name': s['name'],
        'nameKana': s.get('name_kana') or '',
        'r': kana_to_romaji(s['name_kana']) if s.get('name_kana') else '',
        'lat': round(s['lat'], 5),
        'lng': round(s['lng'], 5),
        'lines': lnames,
    })

header = '''// 役割: 首都圏+関西の駅データ (公式オープンデータ由来)
// 出典: station_database (https://github.com/Seo-4d696b75/station_database)
//   原典は国土数値情報・駅データ.jp。座標は公式値
// 再生成: tools/build_stations.py
"use strict";

'''
body = (header
  + 'window.STATIONS = ' + json.dumps(out, ensure_ascii=False, separators=(',',':')) + ';\n\n'
  + '// 路線ごとの正確な駅順 (路線図表示用)\n'
  + 'window.LINE_ORDER = ' + json.dumps(order, ensure_ascii=False, separators=(',',':')) + ';\n\n'
  + '// 路線の公式カラーと英語名\n'
  + 'window.LINE_META = ' + json.dumps(meta, ensure_ascii=False, separators=(',',':')) + ';\n')
open('/home/user/test_fable/stations.js','w').write(body)
print('駅:', len(out), '路線:', len(meta))
print('サイズ:', len(body.encode())//1024, 'KB')
print('サンプル:', json.dumps(out[0], ensure_ascii=False))
print('御堂筋線:', meta.get('大阪メトロ御堂筋線') or [k for k in meta if '御堂筋' in k])
