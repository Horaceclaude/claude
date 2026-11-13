"""Work out a JLPT level for each word: data used by tools/build_dict.py.

The JLPT has published no word list since 2010, so this combines independent evidence:

  waller   Jonathan Waller's lists (tanos.co.uk, CC BY), matched to JMdict by stephenmk/yomitan-jlpt-vocab,
           with the community corrections of jamsinclair/open-anki-jlpt-decks
  books    the "egg rolls JLPT 10k" list, compiled from Chinese JLPT study books (via the npm package
           @polyglot-bundles/ja-jlpt-syllabi); N5 and N4 are one group there
  exams    which words appeared in at least 3 real N4, N3 and N2 exams since 2010 (word counts only, from the
           IreneZihuiLi/jlpt-n2-stats, -n3-stats and -n4-stats summaries)
  workbook words the official 2018 practice workbook tests at a given level (data/jlpt-official.json)
  textbooks which lesson of みんなの日本語 初級 I/II (lessons 1-50, via ganseed/minna-no-nihongo-vocabulary) and
           GENKI I/II (lessons 0-23, via jackiewkr/genki1-vocab) teaches the word: みんなの日本語 1-25 and GENKI I (0-12)
           count as N5, みんなの日本語 26-50 and GENKI II (13-23) as N4. Only the word-to-lesson reference is used.

Words on no list get an estimate from a model trained on the listed words: how common the word is
(wordfreq, CC BY-SA 4.0), the JLPT level of its kanji, its length and its part of speech.

Usage: python3 tools/build_levels.py JAMDICT_DB WALLER_DIR JAMSINCLAIR_DIR EGGROLLS_JSON EXAM_DIR KANJI_JSON OFFICIAL_JSON MINNA_JSON GENKI_CSV OUT.json
Output: {"<JMdict id>": [level 5..1 or 0, basis, textbook lessons such as "M12 G5"], ...} and a report on stderr.
  basis: "agree" (lists agree), "list" (one list), "mixed" (lists differ; the list level nearer the estimate is kept),
         "exam" (raised to the easiest level whose real exams use it), "est" (estimated), "beyond" (rarer than N1),
         "casual" (slang or colloquial, on no list: not tested in the JLPT)
Words: every word on a list, JMdict's common words, every word with a wordfreq Zipf frequency of 3.0 or more, and slang
or colloquial words of 2.5 or more (names and titles left out).
"""
import sys, os, re, csv, json, sqlite3, collections, glob, math, random

db_path, waller_dir, jam_dir, egg_path, exam_dir, kanji_path, official_path, minna_path, genki_path, out_path = sys.argv[1:11]
db = sqlite3.connect('file:%s?mode=ro' % db_path, uri=True)
c = db.cursor()

def hira(s): return ''.join(chr(ord(ch) - 0x60) if 'ァ' <= ch <= 'ヶ' else ch for ch in s)
def clean(w):
    w = re.sub(r'\[[^\]]*\]|（[^）]*）|\([^)]*\)', '', w or '')
    return re.sub(r'[\s〜～~・…]', '', w).strip()

by_kanji, by_kana = collections.defaultdict(set), collections.defaultdict(set)
for idseq, text in c.execute('select idseq, text from Kanji'): by_kanji[text].add(idseq)
first_kana = {}
usually_kana = {r[0] for r in c.execute("select s.idseq from Sense s join misc m on m.sid = s.ID where m.text like 'word usually written using kana%'")}
no_kanji = {r[0] for r in c.execute('select idseq from Entry where idseq not in (select idseq from Kanji)')}
n_senses = collections.Counter(r[0] for r in c.execute('select idseq from Sense'))
ichidan = {r[0] for r in c.execute("select s.idseq from Sense s join pos p on p.sid = s.ID where p.text like 'Ichidan verb%'")}
godan = {r[0] for r in c.execute("select s.idseq from Sense s join pos p on p.sid = s.ID where p.text like 'Godan verb%'")}
for idseq, text in c.execute('select idseq, text from Kana order by ID'):
    by_kana[hira(text)].add(idseq); first_kana.setdefault(idseq, hira(text))
pri = collections.defaultdict(set)
for idseq, t in c.execute('select k.idseq, p.text from Kanji k join KJP p on p.kid = k.ID'): pri[idseq].add(t)
for idseq, t in c.execute('select k.idseq, p.text from Kana k join KNP p on p.kid = k.ID'): pri[idseq].add(t)
COMMON = {'news1', 'ichi1', 'spec1', 'spec2', 'gai1'}

def nf(idseq):
    r = 60
    for p in pri.get(idseq, ()):
        m = re.match(r'nf(\d\d)$', p)
        if m: r = min(r, int(m.group(1)))
    return r if r < 60 else (30 if 'ichi1' in pri.get(idseq, ()) else 49 if pri.get(idseq, set()) & COMMON else 60)

def match(word, reading='', group=None):
    """JMdict entry for a word as written in a list, or None. group: 'v1' or 'v5' when the list shows how the verb conjugates."""
    w, r = clean(word), hira(clean(reading)) if reading and re.search(r'[぀-ヿ]', reading) else ''
    if not w: return None
    if re.search(r'[一-鿿々]', w):
        ids = by_kanji.get(w, set())
        if r: ids = {i for i in ids if i in by_kana.get(r, ())} or ids
    else:
        ids = by_kana.get(hira(w), set())
        if group: ids = {i for i in ids if i in (ichidan if group == 'v1' else godan)} or ids
        # a word in kana is the entry whose main reading it is (ない is 無い, not 地震, whose old reading is ない), one normally
        # written in kana, and the most central one, by its number of senses (なる is 成る with many senses, not 生る with one).
        # JMdict's frequency marks belong to the kana spelling, shared by all homophones, so they come last.
        if ids: return min(ids, key=lambda i: (first_kana.get(i) != hira(w), i not in usually_kana and i not in no_kanji, -min(n_senses[i], 8), nf(i), i))
    if not ids: return None
    return min(ids, key=lambda i: (nf(i), i))

report = collections.Counter()
def tally(name, ok): report[name + (' matched' if ok else ' unmatched')] += 1

# ---- Waller (by JMdict id) and jamsinclair (by spelling)
waller = {}
for n in (5, 4, 3, 2, 1):
    with open(os.path.join(waller_dir, 'n%d.csv' % n), encoding='utf-8') as f:
        for row in csv.DictReader(f):
            try: waller.setdefault(int(row['jmdict_seq']), n)
            except (ValueError, KeyError): pass
jam = {}
for n in (5, 4, 3, 2, 1):
    with open(os.path.join(jam_dir, 'n%d.csv' % n), encoding='utf-8') as f:
        for row in csv.DictReader(f):
            i = match(row['expression'], row['reading']); tally('jamsinclair', i)
            if i: jam.setdefault(i, n)

# ---- the 10k book list
egg = {}
LV = {'n5-n4': 4.5, 'n3': 3, 'n2': 2, 'n1': 1}
def walk(o, lvl=None):
    if isinstance(o, dict):
        lvl = (o.get('metadata') or {}).get('jlptLevel', lvl)
        if 'children' not in o:
            if o.get('type') == 'vocabularyItem':
                i = match(o.get('word'), o.get('transcription')); tally('books', i)
                if i: egg[i] = max(egg.get(i, 0), LV[lvl])
            return
        for ch in o['children']: walk(ch, lvl)
walk(json.load(open(egg_path, encoding='utf-8')))

# ---- real exams: easiest level whose exams use the word in at least 3 sittings
exam = {}
for lv in (4, 3, 2):
    p = os.path.join(exam_dir, 'IreneZihuiLi_jlpt-n%d-stats' % lv, 'data.json')
    if not os.path.exists(p): continue
    d = json.load(open(p, encoding='utf-8'))
    sheets = ['笔试高频词汇', '听力高频词汇'] + (['旧题词汇参考'] if lv == 2 else [])   # old 2級 also maps to N2 or easier
    for sh in sheets:
        for row in d.get(sh, {}).get('rows', []):
            try: cnt = int(row.get('考试频次', 0))
            except ValueError: continue
            if cnt < 3: continue
            i = match(row.get('日语'), row.get('读音')); tally('exams N%d' % lv, i)
            if i: exam[i] = max(exam.get(i, 0), lv)

# ---- words the official workbook tests
workbook = {}
off = json.load(open(official_path, encoding='utf-8'))
for word, hits in off['index'].items():
    for qi, role in hits:
        if role != 2: continue
        lv = off['papers'][off['questions'][qi]['paper']]['level']
        i = match(word); tally('workbook', i)
        if i: workbook[i] = max(workbook.get(i, 0), lv)

# ---- textbooks: みんなの日本語 (1-50) and GENKI I/II (0-23)
textbook, lessons = {}, collections.defaultdict(list)
for row in json.load(open(minna_path, encoding='utf-8')):
    if row.get('type') != 'word': continue
    df = row.get('dictionary_form') or ''          # verbs are listed in the ます-form, with the dictionary form beside it
    kn = row.get('kana') or ''
    grp = ('v1' if kn[:-2] + 'る' == hira(df) else 'v5') if df and kn.endswith('ます') and not re.search(r'[一-鿿々]', df) else None
    i = (match(df, group=grp) or (df.endswith('する') and match(df[:-2]))) if df else None
    i = i or match(row.get('kanji') or row.get('kana'), row.get('kana')) or match(row.get('kana'))
    tally('minna', i)
    if not i: continue
    L = int(row['lesson'])
    textbook[i] = max(textbook.get(i, 0), 5 if L <= 25 else 4)
    lessons[i].append('M%d' % L)
with open(genki_path, encoding='utf-8') as f:
    for row in csv.reader(f):
        if len(row) < 4: continue
        kana, kanji, _, L = row[0], row[1], row[2], row[3]
        i = match(kanji or kana, kana) or match(kana)
        tally('genki', i)
        if not i: continue
        try: L = int(L)
        except ValueError: continue
        textbook[i] = max(textbook.get(i, 0), 5 if L <= 12 else 4)   # GENKI I (0-12) ~ N5, GENKI II (13-23) ~ N4
        lessons[i].append('G%d' % L)

# ---- combine the lists
level, basis = {}, {}
for i in set(waller) | set(jam) | set(egg) | set(textbook):
    w = jam.get(i, waller.get(i))
    b = egg.get(i)
    t = textbook.get(i)
    if t:                                              # a textbook vote: settles disagreements, or stands alone
        votes = [v for v in (w, b) if v]
        if not votes: lv, bs = t, 'list'
        elif any(v == t or (v == 4.5 and t >= 4) for v in votes): lv, bs = t, 'agree'
        elif len(votes) == 2 and (votes[0] == votes[1] or (4.5 in votes and min(votes) >= 4)): lv, bs = (max(votes) if max(votes) != 4.5 else min(votes)), 'agree'
        else: lv, bs = (votes[0] if votes[0] != 4.5 else 4, t), 'mixed'
        level[i], basis[i] = lv, bs
        continue
    if w and b:
        if b == 4.5 and w >= 4: lv, bs = w, 'agree'
        elif w == b: lv, bs = w, 'agree'
        else: lv, bs = (w, min(b, 4)), 'mixed'             # settled below, with the estimate as tie-breaker
    elif w: lv, bs = w, 'list'
    else: lv, bs = b, 'list'
    level[i], basis[i] = lv, bs

# ---- estimate the rest
import wordfreq
FREQ = wordfreq.get_frequency_dict('ja', wordlist='large')
kanji_lv = {k: int(v) for k, v in json.load(open(kanji_path, encoding='utf-8')).items()}
grade = {lit: (int(g) if g and g.isdigit() else 10) for lit, g in c.execute('select literal, grade from character')}

forms_k, forms_r = collections.defaultdict(list), collections.defaultdict(list)
for idseq, text in c.execute('select idseq, text from Kanji order by ID'): forms_k[idseq].append(text)
for idseq, text in c.execute('select idseq, text from Kana order by ID'): forms_r[idseq].append(text)
uk = set(r[0] for r in c.execute("select s.idseq from Sense s join misc m on m.sid = s.ID where m.text like 'word usually written using kana alone%'"))
first_pos = {}
for idseq, t in c.execute('select s.idseq, p.text from Sense s join pos p on p.sid = s.ID order by s.ID'):
    first_pos.setdefault(idseq, t)

def zipf(i):
    best = 0.0
    for f in forms_k.get(i, [])[:3] + forms_r.get(i, [])[:2]:
        v = FREQ.get(f)
        if v: best = max(best, math.log10(v) + 9)
    return best

def features(i):
    kf = forms_k.get(i, [])
    main = forms_r[i][0] if (i in uk or not kf) else kf[0]
    ks = [ch for ch in main if '一' <= ch <= '鿿']
    klv = [kanji_lv.get(k, 0) for k in ks]              # 5 easy .. 1 hard, 0 = not on the kanji lists
    p = (first_pos.get(i) or '').lower()
    return [zipf(i), nf(i), len(main), len(ks), min(klv) if klv else 6, sum(klv) / len(klv) if klv else 6,
            max(grade.get(k, 10) for k in ks) if ks else 0, 1 if re.fullmatch(r'[゠-ヿー]+', main) else 0,
            1 if 'verb' in p and 'adverb' not in p else 0, 1 if 'adjective (keiyoushi)' in p else 0,
            1 if 'adjectival nouns' in p else 0, 1 if 'adverb' in p else 0, 1 if 'expressions' in p else 0,
            1 if 'noun' in p else 0]

common_ids = [i for i in forms_r if pri.get(i, set()) & COMMON]
known_ids = set(i for i, v in forms_r.items() if v)
missing = [i for i in level if i not in known_ids]
if missing: print('list entries not in this JMdict copy (skipped):', len(missing), file=sys.stderr)
# beyond the lists: every word common in real Japanese (wordfreq), and the slang and colloquial words people use every day
NAMES = set(r[0] for r in c.execute("select s.idseq from Sense s join misc m on m.sid = s.ID where m.text in ('place name', 'full name of a particular person', 'work of art, literature, music, etc. name')"))
CASUAL_TAGS = ('slang', 'colloquialism', 'Internet slang', 'manga slang', 'jocular, humorous term', 'vulgar expression or word', 'familiar language')
casual = set(r[0] for r in c.execute("select s.idseq from Sense s join misc m on m.sid = s.ID where m.text in (%s)" % ','.join('?' * len(CASUAL_TAGS)), CASUAL_TAGS))
def wordlike(i):
    main = (forms_k.get(i) or forms_r.get(i) or [''])[0]
    return len(main) >= 2 and not re.fullmatch(r'[0-9０-９a-zA-Zａ-ｚＡ-Ｚ!-/:-@]+', main)
everyday = [i for i in known_ids if i not in NAMES and wordlike(i) and (zipf(i) >= 3.0 or (i in casual and zipf(i) >= 2.5))]
want = sorted((set(common_ids) | set(level) | set(everyday)) & known_ids)
print('words: lists and common', len((set(common_ids) | set(level)) & known_ids), '| everyday additions', len(set(want) - set(common_ids) - set(level)), file=sys.stderr)
from sklearn.ensemble import HistGradientBoostingRegressor
train = [i for i in want if i in level and basis[i] in ('agree', 'list') and level[i] != 4.5]
X = [features(i) for i in train]; y = [level[i] for i in train]
random.seed(7); idx = list(range(len(train))); random.shuffle(idx)
cut = len(idx) // 5
test_i, train_i = idx[:cut], idx[cut:]
m = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.06, random_state=1)
m.fit([X[j] for j in train_i], [y[j] for j in train_i])
pred = m.predict([X[j] for j in test_i])
exact = sum(1 for p, j in zip(pred, test_i) if round(p) == y[j]) / len(test_i)
within1 = sum(1 for p, j in zip(pred, test_i) if abs(round(p) - y[j]) <= 1) / len(test_i)
print('estimator check on %d held-out listed words: exact %.0f%%, within one level %.0f%%' % (len(test_i), exact * 100, within1 * 100), file=sys.stderr)
m.fit(X, y)

todo = [i for i in want if i not in level or level[i] == 4.5 or basis[i] == 'mixed']
P = m.predict([features(i) for i in todo]) if todo else []
for i, p in zip(todo, P):
    if level.get(i) == 4.5:                      # books group N5+N4: split with the estimate
        level[i] = 5 if p >= 4.5 else 4
        continue
    if basis.get(i) == 'mixed':                  # the lists disagree: keep the list level nearer the estimate
        a, b = level[i]
        level[i] = min((a, b), key=lambda v: (abs(v - p), -v))
        continue
    z = zipf(i)
    if z < 2.6 and p < 1.6:                      # rare and hard: beyond what N1 expects
        level[i], basis[i] = 0, 'beyond'
    else:
        level[i], basis[i] = max(1, min(5, int(round(p)))), 'est'

first_sense = {}
for sid, idseq in c.execute('select ID, idseq from Sense order by ID'): first_sense.setdefault(idseq, sid)
casual_main = set(r[0] for r in c.execute("select s.idseq from Sense s join misc m on m.sid = s.ID where m.text in (%s)" % ','.join('?' * len(CASUAL_TAGS)), CASUAL_TAGS)
                  if False) or set(i for i, in c.execute("select s.idseq from Sense s join misc m on m.sid = s.ID where m.text in (%s) and s.ID in (select min(ID) from Sense group by idseq)" % ','.join('?' * len(CASUAL_TAGS)), CASUAL_TAGS))
for i in want:                                   # words whose main meaning is slang or colloquial, on no list or exam: not tested in the JLPT
    if i in casual_main and basis.get(i) in ('est', 'beyond'):
        level[i], basis[i] = max(1, level[i] or 1), 'casual'
for src in (exam, workbook):                     # real exams and the workbook use the word at this level
    for i, lv in src.items():
        if i in level and level[i] and level[i] < lv: level[i], basis[i] = lv, 'exam'
        elif i in level and not level[i]: level[i], basis[i] = lv, 'exam'
out = {str(i): [int(level[i]), basis[i], ' '.join(sorted(set(lessons.get(i, [])), key=lambda x: (x[0], int(x[1:]))))] for i in want}
json.dump(out, open(out_path, 'w', encoding='utf-8'), separators=(',', ':'))
cnt = collections.Counter((v[1], v[0]) for v in out.values())
for k in sorted(report): print('  %-26s %d' % (k, report[k]), file=sys.stderr)
print('levels by basis:', file=sys.stderr)
for bs in ('agree', 'list', 'mixed', 'exam', 'est', 'beyond', 'casual'):
    print('  %-7s' % bs, {('N%d' % lv if lv else '-'): cnt[(bs, lv)] for lv in (5, 4, 3, 2, 1, 0) if cnt[(bs, lv)]}, file=sys.stderr)
print('words:', len(out), file=sys.stderr)
