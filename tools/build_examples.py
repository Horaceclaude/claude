"""Build example sentences for the words in data/dict.json: data/ex/00.json .. 63.json

Inputs (from https://downloads.tatoeba.org/exports/, CC BY 2.0 FR)
  jpn_indices.csv                     the word index of the Japanese sentences (Tanaka Corpus "B lines")
  jpn_sentences_detailed.tsv.bz2      per_language/jpn
  eng_sentences_detailed.tsv.bz2      per_language/eng

Usage: python3 tools/build_examples.py data/dict.json TATOEBA_DIR data/ex

Each shard maps a JMdict entry number to up to 6 sentences:
  [Japanese, English, Tatoeba sentence number, author of the Japanese sentence, the word as written in it]
"""
import sys, os, re, bz2, json, collections

dict_path, tdir, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
SHARDS, PER_WORD = 64, 6
E = json.load(open(dict_path, encoding='utf-8'))['entries']

def hira(s): return ''.join(chr(ord(ch) - 0x60) if 'ァ' <= ch <= 'ヶ' else ch for ch in s)

by_text = collections.defaultdict(list)
info = {}
for e in E:
    kj = e[0].split('|') if e[0] else []
    kn = e[1].split('|')
    primary = kn[0] if (e[4] or not kj) else kj[0]
    info[e[6]] = (kj, kn, primary)
    for t in kj + kn: by_text[t].append(e[6])

TOKEN = re.compile(r'^(?P<head>[^\(\[\{~|]+)(?:\|\d+)?(?:\((?P<read>[^)]+)\))?(?:\[(?P<sense>\d+)\])?(?:\{(?P<form>[^}]+)\})?(?P<good>~)?$')
PLAIN = re.compile(r'[^\u3040-\u30ff\u4e00-\u9fff\u3005、。？！?!0-9０-９ー]')
KANA_ONLY = re.compile(r'^[\u3040-\u30ffー]+$')
BAD_EN = re.compile(r'\b(fuck|shit|bitch|whore|slut|rape[ds]?|raping|penis|vagina|orgasm|masturbat\w*|porn\w*|nigger|faggot|cunt|dick|asshole|bastard|suicide|kill (?:myself|yourself|himself|herself))\b', re.I)

cands = collections.defaultdict(list)     # entry id -> [(good, sentence id, meaning id, form)]
need_j, need_e = set(), set()
with open(os.path.join(tdir, 'jpn_indices.csv'), encoding='utf-8') as f:
    for line in f:
        parts = line.rstrip('\n').split('\t')
        if len(parts) < 3: continue
        try: sid, mid = int(parts[0]), int(parts[1])
        except ValueError: continue
        if mid <= 0: continue
        for tok in parts[2].split(' '):
            m = TOKEN.match(tok)
            if not m: continue
            head, read, form = m.group('head'), m.group('read'), m.group('form') or m.group('head')
            ids = by_text.get(head)
            if not ids: continue
            if read: ids = [i for i in ids if hira(read) in [hira(k) for k in info[i][1]]]
            if len(ids) > 1: ids = [i for i in ids if info[i][2] == head] or ([] if len(ids) > 1 else ids)
            if len(ids) != 1: continue
            cands[ids[0]].append((1 if m.group('good') else 0, sid, mid, form))
            need_j.add(sid); need_e.add(mid)

def load(name, need):
    out = {}
    with bz2.open(os.path.join(tdir, name), 'rt', encoding='utf-8') as f:
        for line in f:
            p = line.rstrip('\n').split('\t')
            if len(p) < 4: continue
            try: i = int(p[0])
            except ValueError: continue
            if i in need: out[i] = (p[2], p[3] if p[3] != '\\N' else '')
    return out

J = load('jpn_sentences_detailed.tsv.bz2', need_j)
EN = load('eng_sentences_detailed.tsv.bz2', need_e)

shards = [dict() for _ in range(SHARDS)]
kept = words = 0
for eid, lst in cands.items():
    scored, seen = [], set()
    for good, sid, mid, form in lst:
        if sid in seen or sid not in J or mid not in EN: continue
        ja, user = J[sid]; en = EN[mid][0]
        if form not in ja or BAD_EN.search(en): continue
        n = len(ja)
        if n < 5 or n > 48 or len(en) > 120: continue
        seen.add(sid)
        penalty = abs(n - 20)
        if PLAIN.search(ja): penalty += 40                       # brackets, symbols, Latin letters: harder to read
        if info[eid][0] and KANA_ONLY.match(form): penalty += 60  # the word is normally in kanji but not here
        scored.append((penalty - 12 * good, sid, 0, [ja, en, sid, user, form]))   # checked sentences get a head start, not a free pass
    scored.sort(key=lambda x: x[:3])
    clean = [x for x in scored if x[0] < 30]
    if len(clean) >= 3: scored = clean          # enough plain sentences: leave the awkward ones out
    # prefer variety in the word's form (plain, polite, past ...) before repeating one
    picked, forms = [], collections.Counter()
    for limit in (1, 2, PER_WORD):
        for s in scored:
            if len(picked) >= PER_WORD: break
            if s[3] in picked or forms[s[3][4]] >= limit: continue
            picked.append(s[3]); forms[s[3][4]] += 1
    if picked:
        shards[eid % SHARDS][str(eid)] = picked
        kept += len(picked); words += 1

os.makedirs(out_dir, exist_ok=True)
total = 0
for i, sh in enumerate(shards):
    p = os.path.join(out_dir, '%02d.json' % i)
    json.dump(sh, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    total += os.path.getsize(p)
print('words with examples', words, 'of', len(E), '| sentences', kept, '| bytes', total, '| avg shard', total // SHARDS)
