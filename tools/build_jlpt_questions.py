"""Build data/jlpt-official.json from the vocabulary sections of the official JLPT practice workbook.

Source: "Japanese-Language Proficiency Test Official Practice Workbook Vol. 2" (2018), published for
learners at https://www.jlpt.jp/e/samples/sampleindex.html. The site policy grants reproduction for
Japanese-language education where no fee is collected, with the source stated.

Inputs: a folder holding N1V.pdf .. N5V.pdf and N1answer.pdf .. N5answer.pdf from
        https://www.jlpt.jp/samples/sample2018/pdf/ , and data/dict.json
Needs:  pip install pdfminer.six sudachipy sudachidict_core

Usage: python3 tools/build_jlpt_questions.py PDF_DIR data/dict.json data/jlpt-official.json
"""
import sys, os, re, json, collections
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextLine, LTChar, LTLine, LTRect, LTCurve

pdf_dir, dict_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
BASE = 'https://www.jlpt.jp/samples/sample2018/pdf/'
U0, U1 = '⟦', '⟧'            # marks around the underlined part of a sentence
CID = re.compile(r'^\(cid:\d+\)$')
HEAD = re.compile(r'^(問題|もんだい)\s*([０-９0-9]+)')
ZEN = str.maketrans('０１２３４５６７８９', '0123456789')


def page_items(fn):
    for pno, page in enumerate(extract_pages(fn), 1):
        lines, rules = [], []
        def visit(el):
            if isinstance(el, LTTextLine):
                chars = [(c.get_text(), c.x0, c.x1, c.fontname) for c in el if isinstance(c, LTChar)]
                if chars:
                    lines.append({'y0': el.y0, 'x0': el.x0, 'x1': el.x1, 'size': max(c.size for c in el if isinstance(c, LTChar)), 'chars': chars})
            elif isinstance(el, (LTLine, LTRect, LTCurve)):
                if el.y1 - el.y0 <= 2.5 and 6 <= el.x1 - el.x0 <= 300: rules.append((el.x0, el.x1, (el.y0 + el.y1) / 2))
            elif hasattr(el, '__iter__'):
                for c in el: visit(c)
        visit(page)
        yield pno, page.height, page.width, lines, rules


def qtype(instr):
    if '読み方' in instr or 'ひらがな' in instr: return 'reading'
    if '漢字で書く' in instr or 'かきますか' in instr: return 'orthography'
    if '使い方' in instr or 'つかいかた' in instr: return 'usage'
    if '意味が' in instr or 'おなじ いみ' in instr or 'おなじいみ' in instr: return 'paraphrase'
    return 'context'


def parse_booklet(fn):
    """Return the questions of one booklet in order, each with its page, section, sentence and options."""
    questions, section, cur = [], None, None
    qnum = 0
    for pno, height, width, lines, rules in page_items(fn):
        sizes = collections.Counter(round(l['size'], 1) for l in lines if l['size'] > 8)
        if not sizes: continue
        main = sizes.most_common(1)[0][0]
        body = [l for l in lines if l['size'] >= main * 0.75 and 45 < l['y0'] < height - 35
                and not (len(l['chars']) <= 3 and all(c[0] in '文字・語彙法読解' for c in l['chars']))]   # drop the section tab printed in the margin
        for l in body:
            l['text'] = ''.join(c[0] for c in l['chars'])
            l['plain'] = re.sub(r'\(cid:\d+\)', '', l['text']).strip()
            l['under'] = set()
            for (rx0, rx1, ry) in rules:                      # underline: a thin rule sitting on the text's baseline
                if abs(ry - l['y0']) <= 3.5 and rx1 > l['x0'] and rx0 < l['x1']:
                    for i, c in enumerate(l['chars']):
                        if rx0 - 0.5 <= (c[1] + c[2]) / 2 <= rx1 + 0.5: l['under'].add(i)
        body.sort(key=lambda l: (-l['y0'], l['x0']))
        rows = []
        for l in body:
            if rows and abs(rows[-1][0]['y0'] - l['y0']) <= 4: rows[-1].append(l)
            else: rows.append([l])
        # Mark the worked example ("れい") that opens each section in the N4 and N5 booklets, so it is skipped.
        flag, skip = False, set()
        for ri, row in enumerate(rows):
            joined = ''.join(l['plain'] for l in row)
            if any(HEAD.match(l['plain']) for l in row): flag = False; continue
            if '（れい）' in joined or '（例）' in joined: flag = True
            if flag:
                skip.add(ri)
                if 'かいとうようし' in joined or '解答用紙' in joined: flag = False
        # Question numbers hang in the left margin; the options of N4 and N5 use the same kind of glyph but are indented.
        led = [l['x0'] for ri, row in enumerate(rows) if ri not in skip for l in row if CID.match(l['chars'][0][0])]
        qx = min(led) if led else 0
        digit_fonts = {}                                       # font of the question numbers -> {cid text: digit}

        def text_of(l, start=0, end=None):
            out, open_u, prev = [], False, None
            for i, c in enumerate(l['chars']):
                if i < start or (end is not None and i >= end): continue
                t = c[0]
                if CID.match(t): t = digit_fonts.get(c[3], {}).get(t, '')
                if prev is not None and c[1] - prev > l['size'] * 0.35: out.append(' ')     # a gap wide enough to be a space
                prev = c[2]
                u = i in l['under'] and t.strip() != ''
                if u and not open_u: out.append(U0); open_u = True
                if not u and open_u: out.append(U1); open_u = False
                out.append(t)
            if open_u: out.append(U1)
            return ''.join(out).replace('\n', '')

        def gap(l, i):                                         # space before character i
            return l['chars'][i][1] - l['chars'][i - 1][2] if i > 0 else 99

        def option_starts(l):                                  # positions of "１ ２ ３ ４" used as option numbers
            ch = l['chars']
            return [i for i, c in enumerate(ch) if c[0] in '１２３４' and gap(l, i) > 3 and i + 1 < len(ch) and gap(l, i + 1) > 3]

        for ri, row in enumerate(rows):
            if any(HEAD.match(l['plain']) for l in row):
                m = [HEAD.match(l['plain']) for l in row if HEAD.match(l['plain'])][0]
                instr = ''.join(dict.fromkeys(l['plain'] for l in row))        # the heading is drawn twice in some booklets
                section = {'n': int(m.group(2).translate(ZEN)), 'instr': HEAD.sub('', instr).strip()}
                cur = None
                continue
            if ri in skip or section is None: continue
            for l in row:
                first = l['chars'][0][0]
                led_cid = bool(CID.match(first))
                starts = option_starts(l)
                led_num = bool(starts) and starts[0] == 0
                is_q = led_cid and not led_num and l['x0'] <= qx + 8
                if is_q:
                    qnum += 1
                    k = 0
                    while k < len(l['chars']) and CID.match(l['chars'][k][0]): k += 1
                    digits = str(qnum)
                    if k == len(digits):                       # learn this page's digit glyphs from the question number
                        for j in range(k): digit_fonts.setdefault(l['chars'][j][3], {})[l['chars'][j][0]] = digits[j]
                    cur = {'n': qnum, 'page': pno, 'sec': section['n'], 'instr': section['instr'], 'type': qtype(section['instr']),
                           'stem': text_of(l, k).strip(), 'opts': []}
                    questions.append(cur)
                elif cur is None:
                    section['instr'] += l['plain']             # the instruction runs over more than one line
                    for q in questions:
                        if q['sec'] == section['n']: q['instr'] = section['instr']; q['type'] = qtype(section['instr'])
                elif led_num:
                    for j, st in enumerate(starts):
                        cur['opts'].append(text_of(l, st + 1, starts[j + 1] if j + 1 < len(starts) else None).strip())
                elif led_cid:
                    k = 0
                    while k < len(l['chars']) and CID.match(l['chars'][k][0]): k += 1
                    cur['opts'].append(text_of(l, k).strip())
                else:
                    t = text_of(l).strip()
                    if not t: continue
                    if cur['opts']: cur['opts'][-1] += t
                    elif cur['stem'].endswith('（') and t.startswith('）'): cur['stem'] += '　　　' + t
                    else: cur['stem'] += t
    for q in questions:
        q['stem'] = re.sub(r'[ \u3000]*（[\s\u3000]*）[ \u3000]*', '（\u3000\u3000\u3000）', q['stem'])
        tidy = lambda t: re.sub(r'\s+' + U1, U1 + ' ', re.sub(U0 + r'\s+', ' ' + U0, t.replace(U1 + U0, ''))).strip()
        q['stem'] = tidy(q['stem'])
        q['opts'] = [tidy(o) for o in q['opts']]
    return questions


def parse_answers(fn):
    """Question number -> correct option (1-4) for the first block of the answer sheet."""
    page = next(page_items(fn))
    _, height, _, lines, _ = page
    items = []
    for l in lines:
        t = ''.join(c[0] for c in l['chars']).strip()
        if l['x0'] < 480 and l['size'] > 7 and t: items.append((round(l['y0']), l['x0'], t))
    items.sort(key=lambda x: (-x[0], x[1]))
    rows = []
    for y, x, t in items:
        if rows and abs(rows[-1][0] - y) <= 3: rows[-1][1].append((x, t))
        else: rows.append([y, [(x, t)]])
    ans, pending, started, last = {}, None, False, 0
    for y, cells in rows:
        text = ' '.join(t for _, t in cells)
        if '●' in text:
            if started: break
            started = True; continue
        if not started: continue
        rest = re.sub(r'問題\s*[０-９]+', '', text)                    # the section label, e.g. 問題１, is not a question number
        if rest == text: rest = re.sub(r'問題\s*\d+', '', text)
        nums = [int(n) for n in re.findall(r'\d+', rest.translate(ZEN))]
        if not nums: continue
        if '問題' in text or (pending is None and nums[0] == last + 1):
            pending = nums
        elif pending is not None and len(nums) == len(pending) and all(1 <= n <= 4 for n in nums):
            for qn, a in zip(pending, nums): ans[qn] = a
            last = pending[-1]; pending = None
    return ans


# ---------------------------------------------------------------- parse the five booklets
papers, questions = {}, []
for level in (5, 4, 3, 2, 1):
    qs = parse_booklet(os.path.join(pdf_dir, 'N%dV.pdf' % level))
    ans = parse_answers(os.path.join(pdf_dir, 'N%danswer.pdf' % level))
    ok = [q for q in qs if len(q['opts']) == 4 and q['n'] in ans]
    print('N%d: parsed %d questions, %d with four options and an answer; sections %s' % (
        level, len(qs), len(ok), dict(collections.Counter(q['type'] for q in ok))), file=sys.stderr)
    for q in qs:
        if q not in ok: print('   dropped N%d q%d: %s | %s' % (level, q['n'], q['stem'][:40], q['opts']), file=sys.stderr)
    papers['2018-N%d' % level] = {'level': level, 'title': 'Official Practice Workbook Vol. 2 (2018), N%d Vocabulary' % level, 'url': BASE + 'N%dV.pdf' % level}
    for q in ok:
        questions.append({'paper': '2018-N%d' % level, 'n': q['n'], 'page': q['page'], 'type': q['type'],
                          'stem': q['stem'], 'opts': q['opts'], 'ans': ans[q['n']]})

# ---------------------------------------------------------------- which words does each question test?
from sudachipy import Dictionary, SplitMode
tok = Dictionary().create()
E = json.load(open(dict_path, encoding='utf-8'))['entries']
known = set()
for e in E:
    for t in (e[0].split('|') if e[0] else []) + e[1].split('|'): known.add(t)
STOP = set('する ある いる なる できる こと もの よう それ これ あれ どれ ここ そこ わたし 私 人 何 今 時 とき ため さん'.split())
CONTENT = ('名詞', '動詞', '形容詞', '副詞', '形状詞', '連体詞', '接続詞', '感動詞')

def lemmas(text):
    text = text.replace(U0, '').replace(U1, '').replace('　', '')
    out = []
    for m in tok.tokenize(text, SplitMode.C):
        if m.part_of_speech()[0] not in CONTENT: continue
        hit = [c for c in dict.fromkeys((m.dictionary_form(), m.normalized_form())) if c in known and c not in STOP]
        if not hit and m.surface() in known and m.surface() not in STOP: hit = [m.surface()]
        out.extend(hit)                      # e.g. しんぱい and its usual spelling 心配
    return out

def underlined(text):
    return ''.join(re.findall(U0 + '(.*?)' + U1, text))

index = collections.defaultdict(dict)       # word -> {question index: role}; 2 = the word being tested, 1 = another option, 0 = in the sentence
def add(word, qi, role):
    if role > index[word].get(qi, -1): index[word][qi] = role

for qi, q in enumerate(questions):
    right = q['opts'][q['ans'] - 1]
    if q['type'] == 'reading':
        for w in lemmas(underlined(q['stem'])): add(w, qi, 2)
    elif q['type'] == 'orthography':
        for w in lemmas(right): add(w, qi, 2)
    elif q['type'] == 'context':
        for w in lemmas(q['stem'].replace('（　　　）', right)):
            if w in lemmas(right): add(w, qi, 2)
        for o in q['opts']:
            for w in lemmas(o): add(w, qi, 2 if o == right else 1)
    elif q['type'] == 'paraphrase':
        for w in lemmas(underlined(q['stem'])): add(w, qi, 2)
        for w in lemmas(right): add(w, qi, 2)
        for o in q['opts']:
            for w in lemmas(o): add(w, qi, 1)
    elif q['type'] == 'usage':
        for w in lemmas(q['stem']): add(w, qi, 2)
        if q['stem'].strip() in known: add(q['stem'].strip(), qi, 2)
    for w in lemmas(q['stem']): add(w, qi, 0)

idx = {w: sorted(([qi, r] for qi, r in d.items()), key=lambda x: (-x[1], x[0])) for w, d in index.items()}
json.dump({'source': 'Japanese-Language Proficiency Test Official Practice Workbook Vol. 2 (2018). Source: Official Worldwide Japanese-Language Proficiency Test Website (https://www.jlpt.jp/)',
           'papers': papers, 'questions': questions, 'index': idx},
          open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('questions', len(questions), '| indexed words', len(idx), '| tested words', sum(1 for d in index.values() if 2 in d.values()), '| bytes', os.path.getsize(out), file=sys.stderr)
