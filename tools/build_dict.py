"""Build a compact common-word dictionary (JMdict subset) for the site.
Input: jamdict.db (JMdict via the jamdict-data PyPI package, unpacked). Output: data/dict.json

Usage: python3 tools/build_dict.py path/to/jamdict.db data/dict.json
"""
import sqlite3, json, sys, re, collections
src, out = sys.argv[1], sys.argv[2]
db = sqlite3.connect('file:%s?mode=ro' % src, uri=True)
c = db.cursor()
COMMON = {'news1', 'ichi1', 'spec1', 'spec2', 'gai1'}

kanji = collections.defaultdict(list)      # idseq -> [(kid, text)]
for kid, idseq, text in c.execute('select ID, idseq, text from Kanji order by ID'): kanji[idseq].append((kid, text))
kana = collections.defaultdict(list)       # idseq -> [(kid, text, nokanji)]
for kid, idseq, text, nok in c.execute('select ID, idseq, text, nokanji from Kana order by ID'): kana[idseq].append((kid, text, nok))
kjp = collections.defaultdict(set)
for kid, t in c.execute('select kid, text from KJP'): kjp[kid].add(t)
knp = collections.defaultdict(set)
for kid, t in c.execute('select kid, text from KNP'): knp[kid].add(t)
kji = collections.defaultdict(set)
for kid, t in c.execute('select kid, text from KJI'): kji[kid].add(t)
kni = collections.defaultdict(set)
for kid, t in c.execute('select kid, text from KNI'): kni[kid].add(t)
senses = collections.defaultdict(list)     # idseq -> [sid]
for sid, idseq in c.execute('select ID, idseq from Sense order by ID'): senses[idseq].append(sid)
gloss = collections.defaultdict(list)
for sid, lang, text in c.execute("select sid, lang, text from SenseGloss order by rowid"):
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

entries = []
for (idseq,) in c.execute('select idseq from Entry order by idseq').fetchall():
    kj, kn = kanji.get(idseq, []), kana.get(idseq, [])
    pris = set()
    for kid, _ in kj: pris |= kjp.get(kid, set())
    for kid, _, _ in kn: pris |= knp.get(kid, set())
    if not (pris & COMMON): continue
    sids = senses.get(idseq, [])
    if not sids: continue
    # spellings: drop irregular/outdated/rare forms; common ones first (stable)
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
    # glosses: first sense up to 3, plus the head gloss of the next two senses
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
    entries.append([ '|'.join(kforms), '|'.join(rforms), text, short_pos(pos.get(sids[0], [])), (1 if uk else 0), rank(pris) ])

entries.sort(key=lambda e: (e[5], e[1]))
meta = dict(c.execute('select key, value from meta').fetchall())
json.dump({'source': 'JMdict %s (EDRDG), common-word subset' % meta.get('jmdict.version', ''), 'fields': ['kanji', 'kana', 'gloss', 'pos', 'usuallyKana', 'rank'], 'entries': entries},
          open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('entries', len(entries))
