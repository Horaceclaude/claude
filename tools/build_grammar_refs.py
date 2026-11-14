"""Where the well-known textbooks teach each grammar point, and the level that follows from them.

Sources (only which book and lesson teaches which pattern is used; no explanation or example is copied):
  みんなの日本語 初級 I (lessons 1-25, ~N5) and II (26-50, ~N4), GENKI I (lessons 1-12, ~N5) and II (13-23, ~N4):
      the lesson of each core pattern, listed below from the books' tables of contents
  Tobira: Gateway to Advanced Japanese (~N3-N2): the grammar index of SethClydesdale/tobira-study-resources
  A Dictionary of Basic / Intermediate / Advanced Japanese Grammar (Makino & Tsutsui): which volume has the entry
      (基本 ~N5-N4, 中級 ~N3-N2, 上級 ~N1), from the DoJG dictionary of aiko-tanaka/Grammar-Dictionaries (535 entries)

Level: the OpenJLPT level stands unless the textbooks disagree with it: when みんなの日本語 and GENKI (I = N5, II = N4)
both put a pattern at a level other than the listed one, it takes the textbooks' level nearest to the list; for patterns
neither book teaches, when the DoJG volume and Tobira both exclude the listed level, the nearest level both allow.

  中級日本語カルテット Quartet I / II (~N3 / ~N2): the official grammar index QUARTET_grammar_index.xlsx (quartet.japantimes.co.jp)
  JLPT Sensei (jlptsensei.com): its N5-N1 grammar lists, a second list beside OpenJLPT

Usage: python3 tools/build_grammar_refs.py data/grammar.json TOBIRA_INDEX_HTML DOJG_TERM_BANK_JSON QUARTET_GRAMMAR_XLSX
       JLPTSENSEI_HTML_DIR data/grammar-refs.json
"""
import sys, re, json, collections

grammar_path, tobira_path, dojg_path, quartet_path, sensei_dir, out_path = sys.argv[1:7]
G = json.load(open(grammar_path, encoding='utf-8'))['points']

# [みんなの日本語 lesson, GENKI lesson] (0 = not taught as a lesson point)
BOOKS = {
    'desu': [1, 1], 'de-wa-arimasen-ja-nai': [1, 2], 'deshita': [12, 4], 'masu': [4, 3], 'masen': [4, 3], 'mashita': [4, 4],
    'masen-deshita': [4, 4], 'mashou': [6, 5], 'masen-ka': [6, 3], 'tai': [13, 11], 'ni-iku': [13, 0], 'te-kudasai': [14, 6],
    'te-iru': [14, 7], 'te-mo-ii': [15, 6], 'te-wa-ikenai': [15, 6], 'te-kara': [16, 17], 'nai': [17, 8],
    'nakereba-naranai-nakute-wa-ikenai': [17, 12], 'nakute-mo-ii': [17, 17], 'koto-ga-dekiru': [18, 0], 'mae-ni': [18, 17],
    'ta': [19, 9], 'ta-koto-ga-aru': [19, 11], 'tari-tari-suru': [19, 11], 'ku-naru-ni-naru': [19, 10], 'to-omou': [21, 8],
    'deshou': [21, 12], 'toki': [23, 16], 'te-ageru': [24, 16], 'te-kureru': [24, 16], 'te-morau': [24, 16], 'tara': [25, 17],
    'te-mo-de-mo': [25, 23], 'n-desu-no-desu': [26, 12], 'eru-rareru-potential': [27, 13], 'nagara': [28, 18],
    'te-shimau-chau': [29, 18], 'te-aru': [30, 21], 'te-oku': [30, 15], 'ou-you': [31, 15], 'you-to-omou': [31, 15],
    'tsumori': [31, 10], 'hou-ga-ii': [32, 12], 'kamo-shirenai': [32, 14], 'e-ro': [33, 0], 'na-prohibition': [33, 0],
    'ba': [35, 22], 'nara': [35, 13], 'reru-rareru-passive': [37, 21], 'te-miru': [40, 13], 'sou-da-appearance': [43, 13],
    'sugiru': [44, 12], 'sou-da-hearsay': [47, 17], 'seru-saseru': [48, 22], 'mitai': [0, 17], 'te-hoshii': [0, 21],
    'hajimeru-owaru-tsuzukeru': [0, 18], 'ku-suru-ni-suru': [0, 21], 'koto-ni-suru': [0, 23], 'koto-ni-shite-iru': [0, 23],
    'kata': [0, 23], 'tara-dou': [0, 14], 'ba-yokatta': [0, 18], 'kurai-gurai': [11, 10], 'tame-ni': [42, 0], 'shika-nai': [27, 14]}

def keys(pattern):
    """The bare forms of a pattern: 〜てはいけない -> {てはいけない}; Noun{で／から}できる -> {でできる, からできる}."""
    p = re.sub(r'（[^）]*）|\([^)]*\)|[〜～＋+]|[A-Za-z\-]+|[0-9]+\.|[;；:：\s.,]', '', pattern)
    out = set()
    for alt in re.split(r'[/／]| / ', p):
        m = re.search(r'\{([^}]*)\}', alt)
        if m:
            for x in re.split(r'[/／]', m.group(1)): out.add(alt.replace(m.group(0), x))
        else: out.add(alt)
    return {k.replace('{', '').replace('}', '') for k in out if 1 <= len(k.replace('{', '').replace('}', '')) <= 12}

GK = {g: keys(v[0]) for g, v in G.items()}
by_key = collections.defaultdict(set)
for g, ks in GK.items():
    for k in ks: by_key[k].add(g)

# Tobira grammar index
s = open(tobira_path, encoding='utf-8').read()
s = re.sub(r'<script.*?</script>', '', s, flags=re.S); s = re.sub(r'<rt>.*?</rt>', '', s, flags=re.S)
tobira = collections.defaultdict(set)
strong = collections.defaultdict(bool)                  # matched on a distinctive pattern (3 characters or more)
ch = 0
for h, t in re.findall(r'<(h[23])[^>]*>(.*?)</\1>', s, flags=re.S):
    t = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', t)).strip()
    m = re.match(r'第(\d+)課', t)
    if h == 'h2' and m: ch = int(m.group(1))
    elif h == 'h3' and ch and re.match(r'\d+\.', t):
        for k in keys(t):
            if len(k) < 2: continue                     # に, で alone match too much
            for g in by_key.get(k, ()): tobira[g].add(ch); strong[g] = strong[g] or len(k) >= 3

# DoJG volumes
VOL = {'基本': 'Basic', '中級': 'Intermediate', '上級': 'Advanced'}
dojg = collections.defaultdict(set)
for e in json.load(open(dojg_path, encoding='utf-8')):
    m = re.search(r'文法項目 \| (.*?) \| (基本|中級|上級)', ''.join(x if isinstance(x, str) else '' for x in e[5]))
    if not m: continue
    for k in keys(e[0]) | keys(m.group(1)):
        if len(k) < 2: continue
        for g in by_key.get(k, ()): dojg[g].add(VOL[m.group(2)])

# Quartet grammar index: pattern, lesson (L1-6 = Quartet I, L7-12 = Quartet II)
import openpyxl, glob, os
quartet = collections.defaultdict(set)
for row in openpyxl.load_workbook(quartet_path, read_only=True).worksheets[1].iter_rows(values_only=True):
    cells = [str(x) for x in row if x is not None]
    les = next((x for x in cells if re.match(r'L\d+-\d+', x)), None)
    if not les: continue
    pat = cells[cells.index(les) - 1]
    for k in keys(pat):
        if len(k) < 2: continue
        for g in by_key.get(k, ()): quartet[g].add(int(re.match(r'L(\d+)', les).group(1))); strong[g] = strong[g] or len(k) >= 3
# JLPT Sensei: level of each pattern
sensei = collections.defaultdict(set)
for fn in glob.glob(os.path.join(sensei_dir, 'n*_*.html')):
    lv = int(os.path.basename(fn)[1])
    for pat in re.findall(r'class="jl-link jp"[^>]*>([^<]+)</a>', open(fn, encoding='utf-8').read()):
        for k in keys(pat.replace('・', '/')):
            if len(k) < 2 and len(pat) > 1: continue
            for g in by_key.get(k, ()): sensei[g].add(lv)
BAND = {'Basic': {5, 4}, 'Intermediate': {3, 2}, 'Advanced': {1}}
out, changed = {}, []
for g, v in G.items():
    lv, r = v[1], {}
    b = BOOKS.get(g)
    if b:
        if b[0]: r['minna'] = b[0]
        if b[1]: r['genki'] = b[1]
    if tobira.get(g): r['tobira'] = sorted(tobira[g])
    if quartet.get(g): r['quartet'] = sorted(quartet[g])
    if sensei.get(g): r['sensei'] = sorted(sensei[g], reverse=True)
    if dojg.get(g): r['dojg'] = sorted(dojg[g])
    new = lv
    if b:                                      # the textbooks' levels: みんなの日本語 1-25 / GENKI 1-12 = N5, later lessons = N4
        books = {5 if n <= (25 if i == 0 else 12) else 4 for i, n in enumerate(b) if n}
        if lv not in books: new = min(books, key=lambda x: abs(x - lv))
    elif r.get('quartet') and strong[g] and lv not in {3 if min(r['quartet']) <= 6 else 2} and (not r.get('sensei') or lv not in r['sensei']):
        # Quartet teaches it (I: N3, II: N2) and JLPT Sensei does not support the listed level either: one level toward Quartet
        q = 3 if min(r['quartet']) <= 6 else 2
        new = lv + (1 if q > lv else -1)
    elif r.get('dojg') and r.get('tobira'):    # both the grammar dictionary and Tobira exclude the listed level
        dband, tband = set().union(*(BAND[x] for x in r['dojg'])), {3, 2}
        both = dband & tband
        if both and strong[g] and lv not in dband and lv not in tband:
            near = min(both, key=lambda x: abs(x - lv))
            new = lv + (1 if near > lv else -1)               # one level at most
    if new != lv: r['lists'] = lv; changed.append((g, v[0], lv, new))
    r['level'] = new
    out[g] = r
json.dump(out, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
n = collections.Counter(k for r in out.values() for k in r if k in ('minna', 'genki', 'tobira', 'dojg', 'quartet', 'sensei'))
agree = sum(1 for g, r in out.items() if r.get('sensei') and G[g][1] in r['sensei'])
print('OpenJLPT and JLPT Sensei agree on', agree, 'of', sum(1 for r in out.values() if r.get('sensei')), 'shared points', file=sys.stderr)
print('grammar points', len(out), '| with textbook references', sum(1 for r in out.values() if len(r) > 1), dict(n), file=sys.stderr)
print('levels changed by the textbooks', len(changed), file=sys.stderr)
for c in changed: print('   %-36s %-28s N%d -> N%d' % c, file=sys.stderr)
