"""Build the word list the site uses: data/dict.json.

Inputs
  jamdict.db   JMdict + KANJIDIC2 as SQLite, from the jamdict-data package on PyPI (unpack jamdict.db.xz)
  jlpt_dir     the original_data folder of https://github.com/stephenmk/yomitan-jlpt-vocab
               (Jonathan Waller's JLPT lists matched to JMdict entry numbers)

Usage: python3 tools/build_dict.py path/to/jamdict.db path/to/original_data data/dict.json

Each entry: [kanji forms, kana forms, gloss, part of speech, usually-kana flag, frequency rank,
             JMdict entry number, JLPT level (5..1, 0 = not on the lists), inflection class]
"""
import sqlite3, json, sys, re, csv, os, collections

src, jlpt_dir, out = sys.argv[1], sys.argv[2], sys.argv[3]
db = sqlite3.connect('file:%s?mode=ro' % src, uri=True)
c = db.cursor()
COMMON = {'news1', 'ichi1', 'spec1', 'spec2', 'gai1'}

# ---- JLPT levels by JMdict entry number (keep the easiest level a word is listed at)
jlpt = {}
for n in (5, 4, 3, 2, 1):
    with open(os.path.join(jlpt_dir, 'n%d.csv' % n), encoding='utf-8') as f:
        for row in csv.DictReader(f):
            try: seq = int(row['jmdict_seq'])
            except (ValueError, KeyError): continue
            jlpt.setdefault(seq, n)

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


entries = []
for (idseq,) in c.execute('select idseq from Entry order by idseq').fetchall():
    kj, kn = kanji.get(idseq, []), kana.get(idseq, [])
    pris = set()
    for kid, _ in kj: pris |= kjp.get(kid, set())
    for kid, _, _ in kn: pris |= knp.get(kid, set())
    level = jlpt.get(idseq, 0)
    if not (pris & COMMON) and not level: continue
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
                    rank(pris) if pris & COMMON else 55, idseq, level, infl_class(plist)])

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

meta = dict(c.execute('select key, value from meta').fetchall())
json.dump({'source': 'JMdict %s and KANJIDIC2 (EDRDG); JLPT levels from Jonathan Waller\'s lists (tanos.co.uk) via stephenmk/yomitan-jlpt-vocab' % meta.get('jmdict.version', ''),
           'fields': ['kanji', 'kana', 'gloss', 'pos', 'usuallyKana', 'rank', 'id', 'jlpt', 'class'],
           'entries': entries, 'kanjiAlt': alt},
          open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
lv = collections.Counter(e[7] for e in entries)
print('entries', len(entries), 'jlpt', dict(sorted(lv.items())), 'kanjiAlt', len(alt), 'classes', collections.Counter(e[8] for e in entries).most_common(8))
