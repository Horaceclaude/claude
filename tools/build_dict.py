"""Build the word list the site uses: data/dict.json.

Inputs
  jamdict.db      JMdict + KANJIDIC2 as SQLite, from the jamdict-data package on PyPI (unpack jamdict.db.xz)
  levels.json     JLPT level of each word, made by tools/build_levels.py
  wn-data-jpn.tab Japanese WordNet (NICT), from https://github.com/omwn/omw-data (wns/jpn), for synonyms
  look-alike.js   dist/data/look-alike.data.js of the npm package @johnmorrisdotca/jisho (Yencken; KanjiVG)

Usage: python3 tools/build_dict.py jamdict.db levels.json wn-data-jpn.tab look-alike.data.js data/dict.json

Each entry: [kanji forms, kana forms, gloss, part of speech, usually-kana flag, frequency rank,
             JMdict entry number, JLPT level (5..1, 0 = beyond N1), inflection class, level basis,
             reading split per character ("かん|きゃく", empty when it cannot be split),
             near-synonyms ("|"-separated), word formation ("S観" = base + suffix 観, "P未" = prefix 未 + base),
             textbook lessons ("M12 G5": みんなの日本語 lesson 12, GENKI I lesson 5)]
Top level: kanjiAlt (kanji sharing a reading), kanjiLook (kanji that look alike), kanjiRead (on-readings of each kanji),
           compounds (base word -> words formed from it with a prefix or suffix).
"""
import sqlite3, json, sys, re, csv, os, collections

src, levels_path, wn_path, look_path, out = sys.argv[1:6]
db = sqlite3.connect('file:%s?mode=ro' % src, uri=True)
c = db.cursor()
COMMON = {'news1', 'ichi1', 'spec1', 'spec2', 'gai1'}

# ---- JLPT levels and how each was decided
LEVELS = {int(k): v for k, v in json.load(open(levels_path, encoding='utf-8')).items()}
BASIS = {'agree': 'a', 'list': 'l', 'mixed': 'm', 'exam': 'x', 'est': 'e', 'beyond': 'b'}

kanji = collections.defaultdict(list)
for kid, idseq, text in c.execute('select ID, idseq, text from Kanji order by ID'): kanji[idseq].append((kid, text))
kana = collections.defaultdict(list)
for kid, idseq, text, nok in c.execute('select ID, idseq, text, nokanji from Kana order by ID'): kana[idseq].append((kid, text, nok))
kjp = collections.defaultdict(set)
for kid, t in c.execute('select kid, text from KJP'): kjp[kid].add(t)
knp = collections.defaultdict(set)
for kid, t in c.execute('select kid, text from KNP'): knp[kid].add(t)
kji = collections.defaultdict(set)
for kid, t in c.execute('select kid, text from KJI'): kji[kid].add(t)
kni = collections.defaultdict(set)
for kid, t in c.execute('select kid, text from KNI'): kni[kid].add(t)
senses = collections.defaultdict(list)
for sid, idseq in c.execute('select ID, idseq from Sense order by ID'): senses[idseq].append(sid)
gloss = collections.defaultdict(list)
for sid, lang, text in c.execute('select sid, lang, text from SenseGloss order by rowid'):
    if lang in ('eng', '', None): gloss[sid].append(text)
misc = collections.defaultdict(set)
for sid, t in c.execute('select sid, text from misc'): misc[sid].add(t)
pos = collections.defaultdict(list)
for sid, t in c.execute('select sid, text from pos'): pos[sid].append(t)


def rank(pris):
    r = 60
    for p in pris:
        m = re.match(r'nf(\d\d)$', p)
        if m: r = min(r, int(m.group(1)))
    if r == 60:
        if 'ichi1' in pris: r = 30
        elif 'news1' in pris or 'spec1' in pris: r = 40
        elif 'gai1' in pris or 'spec2' in pris: r = 50
    elif 'ichi1' in pris: r = max(1, r - 2)
    return r


def short_pos(plist):
    """Reduce JMdict's long part-of-speech labels to a short learner-facing word."""
    suru = any('aux. verb suru' in p for p in plist)
    for p in plist:
        pl = p.lower()
        if pl.startswith(('ichidan verb', 'godan verb', 'suru verb', 'kuru verb', 'nidan verb', 'yodan verb', 'irregular nu verb', 'irregular ru verb')): return 'verb'
        if pl.startswith('adjective (keiyoushi)'): return 'i-adjective'
        if pl.startswith('adjectival nouns'): return 'na-adjective'
        if pl.startswith('noun'): return 'noun, suru verb' if suru else 'noun'
        if pl.startswith('adverb'): return 'adverb'
        if pl.startswith('expressions'): return 'expression'
        if pl == 'particle': return 'particle'
        if pl.startswith('interjection'): return 'interjection'
        if pl.startswith('pronoun'): return 'pronoun'
        if pl.startswith('counter'): return 'counter'
        if pl.startswith('conjunction'): return 'conjunction'
        if pl.startswith('pre-noun adjectival'): return 'adjectival'
        if pl.startswith('auxiliary'): return 'auxiliary'
        if pl.startswith('prefix'): return 'prefix'
        if pl.startswith('suffix'): return 'suffix'
        if pl.startswith('numeric'): return 'number'
    return ''


GODAN = {'ku': 'k', 'gu': 'g', 'su': 's', 'tsu': 't', 'nu': 'n', 'bu': 'b', 'mu': 'm', 'ru': 'r', 'u': 'u'}


def infl_class(plist):
    """Inflection class, used to build practice questions with matching word forms."""
    suru = any('aux. verb suru' in p for p in plist)
    for p in plist:
        if p == 'Ichidan verb' or p.startswith('Ichidan verb - kureru'): return 'v1'
        m = re.match(r"Godan verb with '(\w+)' ending$", p)
        if m: return 'v5' + GODAN.get(m.group(1), 'x')
        if p.startswith(('Godan verb', 'Kuru verb', 'suru verb', 'Ichidan verb', 'irregular')): return 'vx'
        if p == 'adjective (keiyoushi)': return 'adj-i'
        if p.startswith('adjective (keiyoushi)'): return 'adjx'
        if p.startswith('adjectival nouns'): return 'adj-na'
        if p.startswith('noun'): return 'vs' if suru else 'n'
        if p.startswith('adverb'): return 'adv'
    return ''


entries, full_gloss, first_gloss = [], {}, {}
for (idseq,) in c.execute('select idseq from Entry order by idseq').fetchall():
    kj, kn = kanji.get(idseq, []), kana.get(idseq, [])
    pris = set()
    for kid, _ in kj: pris |= kjp.get(kid, set())
    for kid, _, _ in kn: pris |= knp.get(kid, set())
    if idseq not in LEVELS: continue
    level, lbasis = LEVELS[idseq][0], LEVELS[idseq][1]
    textbook = LEVELS[idseq][2] if len(LEVELS[idseq]) > 2 else ''
    sids = senses.get(idseq, [])
    if not sids: continue

    def keep_k(kid): return not any(('irregular' in t) or ('out-dated' in t) or ('rarely' in t) or ('search-only' in t) for t in kji.get(kid, ()))
    def keep_r(kid): return not any(('irregular' in t) or ('out-dated' in t) or ('obsolete' in t) or ('search-only' in t) for t in kni.get(kid, ()))
    kforms = [t for kid, t in kj if keep_k(kid)] or [t for _, t in kj]
    kcommon = [t for kid, t in kj if kjp.get(kid, set()) & COMMON and t in kforms]
    kforms = kcommon + [t for t in kforms if t not in kcommon]
    rforms = [t for kid, t, _ in kn if keep_r(kid)] or [t for _, t, _ in kn]
    rcommon = [t for kid, t, _ in kn if knp.get(kid, set()) & COMMON and t in rforms]
    rforms = rcommon + [t for t in rforms if t not in rcommon]
    kforms, rforms = kforms[:3], rforms[:2]
    uk = any('usually written using kana alone' in t for t in misc.get(sids[0], ()))
    gl = []
    for g in gloss.get(sids[0], [])[:3]:
        if g not in gl: gl.append(g)
    for sid in sids[1:3]:
        for g in gloss.get(sid, [])[:1]:
            if g not in gl: gl.append(g)
    text = '; '.join(gl)
    if len(text) > 90: text = '; '.join(gl[:2])
    if len(text) > 90: text = gl[0][:90]
    if not text: continue
    plist = pos.get(sids[0], [])
    entries.append(['|'.join(kforms), '|'.join(rforms), text, short_pos(plist), (1 if uk else 0),
                    rank(pris) if pris & COMMON else 55, idseq, level, infl_class(plist), BASIS[lbasis], '', '', '', textbook])
    full_gloss[idseq] = [g for sid in sids[:3] for g in gloss.get(sid, [])]
    first_gloss[idseq] = gloss.get(sids[0], [])

entries.sort(key=lambda e: (e[5], e[1]))

# ---- kanji that share an on-reading (for "which kanji is right" practice questions)
used = set(ch for e in entries for ch in e[0] if '一' <= ch <= '鿿')
chars = {}
for cid, lit, grade, freq in c.execute('select ID, literal, grade, freq from character'):
    try: g = int(grade) if grade else 99
    except ValueError: g = 99
    try: f = int(freq) if freq else 9999
    except ValueError: f = 9999
    chars[cid] = (lit, g, f)
group_char = dict(c.execute('select ID, cid from rm_group'))
on = collections.defaultdict(set)      # reading -> kanji
kan_on = collections.defaultdict(set)  # kanji -> readings
for gid, value in c.execute("select gid, value from reading where r_type='ja_on'"):
    cid = group_char.get(gid)
    if cid not in chars: continue
    lit, g, f = chars[cid]
    if g > 8: continue                 # joyo kanji only
    on[value].add((f, lit)); kan_on[lit].add(value)
alt = {}
for k in sorted(used):
    cands = {}
    for r in kan_on.get(k, ()):
        for f, lit in on[r]:
            if lit != k: cands[lit] = min(cands.get(lit, 9999), f)
    if cands: alt[k] = ''.join(l for l, _ in sorted(cands.items(), key=lambda x: x[1])[:8])

# ---- readings of each kanji (KANJIDIC2), and each word's reading split per character
def hira(s): return ''.join(chr(ord(ch) - 0x60) if 'ァ' <= ch <= 'ヶ' else ch for ch in s)
IS_K = lambda ch: '一' <= ch <= '鿿' or ch == '々'
lit_of = {cid: lit for cid, lit in c.execute('select ID, literal from character')}
group_char = dict(c.execute('select ID, cid from rm_group'))
kread = collections.defaultdict(list)          # kanji -> readings, on (hiragana) first, then kun stems
for gid, rtype, value in c.execute("select gid, r_type, value from reading where r_type in ('ja_on', 'ja_kun') order by rowid"):
    lit = lit_of.get(group_char.get(gid))
    if not lit: continue
    v = hira(value.replace('-', '').split('.')[0]) if rtype == 'ja_kun' else hira(value)
    if v and v not in kread[lit]: kread[lit].append(v)
VOICE = dict(zip('かきくけこさしすせそたちつてとはひふへほ', 'がぎぐげござじずぜぞだぢづでどばびぶべぼ'))
HPAN = dict(zip('はひふへほ', 'ぱぴぷぺぽ'))
def variants(r, first, last):
    out = {r}
    if not first and r[0] in VOICE: out.add(VOICE[r[0]] + r[1:])            # rendaku: 人々 ひと+びと
    if not first and r[0] in HPAN: out.add(HPAN[r[0]] + r[1:])              # 一本 いっ+ぽん
    if not last and len(r) > 1 and r[-1] in 'つくちき': out.add(r[:-1] + 'っ')  # 学校 がっ+こう
    if r.endswith('う') and len(r) > 1: out.add(r[:-1] + 'ゅう') if False else None
    return out
def split_reading(word, reading):
    chars, res = list(word), []
    def go(i, pos, prev):
        if i == len(chars): return pos == len(reading)
        ch = chars[i]
        if not IS_K(ch):
            if reading.startswith(hira(ch), pos):
                res.append(hira(ch)); ok = go(i + 1, pos + 1, None)
                if ok: return True
                res.pop()
            return False
        cands = kread.get(prev if ch == '々' and prev else ch, [])
        for r in sorted({v for r0 in cands for v in variants(r0, i == 0, i == len(chars) - 1)}, key=len, reverse=True):
            if reading.startswith(r, pos):
                res.append(r)
                if go(i + 1, pos + len(r), ch if ch != '々' else prev): return True
                res.pop()
        return False
    return '|'.join(res) if go(0, 0, None) else ''

for e in entries:
    kj = e[0].split('|') if e[0] else []
    if kj and not e[4]:
        e[10] = split_reading(kj[0], hira(e[1].split('|')[0]))
used = set(ch for e in entries for ch in e[0] if IS_K(ch))
kon = collections.defaultdict(list)            # on-readings only: the test's wrong readings swap these, not native ones
for gid, value in c.execute("select gid, value from reading where r_type = 'ja_on' order by rowid"):
    lit = lit_of.get(group_char.get(gid))
    if lit and hira(value) not in kon[lit]: kon[lit].append(hira(value))
kanji_read = {k: kon[k][:6] for k in sorted(used) if kon.get(k)}

# ---- kanji that look alike (score >= 70 by strokes or parts, or by shape)
look = collections.defaultdict(list)
src_js = open(look_path, encoding='utf-8').read()
for m in re.finditer(r'\["(.)(.)",\s*(\d+),\s*(\d+)(?:,\s*(\d+))?\]', src_js):
    a, b, s1, s2, s3 = m.group(1), m.group(2), int(m.group(3)), int(m.group(4)), int(m.group(5) or 0)
    score = max(s1, s2, s3)
    if score < 70: continue
    look[a].append((score, b)); look[b].append((score, a))
kanji_look = {k: ''.join(x for _, x in sorted(v, reverse=True)[:6]) for k, v in look.items() if k in used}

# ---- near-synonyms: share a Japanese WordNet synset AND an English meaning word, and inflect the same way
STOP = set('to a an the of be one s or and in on at as by for with from into something someone some thing etc e g one\'s oneself up out off over not no'.split())
def toks(glosses):
    out = set()
    for g in glosses:
        g = re.sub(r'\([^)]*\)', ' ', g.lower())
        for t in re.findall(r"[a-z]+", g):
            if t in STOP or len(t) < 3: continue
            for suf in ('ingly', 'edly', 'ness', 'ally', 'ing', 'ity', 'ed', 'ly', 'es', 's'):
                if t.endswith(suf) and len(t) - len(suf) >= 4: t = t[:-len(suf)]; break
            out.add(t)
    return out
lemma_syn = collections.defaultdict(set); syn_lem = collections.defaultdict(set)
for line in open(wn_path, encoding='utf-8'):
    p = line.rstrip('\n').split('\t')
    if len(p) >= 3 and p[1].endswith('lemma') and '+' not in p[2]:
        lemma_syn[p[2]].add(p[0]); syn_lem[p[0]].add(p[2])
by_form = collections.defaultdict(list)
for k, e in enumerate(entries):
    for t in (e[0].split('|') if e[0] else []) + e[1].split('|'): by_form[t].append(k)
def primary(e): return e[1].split('|')[0] if (e[4] or not e[0]) else e[0].split('|')[0]
TOK = {e[6]: toks(full_gloss[e[6]]) for e in entries}
TOK1 = {e[6]: toks(first_gloss[e[6]]) for e in entries}
nsyn = 0
for k, e in enumerate(entries):
    if not e[7] or e[8] in ('', 'vx', 'adjx'): continue
    forms = (e[0].split('|') if e[0] else []) + e[1].split('|')
    synsets = set()
    for f in forms: synsets |= lemma_syn.get(f, set())
    if not synsets: continue
    cand = collections.Counter()
    for sid in synsets:
        if len(syn_lem[sid]) > 40: continue
        for lem in syn_lem[sid]:
            for j in by_form.get(lem, []): cand[j] += 1
    scored = []
    for j, shared in cand.items():
        o = entries[j]
        if o[6] == e[6] or o[8] != e[8] or not o[7] or o[7] < e[7] - 1: continue   # same inflection, not much harder
        if primary(o) in forms or set(primary(o)) & set(primary(e)) - set('ぁ-んァ-ン'): pass
        overlap = TOK[e[6]] & TOK[o[6]]
        if not (TOK1[e[6]] & TOK1[o[6]]): continue          # the main meanings must share a word
        if len(overlap) < 2 and shared < 2: continue         # and more than one weak link
        scored.append((len(overlap) * 2 + shared - o[5] / 40, primary(o)))
    best = [w for _, w in sorted(scored, reverse=True) if w != primary(e)]
    best = list(dict.fromkeys(best))[:3]
    if best: e[11] = '|'.join(best); nsyn += 1

# ---- word formation: words made of a base word plus a common prefix or suffix
SUFFIX = list('的性化感観力率式制費料代賃家者員界型風流権法論説製産層帯度状類識念察視')
SUFFIX += ['向き', '向け', '明け', '気味', 'がち', 'だらけ', 'っぽい', '済み', '込み', '付き', '連れ', '沿い', '離れ', '漬け', '始め', '切れ', '過ぎ']
PREFIX = list('不非未無再元新旧高低超総全半副準初最諸各両真反逆同現来翌昨毎')
prim_index = {primary(e): k for k, e in enumerate(entries)}
compounds = collections.defaultdict(list)
for k, e in enumerate(entries):
    w = primary(e)
    if not e[0] or len(w) < 3: continue
    hit = None
    for suf in sorted(SUFFIX, key=len, reverse=True):
        if w.endswith(suf) and w[:-len(suf)] in prim_index and len(w) - len(suf) >= 2:
            hit = ('S', suf, w[:-len(suf)]); break
    if not hit:
        for pre in PREFIX:
            if w.startswith(pre) and w[len(pre):] in prim_index and len(w) - len(pre) >= 2:
                hit = ('P', pre, w[len(pre):]); break
    if hit:
        e[12] = hit[0] + hit[1]
        compounds[hit[2]].append((e[5], w))
compounds = {b: [w for _, w in sorted(v)[:4]] for b, v in compounds.items()}
print('reading splits', sum(1 for e in entries if e[10]), '| look-alike kanji', len(kanji_look), '| words with synonyms', nsyn,
      '| formed words', sum(1 for e in entries if e[12]), '| bases', len(compounds))

meta = dict(c.execute('select key, value from meta').fetchall())
json.dump({'source': 'JMdict %s and KANJIDIC2 (EDRDG); JLPT levels: see tools/build_levels.py; synonyms: Japanese WordNet (NICT); look-alike kanji: Yencken, KanjiVG' % meta.get('jmdict.version', ''),
           'fields': ['kanji', 'kana', 'gloss', 'pos', 'usuallyKana', 'rank', 'id', 'jlpt', 'class', 'basis', 'split', 'synonyms', 'formation', 'textbook'],
           'entries': entries, 'kanjiAlt': alt, 'kanjiLook': kanji_look, 'kanjiRead': kanji_read, 'compounds': compounds},
          open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
lv = collections.Counter(e[7] for e in entries)
print('entries', len(entries), 'jlpt', dict(sorted(lv.items())), 'kanjiAlt', len(alt), 'classes', collections.Counter(e[8] for e in entries).most_common(8))
