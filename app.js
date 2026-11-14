/* Kikitori: hear a Japanese word in real YouTube videos.
 *
 * Video search, timing and captions come from the YouGlish widget and its
 * JavaScript API (https://youglish.com/api/doc/js-api). This file adds the
 * page around it: the search box, romaji/kana help from a small JMdict
 * subset, our own caption slate, playback controls, history and saved words.
 */
(function () {
  'use strict';

  const LANG = 'japanese';
  const WIDGET_SRC = 'https://youglish.com/public/emb/widget.js';
  const SPEEDS = [0.5, 0.75, 1, 1.25];
  const STARTERS = [
    ['ありがとう', 'thank you'], ['大丈夫', "it's OK"], ['やっぱり', 'as I thought'], ['食べる', 'to eat'],
    ['なるほど', 'I see'], ['頑張る', 'to do your best'], ['面白い', 'interesting'], ['お疲れ様', 'good work today']
  ];

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs, text) => {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  };

  /* ---------- storage (this browser only) ---------- */
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('kikitori.' + key); return v == null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('kikitori.' + key, JSON.stringify(value)); } catch (e) { /* private mode: keep going */ }
    }
  };

  /* ---------- state ---------- */
  const state = {
    apiReady: false, apiFailed: false, widget: null, pending: null,
    query: '', typed: '', total: null, track: 0, videoId: null, clipTime: -1,
    playing: false, speed: 1, wantSpeed: 1,
    targetText: '', targetCid: null, views: 0, searchSeq: 0,
    autoNext: !!store.get('autoNext', false), repeats: Number(store.get('repeats', 1)) || 1,
    entry: null
  };

  /* ---------- text helpers ---------- */
  const RE_JA = /[぀-ヿ㐀-䶿一-鿿豈-﫿々〆ｦ-ﾟ]/;
  const RE_KANA_ONLY = /^[぀-ゟ゠-ヿー・]+$/;
  const RE_ROMAJI = /^[A-Za-zĀ-ſ'\- ]+$/;
  const hasJapanese = (s) => RE_JA.test(s);
  const isKanaOnly = (s) => RE_KANA_ONLY.test(s);
  const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const cleanQuery = (raw) => {
    let s = String(raw == null ? '' : raw);
    if (s.normalize) s = s.normalize('NFKC');
    return s.replace(/\s+/g, ' ').trim();
  };

  // YouGlish sends captions through escape(); the searched word sits between [[[ and ]]].
  function decodeCaption(raw) {
    return String(raw == null ? '' : raw).replace(/%u([0-9a-fA-F]{4})|%([0-9a-fA-F]{2})/g,
      (m, u, h) => String.fromCharCode(parseInt(u || h, 16)));
  }
  function parseCaption(raw) {
    const text = decodeCaption(raw).replace(/\s+/g, ' ').trim();
    const segs = [];
    const re = /\[\[\[([\s\S]*?)\]\]\]/g;
    let last = 0, m, hit = false;
    while ((m = re.exec(text))) {
      if (m.index > last) segs.push({ t: text.slice(last, m.index), hit: false });
      const prev = segs[segs.length - 1];
      if (prev && prev.hit) prev.t += m[1]; else segs.push({ t: m[1], hit: true });   // 食べ + た => one mark
      hit = true;
      last = m.index + m[0].length;
    }
    if (last < text.length) segs.push({ t: text.slice(last), hit: false });
    return { segs, hit, plain: segs.map((s) => s.t).join('') };
  }
  function renderSegs(node, segs) {
    node.textContent = '';
    for (const s of segs) node.appendChild(s.hit ? el('mark', null, s.t) : document.createTextNode(s.t));
  }

  /* ---------- dictionary (JMdict common words, loaded once in the background) ---------- */
  const dict = { promise: null, entries: null, byText: null, byReading: null, alt: null };
  function loadDict() {
    if (dict.promise) return dict.promise;
    dict.promise = fetch('data/dict.json')
      .then((r) => { if (!r.ok) throw new Error('dict ' + r.status); return r.json(); })
      .then((d) => {
        const E = d.entries, byText = new Map(), byReading = new Map();
        const add = (map, key, i) => { if (!key) return; const a = map.get(key); if (a) { if (a[a.length - 1] !== i) a.push(i); } else map.set(key, [i]); };
        for (let i = 0; i < E.length; i++) {
          const kj = E[i][0] ? E[i][0].split('|') : [], kn = E[i][1].split('|');
          for (const k of kj) add(byText, k, i);
          for (const k of kn) { add(byText, k, i); add(byReading, toHira(k), i); }
        }
        dict.entries = E; dict.byText = byText; dict.byReading = byReading; dict.alt = d.kanjiAlt || null;
        dict.look = d.kanjiLook || null; dict.read = d.kanjiRead || null; dict.compounds = d.compounds || null;
        // which word a form that fits two words belongs to, as the sentence collections use it (おります: 居る, not 降りる)
        return fetch('data/form-fix.json').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((f) => { dict.formFix = f; return true; });
      })
      .catch(() => false);
    return dict.promise;
  }
  function entryAt(i) {
    const e = dict.entries[i];
    const kanji = e[0] ? e[0].split('|') : [], kana = e[1].split('|'), uk = !!e[4];
    const primary = (uk || !kanji.length) ? kana[0] : kanji[0], raw = e[8] || '';
    return { kanji, kana, gloss: e[2], pos: e[3], uk, rank: e[5], id: e[6], jlpt: e[7] || 0, cls: raw === 'vx' ? regularClass(primary) : raw, rawCls: raw,
      basis: e[9] || '', split: e[10] || '', syn: e[11] ? e[11].split('|') : [], formation: e[12] || '', textbook: e[13] || '', register: e[14] || '', primary };
  }
  // Irregular verbs whose written forms still follow a regular pattern, so the questions can treat them as such:
  // 行く like 書く (except 行って), ある and くださる like る-verbs, 来る in kanji like 食べる (来ない, 来て, 来られる).
  function regularClass(w) {
    if (/(行く|いく|ゆく|逝く)$/.test(w)) return 'v5k';
    if (/^(ある|有る|在る)$/.test(w) || /(さる|しゃる)$/.test(w)) return 'v5r';
    if (/来る$/.test(w)) return 'v1';
    if (/(問う|訪う|乞う)$/.test(w)) return 'v5u';
    return 'vx';
  }
  // Words spelled exactly like q (in kanji or in kana).
  function lookupExact(q) {
    if (!dict.entries) return [];
    const ids = new Set(dict.byText.get(q) || []);
    if (isKanaOnly(q)) for (const i of (dict.byReading.get(toHira(q)) || [])) ids.add(i);
    const score = (e) => (e.primary === q ? 0 : e.kanji.indexOf(q) >= 0 ? 1 : 2);
    return Array.from(ids).map(entryAt).sort((a, b) => score(a) - score(b) || a.rank - b.rank);
  }
  // Words read as this kana string, one per spelling, most frequent first.
  function lookupReading(kana) {
    if (!dict.entries) return [];
    const seen = new Set(), out = [];
    for (const e of (dict.byReading.get(toHira(kana)) || []).map(entryAt).sort((a, b) => a.rank - b.rank)) {
      if (seen.has(e.primary)) continue;
      seen.add(e.primary); out.push(e);
    }
    return out;
  }

  /* ---------- romaji input ---------- */
  function romajiToKana(typed) {
    const wk = window.wanakana;
    if (!wk) return [];
    const base = typed.toLowerCase().replace(/[\s\-]/g, '');
    // A macron hides which long vowel is meant, so try the usual spellings.
    const forms = [base];
    if (/[Ā-ſ]/.test(base)) {
      const swap = (s, o, e) => s.replace(/ā/g, 'aa').replace(/ī/g, 'ii').replace(/ū/g, 'uu').replace(/ō/g, o).replace(/ē/g, e);
      forms.length = 0;
      forms.push(swap(base, 'ou', 'ei'), swap(base, 'oo', 'ee'));
    }
    const out = [];
    for (const f of forms) {
      let k;
      try { k = wk.toHiragana(f); } catch (e) { continue; }
      if (k && wk.isHiragana(k) && out.indexOf(k) < 0) out.push(k);
    }
    // "konnichiwa" is written こんにちは.
    for (const k of out.slice()) if (/わ$/.test(k)) out.push(k.replace(/わ$/, 'は'));
    return out;
  }
  function resolveRomaji(typed) {
    const kanaForms = romajiToKana(typed);
    if (!kanaForms.length) return Promise.resolve({ query: typed, note: null });
    const wait = Promise.race([loadDict(), new Promise((res) => setTimeout(() => res(false), 2500))]);
    return wait.then(() => {
      for (const kana of kanaForms) {
        const found = lookupReading(kana);
        if (found.length === 1) return { query: found[0].primary, note: { kind: 'resolved', typed, kana, entry: found[0] } };
        if (found.length > 1) return { query: kana, note: { kind: 'homophones', typed, kana, entries: found.slice(0, 5) } };
      }
      return { query: kanaForms[0], note: { kind: 'unknown', typed, kana: kanaForms[0] } };
    });
  }

  /* ---------- notices ---------- */
  function wordChip(word, gloss, opts) {
    const b = el('button', { type: 'button', class: 'chip' });
    b.appendChild(el('b', { lang: 'ja' }, word));
    if (gloss) b.appendChild(el('small', null, gloss));
    b.addEventListener('click', () => submitSearch(word, opts || { literal: true }));
    return b;
  }
  function showNotice(parts, chips) {
    const box = $('#notice');
    box.textContent = '';
    const p = el('p');
    for (const part of parts) p.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
    box.appendChild(p);
    if (chips && chips.length) { const row = el('div', { class: 'chips' }); chips.forEach((c) => row.appendChild(c)); box.appendChild(row); }
    box.hidden = false;
  }
  function hideNotice() { const box = $('#notice'); box.hidden = true; box.textContent = ''; }
  const ja = (text) => el('b', { lang: 'ja' }, text);

  function noticeForRomaji(note) {
    if (note.kind === 'resolved') {
      const chips = [wordChip(note.kana, 'as kana'), wordChip(note.typed, 'as typed')];
      showNotice(['Showing ', ja(note.entry.primary), ' for “' + note.typed + '”.'], chips);
    } else if (note.kind === 'homophones') {
      showNotice([ja(note.kana), ' can be several words. Pick one for more videos:'],
        note.entries.map((e) => wordChip(e.primary, e.gloss.split(';')[0])));
    } else {
      showNotice(['Searching ', ja(note.kana), ' for “' + note.typed + '”. Typing the word in Japanese finds more videos.'],
        [wordChip(note.typed, 'as typed')]);
    }
  }

  /* DEINFLECT START */
  /* ----- conjugated input (食べさせられなかった, 読んでいる, 高くなかった, 静かだった) -> its dictionary word, and the grammar that made it -----
     Each rule turns the end of a form back into the end of the form it was made from:
     { i: inflected ending, b: base ending, ik: what the inflected form conjugates as, bk: what the base must be, g: grammar }.
     Kinds: v1 る-verb, v5 う-verb, vs する, vk 来る, adj い-adjective, na な-adjective, nn な-adjective or noun, '' a finished form.
     The rules are the standard conjugation tables (the ones みんなの日本語 and GENKI teach), written out for every verb group. */
  const DEINFLECT = (() => {
    const R = [], add = (i, b, ik, bk, g) => R.push({ i, b, ik, bk, g });
    const ROWS = { u: 'わいうえお', k: 'かきくけこ', g: 'がぎぐげご', s: 'さしすせそ', t: 'たちつてと', n: 'なにぬねの', b: 'ばびぶべぼ', m: 'まみむめも', r: 'らりるれろ' };
    const TE = { u: 'って', t: 'って', r: 'って', k: 'いて', g: 'いで', s: 'して', n: 'んで', b: 'んで', m: 'んで' };
    const specs = [{ d: 'る', k: 'v1', neg: '', st: '', te: 'て', ps: ['られる', 'passpot'], cs: 'させる', pt: ['れる'], vo: 'よう', ba: 'れば', im: ['ろ', 'よ'], zu: '' }];
    for (const r in ROWS) {
      const w = ROWS[r];
      specs.push({ d: w[2], k: 'v5', neg: w[0], st: w[1], te: TE[r], ps: [w[0] + 'れる', 'pass'], cs: w[0] + 'せる', pt: [w[3] + 'る'], vo: w[4] + 'う', ba: w[3] + 'ば', im: [w[3]], zu: w[0], row: r });
    }
    specs.push({ d: 'する', k: 'vs', neg: 'し', st: 'し', te: 'して', ps: ['される', 'pass'], cs: 'させる', pt: ['できる', '出来る'], vo: 'しよう', ba: 'すれば', im: ['しろ', 'せよ'], zu: 'せ' });
    specs.push({ d: 'くる', k: 'vk', neg: 'こ', st: 'き', te: 'きて', ps: ['こられる', 'passpot'], cs: 'こさせる', pt: ['これる'], vo: 'こよう', ba: 'くれば', im: ['こい'], zu: 'こ' });
    specs.push({ d: '来る', k: 'vk', neg: '来', st: '来', te: '来て', ps: ['来られる', 'passpot'], cs: '来させる', pt: ['来れる'], vo: '来よう', ba: '来れば', im: ['来い'], zu: '来' });
    specs.push({ d: '行く', k: 'v5', te: '行って', only: 'te' }, { d: 'いく', k: 'v5', te: 'いって', only: 'te' }, { d: 'ゆく', k: 'v5', te: 'いって', only: 'te' });
    specs.push({ d: 'う', k: 'v5', te: 'うて', only: 'te' });                     // 問うた, 請うて
    // one-kanji する-verbs (罰する, 接する) also take 罰さない, 罰せられる
    specs.push({ d: 'する', k: 'vs', neg: 'さ', st: 'し', te: 'して', ps: ['せられる', 'pass'], cs: 'させる', pt: ['せる'], vo: 'しよう', ba: 'すれば', im: ['せよ'], zu: 'せ' });
    const POLITE = [['ます', 'masu'], ['ました', 'mashita'], ['ません', 'masen'], ['ませんでした', 'masen-deshita'], ['ましょう', 'mashou'], ['ませんか', 'masen-ka'],
      ['ましょうか', 'mashou-ka'], ['ますか', 'masu'], ['ましたか', 'mashita'], ['ませんでしたか', 'masen-deshita'], ['ましたら', 'tara'], ['まして', 'te']];
    const TE_AUX = [['いる', 'v1', 'te-iru'], ['る', 'v1', 'te-iru'], ['おく', 'v5', 'te-oku'], ['しまう', 'v5', 'te-shimau'], ['みる', 'v1', 'te-miru'],
      ['ある', 'v5', 'te-aru'], ['くる', 'vk', 'te-kuru'], ['来る', 'vk', 'te-kuru'], ['いく', 'v5', 'te-iku'], ['行く', 'v5', 'te-iku'], ['あげる', 'v1', 'te-ageru'],
      ['くれる', 'v1', 'te-kureru'], ['もらう', 'v5', 'te-morau'], ['いただく', 'v5', 'te-itadaku'], ['くださる', 'v5', 'te-kudasaru'], ['ください', '', 'te-kudasai'],
      ['くださいませんか', '', 'te-kudasai'], ['くれませんか', '', 'te-kudasai'], ['もいい', 'adj', 'te-mo-ii'], ['もいいです', '', 'te-mo-ii'], ['もかまわない', 'adj', 'te-mo-ii'],
      ['はいけない', 'adj', 'te-wa-ikenai'], ['はいけません', '', 'te-wa-ikenai'], ['はならない', 'adj', 'te-wa-ikenai'], ['はだめ', '', 'te-wa-ikenai'],
      ['ほしい', 'adj', 'te-hoshii'], ['欲しい', 'adj', 'te-hoshii'], ['も', '', 'temo'], ['おる', 'v5', 'te-iru'], ['下さい', '', 'te-kudasai'],
      ['くれ', '', 'te-kure'], ['頂く', 'v5', 'te-itadaku'], ['下さる', 'v5', 'te-kudasaru'], ['置く', 'v5', 'te-oku'], ['仕舞う', 'v5', 'te-shimau'], ['見る', 'v1', 'te-miru'],
      ['く', 'v5', 'te-iku'], ['った', '', 'te-iku'], ['って', '', 'te-iku']];                  // 持ってく, 持ってった: spoken 〜ていく
    const STEM = [['たい', 'adj', 'tai'], ['たがる', 'v5', 'tagaru'], ['ながら', '', 'nagara'], ['そう', 'na', 'sou'], ['すぎる', 'v1', 'sugiru'], ['過ぎる', 'v1', 'sugiru'],
      ['やすい', 'adj', 'yasui'], ['にくい', 'adj', 'nikui'], ['づらい', 'adj', 'nikui'], ['なさい', '', 'nasai'], ['に行く', 'v5', 'ni-iku'], ['にいく', 'v5', 'ni-iku'],
      ['に来る', 'vk', 'ni-iku'], ['にくる', 'vk', 'ni-iku'], ['方', '', 'kata'], ['かた', '', 'kata'], ['始める', 'v1', 'hajimeru'], ['はじめる', 'v1', 'hajimeru'],
      ['出す', 'v5', 'dasu'], ['だす', 'v5', 'dasu'], ['続ける', 'v1', 'tsuzukeru'], ['つづける', 'v1', 'tsuzukeru'], ['終わる', 'v5', 'owaru'], ['おわる', 'v5', 'owaru']];
    for (const S of specs) {
      const te = S.te, ta = te.replace(/て$/, 'た').replace(/で$/, 'だ'), base = te.slice(0, -1), voiced = /で$/.test(te);
      add(ta, S.d, '', S.k, 'ta'); add(ta + 'ら', S.d, '', S.k, 'tara'); add(ta + 'り', S.d, '', S.k, 'tari'); add(te, S.d, '', S.k, 'te');
      for (const [x, k, g] of TE_AUX) add(te + x, S.d, k, S.k, g);
      add(base + (voiced ? 'じゃう' : 'ちゃう'), S.d, 'v5', S.k, 'te-shimau'); add(base + (voiced ? 'どく' : 'とく'), S.d, 'v5', S.k, 'te-oku');
      add(base + (voiced ? 'じゃいけない' : 'ちゃいけない'), S.d, 'adj', S.k, 'te-wa-ikenai'); add(base + (voiced ? 'じゃだめ' : 'ちゃだめ'), S.d, '', S.k, 'te-wa-ikenai');
      add(base + (voiced ? 'じゃ' : 'ちゃ'), S.d, '', S.k, 'te-wa');                    // 食べちゃ（だめ）: spoken 〜ては
      add(ta + 'っけ', S.d, '', S.k, 'kke');
      if (S.only) continue;
      for (const [x, g] of POLITE) add(S.st + x, S.d, '', S.k, g);
      for (const [x, k, g] of STEM) add(S.st + x, S.d, k, S.k, g);
      add(S.neg + 'ない', S.d, 'adj', S.k, 'nai');
      add(S.zu + 'ず', S.d, '', S.k, 'zu'); add(S.zu + 'ずに', S.d, '', S.k, 'zu');
      add(S.neg + 'ないで', S.d, '', S.k, 'naide'); add(S.neg + 'ないでください', S.d, '', S.k, 'naide-kudasai');
      for (const [x, k] of [['なければならない', 'adj'], ['なければなりません', ''], ['なくてはいけない', 'adj'], ['なくてはいけません', ''], ['なくてはならない', 'adj'],
        ['なければいけない', 'adj'], ['なきゃ', ''], ['なくちゃ', ''], ['なきゃいけない', 'adj'], ['なくちゃいけない', 'adj']]) add(S.neg + x, S.d, k, S.k, 'nakereba');
      add(S.neg + 'なくてもいい', S.d, 'adj', S.k, 'nakute-mo-ii');
      add(S.ps[0], S.d, 'v1', S.k, S.ps[1]);
      for (const p of S.pt) add(p, S.d, 'v1', S.k, 'pot');
      add(S.cs, S.d, 'v1', S.k, 'caus');
      if (S.k === 'v5' && S.row !== 's') add(S.neg + 'される', S.d, 'v1', S.k, 'causpass');      // 書かされる: the short causative-passive
      add(S.vo, S.d, '', S.k, 'vol'); add(S.vo + 'と思う', S.d, 'v5', S.k, 'vol'); add(S.vo + 'とおもう', S.d, 'v5', S.k, 'vol');
      add(S.ba, S.d, '', S.k, 'ba');
      for (const m of S.im) add(m, S.d, '', S.k, 'imp');
      add(S.d + 'な', S.d, '', S.k, 'proh');
      add(S.d + 'こと', S.d, '', S.k, 'koto');
      add(S.d + 'だろう', S.d, '', S.k, 'darou'); add(S.d + 'でしょう', S.d, '', S.k, 'deshou');
      for (const x of ['べき', 'べきだ', 'べきです', 'べきではない', 'べきじゃない']) add(S.d + x, S.d, '', S.k, 'beki');
      if (S.k === 'vs') add('すべき', S.d, '', S.k, 'beki');
      add(S.d + 'らしい', S.d, 'adj', S.k, 'rashii');
      add(S.zu + 'ぬ', S.d, '', S.k, 'nai');                                       // 知らぬ, せぬ: written negative
      add(S.neg + 'ん', S.d, '', S.k, 'nai-col');                                 // 構わん, 分からん, 食べん: spoken negative
      for (const x of ['ねえ', 'ねー', 'ねぇ']) add(S.neg + x, S.d, '', S.k, 'nai-col');   // 知らねえ: rough spoken negative
      if (S.row === 'r') { add('んない', 'る', 'adj', 'v5', 'nai-col'); for (const x of ['んねえ', 'んねー', 'んねぇ']) add(x, 'る', '', 'v5', 'nai-col'); }   // 分かんない
      if (S.k === 'v1') add('んない', 'る', 'adj', 'v1', 'nai-col');               // 食べらんない is rare; 寝んない
      add(S.neg + 'へん', S.d, '', S.k, 'nai-kansai');                             // 分からへん: Kansai
      add(S.st + 'やがる', S.d, 'v5', S.k, 'yagaru');
      // 〜ば spoken: 行けば -> 行きゃ, 食べれば -> 食べりゃ, すれば -> すりゃ
      if (S.k === 'v5') add(S.row === 'u' ? 'や' : S.st + ({ u: 'ゃ', k: 'ゃ', g: 'ゃ', s: 'ゃ', t: 'ゃ', n: 'ゃ', b: 'ゃ', m: 'ゃ', r: 'ゃ' })[S.row], S.d, '', S.k, 'ba-col');
      if (S.k === 'v1') add('りゃ', S.d, '', S.k, 'ba-col');
      if (S.k === 'vs') add('すりゃ', S.d, '', S.k, 'ba-col');
      if (S.k === 'vk') add(S.d === 'くる' ? 'くりゃ' : '来りゃ', S.d, '', S.k, 'ba-col');
      if (S.st) add(S.st, S.d, '', S.k, 'renyou');                                 // 書き、 / 勉強し、: the continuative stem
      add(S.d + 'つもり', S.d, '', S.k, 'tsumori');
    }
    // casual pronunciation of い-adjectives: すごい -> すげえ, うまい -> うめー, ない -> ねえ, さむい -> さみい
    const SHIFT = { か: 'け', が: 'げ', さ: 'せ', ざ: 'ぜ', た: 'て', だ: 'で', な: 'ね', ば: 'べ', ま: 'め', ら: 'れ', わ: 'え', や: 'え', こ: 'け', ご: 'げ', そ: 'せ',
      と: 'て', ど: 'で', の: 'ね', ぼ: 'べ', も: 'め', ろ: 'れ', よ: 'え' };
    for (const a in SHIFT) for (const x of ['え', 'ー', 'ぇ']) add(SHIFT[a] + x, a + 'い', '', 'adj', 'adj-col');
    const SHIFT_U = { く: 'き', ぐ: 'ぎ', す: 'し', つ: 'ち', ぬ: 'に', ぶ: 'び', む: 'み', る: 'り' };
    for (const u in SHIFT_U) for (const x of ['い', 'ー']) add(SHIFT_U[u] + x, u + 'い', '', 'adj', 'adj-col');
    // sentence endings of everyday speech, after any plain form or noun: いいじゃん, 行くっす, 分かんないんだ, 来るって
    for (const [i, g] of [['じゃん', 'jan'], ['じゃんか', 'jan'], ['っす', 'ssu'], ['っすね', 'ssu'], ['んだ', 'n-da'], ['んです', 'n-da'], ['のだ', 'n-da'], ['のです', 'n-da'],
      ['んだよ', 'n-da'], ['んだろう', 'n-da'], ['でしょ', 'deshou'], ['だろ', 'darou'], ['んだって', 'tte'], ['もん', 'mon'], ['けど', 'kedo'], ['けれど', 'kedo'],
      ['かな', 'kana'], ['かもしれない', 'kamo'], ['かもしれません', 'kamo']]) add(i, '', '', '', g);     // not し, から, って: they end ordinary words too
    // る-verbs (and the る-verb-like 〜られる, 〜させる, 〜ている): the continuative stem is the word without る (食べ、, 解消され、, 意味しており)
    for (const c of 'えけげせぜてでねへべぺめれいきぎしじちぢにひびぴみり') add(c, c + 'る', '', 'v1', 'renyou');
    // い-adjectives (ない and 〜たい change the same way: 食べなかった, 食べたくない)
    for (const [i, ik, g] of [['かった', '', 'adj-ta'], ['かったです', '', 'adj-ta'], ['くない', 'adj', 'adj-nai'], ['くないです', '', 'adj-nai'], ['くありません', '', 'adj-nai'],
      ['くなかったです', '', 'adj-nakatta'], ['くありませんでした', '', 'adj-nakatta'], ['くて', '', 'adj-te'], ['く', '', 'adj-adv'], ['ければ', '', 'adj-ba'],
      ['かったら', '', 'adj-tara'], ['くても', '', 'adj-temo'], ['さ', '', 'adj-sa'], ['そう', 'na', 'adj-sou'], ['すぎる', 'v1', 'adj-sugiru'], ['過ぎる', 'v1', 'adj-sugiru'],
      ['くなる', 'v5', 'adj-naru'], ['がる', 'v5', 'adj-garu'], ['いです', '', 'adj-desu'], ['くする', 'vs', 'adj-suru'], ['いだろう', '', 'darou'],
      ['いでしょう', '', 'deshou'], ['かろう', '', 'darou'], ['き', '', 'adj-ki'], ['いらしい', 'adj', 'rashii'], ['いべき', '', 'beki'], ['けりゃ', '', 'ba-col'],
      ['きゃ', '', 'ba-col']]) add(i, 'い', ik, 'adj', g);
    // な-adjectives (and nouns for the copula forms)
    for (const [i, ik, bk, g] of [['だ', '', 'nn', 'na-da'], ['です', '', 'nn', 'na-desu'], ['だった', '', 'nn', 'na-ta'], ['でした', '', 'nn', 'na-deshita'],
      ['じゃない', 'adj', 'nn', 'na-nai'], ['ではない', 'adj', 'nn', 'na-nai'], ['じゃありません', '', 'nn', 'na-nai'], ['ではありません', '', 'nn', 'na-nai'],
      ['じゃないです', '', 'nn', 'na-nai'], ['じゃありませんでした', '', 'nn', 'na-nakatta'], ['ではありませんでした', '', 'nn', 'na-nakatta'],
      ['な', '', 'na', 'na-na'], ['に', '', 'na', 'na-ni'], ['で', '', 'na', 'na-de'], ['なら', '', 'nn', 'na-nara'], ['だったら', '', 'nn', 'na-tara'],
      ['そう', 'na', 'na', 'na-sou'], ['すぎる', 'v1', 'na', 'na-sugiru'], ['になる', 'v5', 'nn', 'na-naru'], ['にする', 'vs', 'na', 'na-suru'], ['さ', '', 'na', 'adj-sa'],
      ['である', 'v5', 'nn', 'na-dearu'], ['であった', '', 'nn', 'na-ta'], ['であり', '', 'nn', 'na-dearu'], ['でない', 'adj', 'nn', 'na-nai'],
      ['だろう', '', 'nn', 'darou'], ['でしょう', '', 'nn', 'deshou'], ['ではなく', '', 'nn', 'na-nai'], ['でなく', '', 'nn', 'na-nai'], ['らしい', 'adj', 'nn', 'rashii'],
      ['ではある', 'v5', 'nn', 'na-dearu'], ['でなければ', '', 'nn', 'na-nai']]) add(i, '', ik, bk, g);
    const byLast = new Map();
    for (const r of R) { const c = r.i[r.i.length - 1]; if (!byLast.has(c)) byLast.set(c, []); byLast.get(c).push(r); }
    return { rules: R, byLast: byLast };
  })();
  // Does a dictionary entry fit the kind a rule needs? する-forms need a する-noun (勉強する) or する itself.
  function entriesFor(base, kind) {
    if (kind === 'vs') {
      if (!/する$/.test(base)) return [];
      const noun = base.slice(0, -2);
      if (!noun) return lookupExact('する').filter((e) => e.rawCls === 'vx' || e.cls === 'vx');
      const whole = lookupExact(base).filter((e) => e.rawCls === 'vx' && (e.kanji.indexOf(base) >= 0 || e.kana.indexOf(base) >= 0));   // 罰する, 接する
      return whole.concat(lookupExact(noun).filter((e) => e.cls === 'vs'));
    }
    if (!base) return [];
    return lookupExact(base).filter((e) => {
      if (!(e.primary === base || e.kanji.indexOf(base) >= 0 || e.kana.indexOf(base) >= 0)) return false;
      if (kind === '') return true;                                              // after じゃん, っす, けど...: any word
      if (kind === 'v1') return e.cls === 'v1' && e.rawCls !== 'vx';             // 来る only through its own rules
      if (kind === 'v5') return /^v5/.test(e.cls);
      if (kind === 'vk') return e.rawCls === 'vx' && /(来る|くる)$/.test(base);
      if (kind === 'adj') return e.cls === 'adj-i' || e.cls === 'adjx';
      if (kind === 'na') return e.cls === 'adj-na';
      if (kind === 'nn') return /^(adj-na|n|vs)$/.test(e.cls);
      return false;
    });
  }
  // All the ways the text can be a form of a dictionary word; each with its steps from the dictionary form outwards.
  function deinflectAll(q) {
    const out = [], seen = new Set(), queue = [{ s: q, k: '', steps: [] }];
    let n = 0;
    while (queue.length && n++ < 400) {
      const node = queue.shift();
      if (node.steps.length >= 7) continue;
      for (const r of (DEINFLECT.byLast.get(node.s[node.s.length - 1]) || [])) {
        if (!node.s.endsWith(r.i) || (node.k && r.ik !== node.k && !(node.k === 'nn' && r.ik === 'na'))) continue;
        const stem = node.s.slice(0, node.s.length - r.i.length);
        if (!stem && r.b.length < 2 && r.bk !== 'vs') continue;          // a rule may cover a whole word (行った, きた, した), not leave nothing
        const base = stem + r.b, key = base + '|' + r.bk;
        if (seen.has(key)) continue;
        seen.add(key);
        const steps = [{ g: r.g, form: node.s }].concat(node.steps);
        for (const e of entriesFor(base, r.bk)) out.push({ entry: e, base: base, kind: r.bk, steps: steps });
        if (base.length >= 1) queue.push({ s: base, k: r.bk, steps: steps });
      }
    }
    // the shortest explanation first (できない is 出来る + ない, not する + potential + ない), then the word the sentences use with this
    // exact form (dict.formFix, counted in the corpus), then the easier word (行った: 行く before 行う), the core irregular verbs
    // (きた: 来る before 着る), and the more common one
    const ease = (o) => o.entry.jlpt || 0, core = (o) => (o.entry.rawCls === 'vx' ? 0 : 1);
    const fix = dict.formFix && dict.formFix[q], fixed = (o) => (fix && o.entry.id === fix ? 0 : 1);
    out.sort((a, b) => fixed(a) - fixed(b) || a.steps.length - b.steps.length || ease(b) - ease(a) || core(a) - core(b) || a.entry.rank - b.entry.rank);
    const best = [], ids = new Set();
    for (const o of out) if (!ids.has(o.entry.id)) { ids.add(o.entry.id); best.push(o); }
    return best;
  }
  function deinflect(q) {
    let all = deinflectAll(q);
    const bare = q.replace(/(か|ね|よ|の|ぞ|わ|よね)+$/, '');               // 書いてもいいですか, 行きましょうね
    if (!all.length && bare && bare !== q) all = deinflectAll(bare);
    if (!all.length) return null;
    const top = all[0];
    // other readings worth offering: words a learner may mean, not rare spellings (いい is not 易々)
    const alts = all.slice(1).filter((o) => o.entry.rank < 55 || (o.entry.jlpt >= 3 && o.entry.basis !== 'b')).slice(0, 3);
    return { entry: top.entry, base: top.base, kind: top.kind, steps: mergeSteps(top.steps), alts: alts };
  }
  // 食べさせる (causative) + られる (passive) are taught as one form: 使役受身形.
  function mergeSteps(steps) {
    const out = [];
    for (const s of steps) {
      const prev = out[out.length - 1];
      if (prev && prev.g === 'caus' && /^(pass|passpot)$/.test(s.g)) { out[out.length - 1] = { g: 'causpass', form: s.form }; continue; }
      out.push(s);
    }
    return out;
  }
  /* DEINFLECT END */

  /* ---------- word details + kana hints (needs the dictionary) ---------- */
  function showWord(query) {
    let exact = lookupExact(query);
    const wide = query.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xFEE0));   // the dictionary writes １０分
    if (!exact.length && wide !== query) exact = lookupExact(wide);
    const same = (o) => o.primary === query || o.primary === wide || o.kanji.indexOf(query) >= 0 || o.kanji.indexOf(wide) >= 0 || o.kana.indexOf(query) >= 0
      || (isKanaOnly(query) && o.kana.some((k) => toHira(k) === toHira(query)));                  // ウザい is ウザイ / うざい
    let e = exact.length && same(exact[0]) ? exact[0] : null;
    const base = e ? null : deinflect(query);            // 食べた is not in the dictionary, 食べる is
    if (base) e = base.entry;
    state.entry = e;
    $('#word-main').textContent = query;
    const reading = base ? 'a form of ' + e.primary + (e.kana[0] !== e.primary ? '（' + e.kana[0] + '）' : '') : (e && e.kana[0] !== query ? e.kana[0] : '');
    $('#word-reading').textContent = reading;
    // A kana query that is the reading of several kanji words has no single meaning to show.
    // A kana query is ambiguous when other words with that reading are about as common: はし (橋, 端, 箸) is, あめ (雨, 飴) is not.
    // A hiragana query never means a katakana loanword (たぶん is 多分, not タブン).
    const rivals = e && !base && isKanaOnly(query) && e.primary !== query
      ? lookupReading(query).filter((o) => o.primary !== e.primary && !(/[\u3041-\u309f]/.test(query) && /^[\u30a0-\u30ff]+$/.test(o.primary)) && o.rank < e.rank + 25
        && (o.rank < 55 || /^[alxm]$/.test(o.basis))) : [];                     // a rival must be a common word or on a JLPT list (まじ is マジ, not 真風)
    // Several words share this reading (はし: 橋, 端, 箸): study the most common one now, and say which others it could be.
    const kanaAmbiguous = false;
    if (rivals.length) $('#word-reading').textContent = (e.kana[0] !== query ? e.kana[0] + ' · ' : '') + 'also ' + rivals.slice(0, 3).map((o) => o.primary).join('、') + ' (choose above)';
    const showGloss = e && !kanaAmbiguous;
    $('#word-gloss').textContent = showGloss ? e.gloss : '';
    const pos = $('#word-pos');
    pos.textContent = showGloss ? e.pos + (e.register ? ' · ' + e.register : '') : '';
    pos.hidden = !(showGloss && e.pos);
    $('#jisho-word').href = 'https://jisho.org/search/' + encodeURIComponent(query);
    $('#word').hidden = false;
    renderSaveButton();
    renderLevel(showGloss ? e : null);
    if (base && showGloss) renderFormLevel(e, base);
    renderStudy(e, query, !!kanaAmbiguous, base);
  }
  function renderFormLevel(e, info) {
    const fl = formLevel(e, info), pill = $('#word-jlpt');
    pill.dataset.level = String(fl.level);
    pill.textContent = fl.level ? 'This form: JLPT N' + fl.level : 'Casual form · not in the JLPT';
    $('#word-jlpt-note').textContent = fl.parts.map((p) => p.what + ' ' + (p.level ? 'N' + p.level : 'casual') + (p.note && p.note !== 'the word' ? ' (' + p.note + ')' : '')).join(' + ')
      + (fl.level ? ' → the hardest part sets the level' : '') + (fl.casual && fl.level ? '; part of it is casual speech the JLPT does not test' : '');
  }
  function kanaHints(query, seq) {
    if (!isKanaOnly(query)) return;
    const others = lookupReading(query).filter((e) => e.primary !== query && !(/[\u3041-\u309f]/.test(query) && /^[\u30a0-\u30ff]+$/.test(e.primary))).slice(0, 5);
    if (!others.length || seq !== state.searchSeq || !$('#notice').hidden) return;
    showNotice([ja(query), others.length === 1 ? ' is usually written in kanji. More videos use that spelling:' : ' is the reading of several words. More videos use the kanji:'],
      others.map((e) => wordChip(e.primary, e.gloss.split(';')[0])));
  }

  /* ---------- the YouGlish widget ---------- */
  function loadWidgetScript() {
    window.onYouglishAPIReady = function () {
      state.apiReady = true;
      if (state.pending != null) { const q = state.pending; state.pending = null; fetchVideos(q); }
    };
    const s = document.createElement('script');
    s.src = WIDGET_SRC; s.async = true; s.charset = 'utf-8';
    s.onerror = function () {
      state.apiFailed = true;
      if (state.pending != null) { state.pending = null; showScreenMessage('Not connected', '', 'YouGlish could not be reached. Check your connection or content blocker, then reload the page.'); }
    };
    document.head.appendChild(s);
  }
  function buildWidget() {
    const host = $('#widget-host');
    host.textContent = '';
    host.appendChild(el('div', { id: 'yg-widget' }));
    state.widget = new window.YG.Widget('yg-widget', {
      components: 32,                 // video only; captions and controls are drawn by this page
      autoStart: 1,
      backgroundColor: '#0A0E16',
      events: {
        onFetchDone: onFetchDone, onVideoChange: onVideoChange,
        onCaptionChange: onCaptionChange, onCaptionConsumed: onCaptionConsumed,
        onPlayerStateChange: onPlayerStateChange, onSpeedChange: onSpeedChange, onError: onError
      }
    });
  }
  function fetchVideos(query) {
    if (state.apiFailed) { showScreenMessage('Not connected', '', 'YouGlish could not be reached. Check your connection or content blocker, then reload the page.'); return; }
    if (!state.apiReady) { state.pending = query; return; }
    if (!state.widget) buildWidget();
    $('#screen-msg').hidden = true;
    $('#widget-host').hidden = false;
    state.widget.fetch(query, LANG);
  }

  /* ---------- search ---------- */
  function submitSearch(raw, opts) {
    opts = opts || {};
    const typed = cleanQuery(raw);
    const input = $('#q');
    if (!typed) { input.focus(); return; }
    const seq = ++state.searchSeq;
    hideNotice();
    input.blur();
    if (!opts.literal && !hasJapanese(typed) && RE_ROMAJI.test(typed)) {
      setSearching(typed);
      resolveRomaji(typed).then((res) => {
        if (seq !== state.searchSeq) return;
        if (res.note) noticeForRomaji(res.note);
        startSearch(res.query, typed, seq);
      });
    } else {
      startSearch(typed, typed, seq);
    }
  }
  function setSearching(text) {
    $('#meta').hidden = false;
    $('#meta-total').textContent = '';
    const label = $('#meta-total-label');
    label.textContent = 'Looking for videos with ';
    label.appendChild(ja(text));
    label.appendChild(document.createTextNode(' …'));
    $('#meta-pos').textContent = '';
  }
  function startSearch(query, typed, seq) {
    state.query = query; state.typed = typed;
    state.total = null; state.track = 0; state.videoId = null; state.clipTime = -1;
    state.targetText = ''; state.targetCid = null; state.views = 0; state.entry = null;
    $('#q').value = query;
    $('#starter').hidden = true;
    $('#search-hint').hidden = true;
    if ($('#widget-host').hidden) { $('#slate').hidden = true; $('#controls').hidden = true; }
    else { $('#slate-target').textContent = '…'; $('#slate-live').hidden = true; }   // a video is on screen: keep the layout still
    setSearching(query);
    try { history.replaceState(null, '', '?q=' + encodeURIComponent(query)); } catch (e) { /* file:// or sandbox */ }
    document.title = query + ' · Kikitori';
    $('#word-main').textContent = query;
    $('#word-reading').textContent = ''; $('#word-gloss').textContent = ''; $('#word-pos').hidden = true;
    $('#word-level').hidden = true; $('#study').hidden = true; study.seq++;
    $('#jisho-word').href = 'https://jisho.org/search/' + encodeURIComponent(query);
    $('#word').hidden = false;
    renderSaveButton();
    fetchVideos(query);
    loadDict().then((ok) => { if (ok && seq === state.searchSeq) { showWord(query); kanaHints(query, seq); } });
  }

  /* ---------- widget events ---------- */
  function onFetchDone(e) {
    const total = parseInt(e && e.totalResult, 10) || 0;
    state.total = total;
    $('#meta').hidden = false;
    $('#meta-total').textContent = fmt(total);
    const label = $('#meta-total-label');
    label.textContent = (total === 1 ? 'video with ' : 'videos with ');
    label.appendChild(ja(state.query));
    if (total === 0) {
      $('#meta-pos').textContent = '';
      $('#widget-host').hidden = true;
      $('#slate').hidden = true;
      $('#controls').hidden = true;
      showScreenMessage('No videos', state.query, 'YouGlish has no video with this exact text. Try the dictionary form, a shorter piece of the phrase, or the kanji spelling.');
    } else {
      $('#screen-msg').hidden = true;
      $('#widget-host').hidden = false;
      $('#slate').hidden = false;
      $('#controls').hidden = false;
      renderPosition();
      ensureFurigana();
    }
    addHistory(state.query, total);
  }
  function onVideoChange(e) {
    state.track = Number(e && e.trackNumber) || 0;
    state.videoId = e && e.video ? String(e.video) : null;
    state.clipTime = -1; state.views = 0; state.targetCid = null; state.targetText = '';
    furi.target = null; furi.live = null;
    $('#slate-target').textContent = '…';
    $('#slate-live').hidden = true;
    renderPosition();
    renderLinks();
  }
  function onCaptionChange(e) {
    const cap = parseCaption(e && e.caption);
    if (!cap.plain) return;
    const t = Number(e && e.current_time);
    if (cap.hit || !state.targetText) {
      // The sentence that holds the word stays pinned on the slate.
      state.targetText = cap.plain;
      state.targetCid = e && e.id != null ? String(e.id) : null;
      if (t >= 0) state.clipTime = Math.floor(t);
      furi.target = cap; furi.live = null;
      renderCaption($('#slate-target'), cap);
      $('#slate-live').hidden = true;
      renderLinks();
    } else {
      // The video has moved on: show the running caption under the pinned sentence.
      const live = $('#slate-live');
      furi.live = cap;
      renderCaption(live, cap);
      live.hidden = false;
    }
  }
  function onCaptionConsumed(e) {
    if (!state.autoNext || !state.widget) return;
    if (state.targetCid == null || !e || String(e.id) !== state.targetCid) return;
    state.views += 1;
    if (state.views < state.repeats) state.widget.replay();
    else if (state.track < state.total) state.widget.next();
  }
  function onPlayerStateChange(e) {
    const st = Number(e && e.state);
    state.playing = st === 1 || st === 3;
    $('#pause-label').textContent = state.playing ? 'Pause' : 'Play';
    if (st === 1 && state.wantSpeed !== state.speed && state.widget) state.widget.setSpeed(state.wantSpeed);
  }
  function onSpeedChange(e) {
    const sp = Number(e && e.speed);
    if (!sp) return;
    state.speed = sp; state.wantSpeed = sp;     // also follows a change made in the YouTube player's own menu
    renderSpeed(sp);
  }
  function onError(e) {
    const code = Number(e && e.code);
    if (code === 3) { if (state.total == null) toast('YouGlish is slow to answer. Still trying…'); }
    else if (code === 2) toast('This browser is too old for the video player.');
    else if (code === 1) toast('That video could not be played. Try the next one.');
  }

  /* ---------- rendering ---------- */
  function showScreenMessage(kicker, line, note) {
    const box = $('#screen-msg');
    box.textContent = '';
    box.appendChild(el('p', { class: 'screen-kicker' }, kicker));
    if (line) box.appendChild(el('p', { class: 'slate-line', lang: 'ja' }, line));
    box.appendChild(el('p', { class: 'screen-note' }, note));
    box.hidden = false;
  }
  function renderPosition() {
    const has = state.total > 0 && state.track > 0;
    $('#meta-pos').textContent = has ? 'Video ' + fmt(state.track) + ' of ' + fmt(state.total) : '';
    $('#prev-btn').disabled = !(state.track > 1);
    $('#next-btn').disabled = !(state.total > 0 && state.track < state.total);
  }
  function renderLinks() {
    const yt = $('#yt-link');
    if (state.videoId) {
      yt.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(state.videoId) + (state.clipTime > 0 ? '&t=' + state.clipTime + 's' : '');
      yt.hidden = false;
    } else yt.hidden = true;
    const js = $('#jisho-sentence');
    if (state.targetText) { js.href = 'https://jisho.org/search/' + encodeURIComponent(state.targetText); js.hidden = false; }
    else js.hidden = true;
    $('#copy-btn').hidden = !state.targetText;
  }
  function renderSpeed(sp) {
    document.querySelectorAll('#speed button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === sp)));
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function copyText(text, done) {
    const fallback = () => {
      const ta = el('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? done : 'Copying is blocked here. Select the text and copy it by hand.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(done), fallback);
    else fallback();
  }

  /* ---------- history + saved words ---------- */
  function addHistory(q, n) {
    if (!q) return;
    const list = store.get('history', []).filter((h) => h && h.q !== q);
    list.unshift({ q: q, n: n, t: Date.now() });
    store.set('history', list.slice(0, 30));
    renderHistory();
  }
  function listRow(word, sub, onOpen, onRemove, removeLabel) {
    const li = el('li');
    const w = el('button', { type: 'button', class: 'w', lang: 'ja' }, word);
    w.addEventListener('click', onOpen);
    const x = el('button', { type: 'button', class: 'x', 'aria-label': removeLabel }, '×');
    x.addEventListener('click', onRemove);
    li.appendChild(w); li.appendChild(el('span', { class: 'sub' }, sub)); li.appendChild(x);
    return li;
  }
  function renderHistory() {
    const list = store.get('history', []);
    const ul = $('#history-list');
    ul.textContent = '';
    for (const h of list) {
      ul.appendChild(listRow(h.q, h.n === 0 ? 'no videos' : fmt(h.n) + (h.n === 1 ? ' video' : ' videos'),
        () => submitSearch(h.q, { literal: true }),
        () => { store.set('history', store.get('history', []).filter((o) => o.q !== h.q)); renderHistory(); },
        'Remove ' + h.q + ' from recent searches'));
    }
    $('#history-empty').hidden = list.length > 0;
    $('#history-clear').hidden = list.length === 0;
  }
  const savedList = () => store.get('saved', []);
  const isSaved = (w) => savedList().some((s) => s.w === w);
  function toggleSaved() {
    const w = state.query;
    if (!w) return;
    let list = savedList();
    if (isSaved(w)) list = list.filter((s) => s.w !== w);
    else {
      const e = state.entry;
      list.unshift({ w: w, r: e && e.kana[0] !== w ? e.kana[0] : '', g: e && $('#word-gloss').textContent ? e.gloss : '', t: Date.now() });
    }
    store.set('saved', list.slice(0, 500));
    renderSaved(); renderSaveButton();
  }
  function renderSaveButton() {
    const b = $('#save-btn'), on = !!state.query && isSaved(state.query);
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '★ Saved' : '☆ Save word';
  }
  function renderSaved() {
    const list = savedList();
    const ul = $('#saved-list');
    ul.textContent = '';
    for (const s of list) {
      ul.appendChild(listRow(s.w, [s.r, s.g].filter(Boolean).join(' · '),
        () => submitSearch(s.w, { literal: true }),
        () => { store.set('saved', savedList().filter((o) => o.w !== s.w)); renderSaved(); renderSaveButton(); },
        'Remove ' + s.w + ' from saved words'));
    }
    $('#saved-empty').hidden = list.length > 0;
    $('#saved-copy').hidden = list.length === 0;
  }

  /* ---------- study: JLPT level, example sentences, official questions, practice ---------- */
  const U0 = '⟦', U1 = '⟧';                    // marks around an underlined part
  const RE_KANJI = /[一-鿿々]/;
  const RE_HIRA = /^[぀-ゟ]*$/;
  const RE_KANA = /^[぀-ヿー]*$/;
  const LEVEL_NOTE = { 5: 'beginner', 4: 'elementary', 3: 'intermediate', 2: 'upper intermediate', 1: 'advanced' };
  const BASIS_NOTE = {
    a: 'two independent JLPT word lists agree', l: 'on a JLPT word list', m: 'the JLPT word lists differ; the better-supported level is shown',
    x: 'used in real JLPT exams at this level', e: 'estimated: not on the JLPT word lists, judged by how common the word is and its kanji'
  };
  const TYPE_JA = { reading: '漢字読み', orthography: '表記', formation: '語形成', context: '文脈規定', paraphrase: '言い換え類義', usage: '用法' };
  // The instructions as each level's test booklet words them.
  const KANA_INSTR = {
    reading: '＿＿＿の ことばは ひらがなで どう かきますか。１・２・３・４から いちばん いい ものを ひとつ えらんで ください。',
    orthography: '＿＿＿の ことばは どう かきますか。１・２・３・４から いちばん いい ものを ひとつ えらんで ください。',
    context: '（　　　）に なにを いれますか。１・２・３・４から いちばん いい ものを ひとつ えらんで ください。',
    paraphrase: '＿＿＿の ぶんと だいたい おなじ いみの ぶんが あります。１・２・３・４から いちばん いい ものを ひとつ えらんで ください。',
    usage: 'つぎの ことばの つかいかたで いちばん いい ものを １・２・３・４から ひとつ えらんで ください。'
  };
  const INSTR_JA = {
    5: Object.assign({}, KANA_INSTR, { context: '（　　　）に なにが はいりますか。１・２・３・４から いちばん いい ものを ひとつ えらんで ください。' }),
    4: KANA_INSTR,
    3: {
      reading: '＿＿＿のことばの読み方として最もよいものを、１・２・３・４から一つえらびなさい。',
      orthography: '＿＿＿のことばを漢字で書くとき、最もよいものを、１・２・３・４から一つえらびなさい。',
      context: '（　　　）に入れるのに最もよいものを、１・２・３・４から一つえらびなさい。',
      paraphrase: '＿＿＿に意味が最も近いものを、１・２・３・４から一つえらびなさい。',
      usage: 'つぎのことばの使い方として最もよいものを、１・２・３・４から一つえらびなさい。'
    },
    2: {
      reading: '＿＿＿の言葉の読み方として最もよいものを、１・２・３・４から一つ選びなさい。',
      orthography: '＿＿＿の言葉を漢字で書くとき、最もよいものを、１・２・３・４から一つ選びなさい。',
      formation: '（　　　）に入れるのに最もよいものを、１・２・３・４から一つ選びなさい。',
      context: '（　　　）に入れるのに最もよいものを、１・２・３・４から一つ選びなさい。',
      paraphrase: '＿＿＿の言葉に意味が最も近いものを、１・２・３・４から一つ選びなさい。',
      usage: '次の言葉の使い方として最もよいものを、１・２・３・４から一つ選びなさい。'
    }
  };
  INSTR_JA[1] = INSTR_JA[2];
  const instrFor = (type, level) => { const set = INSTR_JA[level >= 1 && level <= 5 ? level : 1]; return set[type] || set.context; };
  const study = { entry: null, query: '', examples: [], showAll: false, seq: 0, shards: new Map(), official: null, pools: null, shardData: null };

  function loadShard(id) {
    const key = String(id % 64).padStart(2, '0');
    if (!study.shards.has(key)) {
      study.shards.set(key, fetch('data/ex/' + key + '.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
    }
    return study.shards.get(key);
  }
  // The sentence arrives with readings in braces, 学{がっ}校{こう}; keep that for display and a plain copy for everything else.
  // Rows come from Tatoeba (t), JESC film and TV subtitles (j), Japanese Wikipedia (w, with the article title), or are made by the page (m).
  const rowToEx = (x) => ({ ja: x[0].replace(/\{[^}]*\}/g, ''), furi: x[0], en: x[1], id: x[2], by: x[3], form: x[4], cuts: x[5] || null, src: x[6] || 't' });
  function sourceOf(src, id, by) {
    if (src === 'j') return { en: 'JESC (film and TV subtitles)', ja: 'JESC（映画・ドラマの字幕）', href: 'https://nlp.stanford.edu/projects/jesc/' };
    if (src === 'w') return { en: 'Wikipedia: ' + by, ja: 'ウィキペディア「' + by + '」', href: 'https://ja.wikipedia.org/wiki/' + encodeURIComponent(String(by).replace(/ /g, '_')) };
    if (src === 'm') return { en: 'Made by this page (no collection had a sentence with this word)', ja: 'このページの作例', href: '' };
    return { en: 'Tatoeba #' + id + (by ? ' by ' + by : ''), ja: 'Tatoeba #' + id, href: 'https://tatoeba.org/sentences/show/' + id };
  }
  // "例文：<link>" under a question, or the English label under an example.
  function sourceLine(node, src, id, by, inJapanese) {
    const s = sourceOf(src, id, by), label = inJapanese ? s.ja : s.en;
    if (inJapanese) node.appendChild(document.createTextNode('例文：'));
    node.appendChild(s.href ? el('a', { href: s.href, target: '_blank', rel: 'noopener' }, label) : document.createTextNode(label));
  }
  const NO_EN = { w: 'From Japanese Wikipedia; no English translation.', m: '' };
  function loadExamples(id) { return loadShard(id).then((sh) => (sh[id] || []).map(rowToEx)); }
  function loadOfficial() {
    if (!study.official) study.official = fetch('data/jlpt-official.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return study.official;
  }
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };

  // Text with ⟦…⟧ marks becomes text with <u> (or <mark>) elements.
  function renderMarked(node, text, tag) {
    node.textContent = '';
    const parts = String(text).split(new RegExp('[' + U0 + U1 + ']'));
    parts.forEach((p, i) => { if (p) node.appendChild(i % 2 ? el(tag || 'u', null, p) : document.createTextNode(p)); });
  }
  // A sentence with readings in braces becomes <ruby> elements; the searched word is wrapped in <mark>.
  // Draw text pieces, some with a reading (<ruby>), wrapping the given character ranges in <mark>.
  // Ranges are [from, to] (highlighted) or [from, to, 'u'] (underlined).
  function drawRuby(node, segs, ranges) {
    node.textContent = '';
    const tagAt = (at, len) => { for (const r of ranges) if (at < r[1] && at + len > r[0]) return r[2] || 'mark'; return null; };
    let box = null, boxTag = null;
    const target = (tag) => {
      if (!tag) { box = null; boxTag = null; return node; }
      if (!box || boxTag !== tag) { box = el(tag); boxTag = tag; node.appendChild(box); }
      return box;
    };
    for (const s of segs) {
      if (s.r) {
        // The highlight goes on the word only, inside the <ruby>, so its reading stays above the coloured box.
        const tag = tagAt(s.at, s.t.length), ruby = el('ruby', tag ? { class: tag === 'mark' ? 'hit' : 'hit-u' } : null);
        ruby.appendChild(tag ? el(tag, null, s.t) : document.createTextNode(s.t));
        ruby.appendChild(el('rt', null, s.r));
        box = null; boxTag = null;
        node.appendChild(ruby);
      } else {
        for (let i = 0; i < s.t.length; i++) target(tagAt(s.at + i, 1)).appendChild(document.createTextNode(s.t[i]));
      }
    }
    node.normalize();
  }
  // A sentence with readings in braces, 学{がっ}校{こう}, drawn with furigana; the searched word is marked.
  function renderFurigana(node, furi, form) {
    const segs = [];
    const re = /([^{}])\{([^}]*)\}|([^{}]+?)(?=[^{}]\{|$)/g;
    let m, plain = '';
    while ((m = re.exec(furi))) {
      const t = m[1] != null ? m[1] : m[3], r = m[1] != null ? m[2] : '', prev = segs[segs.length - 1];
      if (r && prev && prev.r) { prev.t += t; prev.r += r; }          // 学+校 share one reading box, so the kanji stay evenly spaced
      else segs.push({ t: t, r: r, at: plain.length });
      plain += t;
    }
    const from = plain.indexOf(form);
    drawRuby(node, segs, from < 0 ? [] : [[from, from + form.length]]);
  }

  /* ----- furigana for the video captions: readings worked out in the browser by the kuromoji tokenizer ----- */
  const furi = { on: store.get('furigana', true) !== false, tokenizer: null, promise: null, target: null, live: null };
  function loadTokenizer() {
    if (furi.promise) return furi.promise;
    furi.promise = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'vendor/kuromoji/kuromoji.js';
      s.onerror = () => resolve(false);
      s.onload = () => {
        try {
          window.kuromoji.builder({ dicPath: 'vendor/kuromoji/dict/' }).build((err, tk) => { furi.tokenizer = err ? null : tk; resolve(!err && !!tk); });
        } catch (e) { resolve(false); }
      };
      document.head.appendChild(s);
    });
    return furi.promise;
  }
  // 食べる + たべる -> 食{た}べる: the kana already written in the word are not repeated above it.
  function alignReading(surface, reading) {
    const runs = surface.match(/[一-鿿々ヶ]+|[^一-鿿々ヶ]+/g) || [];
    const isKanji = (r) => /[一-鿿々ヶ]/.test(r[0]);
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = reading.match(new RegExp('^' + runs.map((r) => (isKanji(r) ? '(.+)' : esc(toHira(r)))).join('') + '$'));
    if (!m) return [{ t: surface, r: reading }];
    let g = 1;
    return runs.map((r) => ({ t: r, r: isKanji(r) ? m[g++] : '' }));
  }
  // Counting words the tokenizer reads digit by digit (一人 as いち+にん).
  const FIXED = { 一人: 'ひとり', 二人: 'ふたり', 一つ: 'ひとつ', 二つ: 'ふたつ', 三つ: 'みっつ', 四つ: 'よっつ', 五つ: 'いつつ', 六つ: 'むっつ', 七つ: 'ななつ', 八つ: 'やっつ', 九つ: 'ここのつ', 二十歳: 'はたち', 一日中: 'いちにちじゅう',
    // grammar terms: the tokenizer reads 形 as かた/がた here, but the textbooks say けい
    使役受身形: 'しえきうけみけい', 受身形: 'うけみけい', 可能形: 'かのうけい', 命令形: 'めいれいけい', 意向形: 'いこうけい', 使役形: 'しえきけい',
    条件形: 'じょうけんけい', 辞書形: 'じしょけい', 連用形: 'れんようけい', 中止形: 'ちゅうしけい', 普通形: 'ふつうけい', 否定形: 'ひていけい',
    過去否定形: 'かこひていけい', 過去形: 'かこけい', 丁寧形: 'ていねいけい', ていねい形: 'ていねいけい', 文型練習: 'ぶんけいれんしゅう', 活用: 'かつよう' };
  const RE_FIXED = new RegExp('(' + Object.keys(FIXED).sort((x, y) => y.length - x.length).join('|') + ')');
  function captionSegs(text) {
    const segs = [];
    let base = 0;
    for (const chunk of text.split(RE_FIXED)) {
      if (FIXED[chunk]) { let off = base; for (const part of alignReading(chunk, FIXED[chunk])) { segs.push({ t: part.t, r: part.r, at: off }); off += part.t.length; } }
      else if (chunk) tokenSegs(chunk, base, segs);
      base += chunk.length;
    }
    return segs;
  }
  function tokenSegs(text, base, segs) {
    let pos = 0;
    for (const tk of furi.tokenizer.tokenize(text)) {
      const at = text.indexOf(tk.surface_form, pos);
      if (at < 0) continue;
      if (at > pos) segs.push({ t: text.slice(pos, at), r: '', at: base + pos });
      const rd = tk.reading && tk.reading !== '*' ? toHira(tk.reading) : '';
      if (rd && RE_KANJI.test(tk.surface_form)) {
        let off = base + at;
        for (const part of alignReading(tk.surface_form, rd)) { segs.push({ t: part.t, r: part.r, at: off }); off += part.t.length; }
      } else segs.push({ t: tk.surface_form, r: '', at: base + at });
      pos = at + tk.surface_form.length;
    }
    if (pos < text.length) segs.push({ t: text.slice(pos), r: '', at: base + pos });
  }
  // A caption line, with furigana when it is switched on and the tokenizer has arrived.
  function renderCaption(node, cap) {
    if (!cap) return;
    if (furi.on && furi.tokenizer) {
      try {
        const ranges = [];
        let at = 0;
        for (const s of cap.segs) { if (s.hit) ranges.push([at, at + s.t.length]); at += s.t.length; }
        drawRuby(node, captionSegs(cap.plain), ranges);
        return;
      } catch (e) { /* fall through to the plain caption */ }
    }
    renderSegs(node, cap.segs);
  }
  function redrawCaptions() {
    renderCaption($('#slate-target'), furi.target);
    if (furi.live) renderCaption($('#slate-live'), furi.live);
  }
  function renderFuriButton(loading) {
    const b = $('#furi-btn');
    b.setAttribute('aria-pressed', String(furi.on));
    b.textContent = !furi.on ? 'Furigana off' : loading ? 'Furigana loading…' : 'Furigana on';
  }
  function ensureFurigana() {
    if (!furi.on || furi.tokenizer) { renderFuriButton(false); return; }
    renderFuriButton(true);
    loadTokenizer().then((ok) => {
      renderFuriButton(false);
      if (ok) redrawCaptions(); else if (furi.on) toast('Furigana could not be loaded. Captions show without it.');
    });
  }
  const wrapFirst = (text, part, by) => { const i = text.indexOf(part); return i < 0 ? text : text.slice(0, i) + by + text.slice(i + part.length); };

  function renderLevel(e) {
    const row = $('#word-level');
    if (!e) { row.hidden = true; renderBooks(null); return; }
    const pill = $('#word-jlpt');
    pill.dataset.level = String(e.jlpt || 0);
    pill.dataset.basis = e.basis || '';
    pill.textContent = e.basis === 'c' ? 'Casual · not in the JLPT' : !e.jlpt ? 'Beyond N1' : 'JLPT N' + e.jlpt + (e.basis === 'e' ? ' (estimate)' : '');
    if (e.basis === 'c') pill.dataset.level = '0';
    $('#word-jlpt-note').textContent = e.basis === 'c' ? (e.register || 'slang / colloquial') + ': everyday spoken Japanese the JLPT does not test; no JLPT list or textbook has it'
      : !e.jlpt ? 'rarer than the vocabulary the JLPT N1 expects'
      : LEVEL_NOTE[e.jlpt] + (BASIS_NOTE[e.basis] ? ' · ' + BASIS_NOTE[e.basis] : '');
    row.hidden = false;
    renderBooks(e);
  }
  // Where the big textbooks teach the word: みんなの日本語 第12課, GENKI I 第5課 (GENKI II from lesson 13).
  function renderBooks(e) {
    const box = $('#word-books');
    box.textContent = '';
    const tags = (e && e.textbook ? e.textbook.split(' ') : []).map((t) => {
      const n = Number(t.slice(1));
      if (t[0] === 'M') return [0, n, 'みんなの日本語 ' + (n <= 25 ? '初級I' : '初級II') + ' 第' + n + '課'];
      if (t[0] === 'G') return [1, n, 'GENKI ' + (n <= 12 ? 'I' : 'II') + ' 第' + n + '課'];
      if (t[0] === 'R') return [2, n, 'まるごと ' + ['', '入門 (A1)', '初級1 (A2)', '初級2 (A2)', '初中級 (A2/B1)'][n]];
      if (t[0] === 'Q') return [3, n, 'Quartet ' + (n <= 6 ? 'I' : 'II') + ' 第' + n + '課'];
      return null;
    }).filter(Boolean).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const seen = new Set();
    for (const t of tags) {
      if (seen.has(t[2])) continue;
      seen.add(t[2]);
      box.appendChild(el('span', { class: 'book', lang: 'ja' }, t[2]));
    }
    if (seen.size) box.insertBefore(el('span', { class: 'book-label' }, 'Taught in'), box.firstChild);
    box.hidden = seen.size === 0;
  }

  function renderStudy(e, query, ambiguous, formInfo) {
    const my = ++study.seq;
    study.entry = ambiguous ? null : e; study.query = query; study.examples = []; study.showAll = false;
    study.formInfo = ambiguous ? null : (formInfo || null); study.formRow = null;
    $('#form').hidden = true;
    $('#study').hidden = false;
    $('#examples-list').textContent = '';
    $('#official-list').textContent = '';
    $('#practice-list').textContent = '';
    $('#examples-more').hidden = true;
    $('#official-block').hidden = true;
    $('#practice-block').hidden = true;
    $('#grammar-practice').textContent = ''; $('#reading-practice').textContent = ''; $('#drill-practice').textContent = '';
    $('#sec-grammar').hidden = true; $('#sec-reading').hidden = true; $('#sec-drill').hidden = true;
    const empty = $('#examples-empty');
    empty.hidden = false;
    renderOfficial(my);
    const grammarReady = renderGrammar(ambiguous ? null : e, my);
    if (!study.entry) {
      empty.textContent = '';
      if (ambiguous) empty.textContent = 'This spelling can be several words. Pick one above to see its examples and practice.';
      else wordsInside(empty, query);
      return;
    }
    empty.textContent = 'Loading examples…';
    Promise.all([loadExamples(e.id), loadShard(e.id), grammarReady]).then(([list, shard]) => {
      if (my !== study.seq) return;
      study.examples = list.length ? list : [madeExample(e)];     // every word gets at least one sentence
      study.shardData = shard;
      renderExamples();
      renderDrills();
      renderPractice();
      renderGrammarPractice();
      renderForm(e, query, study.formInfo, my);
    });
  }
  // Text that is not one dictionary word (a phrase, a name): offer the dictionary words inside it, each with its own examples and practice.
  function wordsInside(node, query) {
    const found = [], q = String(query || '');
    for (let i = 0; i < q.length; i++) {
      for (let j = Math.min(q.length, i + 8); j > i; j--) {
        const w = q.slice(i, j);
        if (w.length < 2 && !RE_KANJI.test(w)) continue;
        const hit = lookupExact(w)[0];
        if (hit && found.indexOf(hit.primary) < 0) { found.push(hit.primary); i = j - 1; break; }
      }
    }
    if (!found.length) { node.textContent = 'This is not a word in the dictionary, so examples and practice cannot be made for it. Try the dictionary form of a word, such as 食べる for 食べた.'; return; }
    node.appendChild(document.createTextNode('This is not one dictionary word. Study a word in it: '));
    found.slice(0, 6).forEach((w, i) => {
      if (i) node.appendChild(document.createTextNode(' '));
      const b = el('button', { type: 'button', class: 'chip', lang: 'ja' }, w);
      b.addEventListener('click', () => submitSearch(w));
      node.appendChild(b);
    });
  }
  // The same simple sentences the data build makes, in case a word arrives with none.
  function madeExample(e) {
    const w = e.primary, vk = /^v/.test(e.cls) ? verbKind(e) : null;
    let s;
    if (vk && vk.kind !== 'suru') s = 'きのう、' + conjugate(vk, 'stem') + 'ました。';
    else if (e.cls === 'vs' || (vk && vk.kind === 'suru')) s = '来週、' + w + (e.cls === 'vs' ? 'する' : '') + '予定です。';
    else if (/^adj/.test(e.cls)) s = 'それはとても' + w + 'です。';
    else if (e.cls === 'n') s = w + 'について調べました。';
    else s = '「' + w + '」という言葉を習いました。';
    const form = vk && vk.kind !== 'suru' ? conjugate(vk, 'stem') + 'ました' : w;
    return { ja: s, furi: s, en: '', id: 'm', by: '', form: form, cuts: null, src: 'm' };
  }

  function renderExamples() {
    const list = study.examples, ol = $('#examples-list'), empty = $('#examples-empty'), more = $('#examples-more');
    ol.textContent = '';
    empty.hidden = true;
    for (const x of (study.showAll ? list : list.slice(0, 3))) {
      const li = el('li');
      const ja = el('p', { class: 'ex-ja', lang: 'ja' });
      if (x.src === 'm' && x.furi === x.ja) furiganize(ja, x.ja); else renderFurigana(ja, x.furi || x.ja, x.form);
      li.appendChild(ja);
      const en = x.en || NO_EN[x.src] || '';
      if (en) li.appendChild(el('p', { class: 'ex-en' + (x.en ? '' : ' muted') }, en));
      const src = el('p', { class: 'ex-src' });
      sourceLine(src, x.src, x.id, x.by, false);
      li.appendChild(src);
      ol.appendChild(li);
    }
    more.hidden = list.length <= 3;
    more.textContent = study.showAll ? 'Show fewer' : 'Show all ' + list.length;
  }

  /* One multiple-choice card, used for official and for generated questions. */
  // A JLPT level badge: N5..N1, or "casual" for slang and spoken forms the JLPT does not test.
  function levelPill(lv, note) {
    const t = lv ? 'N' + lv : 'casual';
    return el('span', { class: 'jlpt-mini q-level', 'data-level': String(lv || 0), title: note || (lv ? 'JLPT N' + lv : 'casual Japanese, not tested in the JLPT') }, t);
  }
  // The meaning of a choice that is a word (or a form of one), for explanations.
  function glossOf(text) {
    const plain = String(text).replace(new RegExp('[' + U0 + U1 + ']', 'g'), '').trim();
    if (!plain || !dict.entries) return '';
    const e = lookupExact(plain).find((o) => o.primary === plain || o.kanji.indexOf(plain) >= 0 || o.kana.indexOf(plain) >= 0) || (deinflect(plain) || {}).entry;
    return e ? (e.primary !== plain ? e.primary + ': ' : '') + e.gloss.split(';').slice(0, 2).join(';') : '';
  }
  // 解説: every choice with what it means, the right one marked.
  function explainChoices(box, opts, ans, intro) {
    if (intro) box.appendChild(el('p', { class: 'q-why' }, intro));
    const ul = el('ul', { class: 'q-why-list' });
    opts.forEach((o, i) => {
      const li = el('li', { class: i === ans ? 'right' : '' });
      li.appendChild(el('span', { class: 'n' }, String(i + 1)));
      const w = el('b', { lang: 'ja' }, String(o).replace(new RegExp('[' + U0 + U1 + ']', 'g'), ''));
      li.appendChild(w);
      const g = glossOf(o);
      li.appendChild(document.createTextNode(g ? ' — ' + g : ''));
      if (i === ans) li.appendChild(el('span', { class: 'q-tick' }, ' ✔'));
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  function questionCard(spec) {
    const art = el('article', { class: 'q' });
    const head = el('div', { class: 'q-head' });
    head.appendChild(el('p', { class: 'q-kicker', lang: 'ja' }, spec.kicker));
    if (spec.level != null) head.appendChild(levelPill(spec.level, spec.levelNote));
    art.appendChild(head);
    if (spec.sub) art.appendChild(el('p', { class: 'q-sub', lang: 'ja' }, spec.sub));
    const instr = el('p', { class: 'q-instr', lang: 'ja' }, spec.instr);
    art.appendChild(instr);
    const stem = el('p', { class: 'q-stem' + (spec.pre ? ' pre' : ''), lang: 'ja' });
    renderMarked(stem, spec.stem);
    art.appendChild(stem);
    const long = spec.opts.some((o) => o.replace(new RegExp('[' + U0 + U1 + ']', 'g'), '').length > 9);
    const ol = el('ol', { class: 'q-opts' + (long ? ' long' : '') });
    const result = el('p', { class: 'q-result', role: 'status', lang: 'ja' });
    const after = el('div', { class: 'q-after' });
    after.hidden = true;
    const hasAfter = !!(spec.after || spec.explain);
    const spans = [];
    spec.opts.forEach((o, i) => {
      const li = el('li'), b = el('button', { type: 'button', class: 'q-opt', lang: 'ja' });
      b.appendChild(el('span', { class: 'n' }, String(i + 1)));
      const t = el('span');
      renderMarked(t, o);
      spans.push(t);
      b.appendChild(t);
      b.addEventListener('click', () => {
        const all = ol.querySelectorAll('button');
        all.forEach((x) => { x.disabled = true; });
        all[spec.ans].classList.add('right');
        if (i !== spec.ans) b.classList.add('wrong');
        result.textContent = i === spec.ans ? '正解です。' : '不正解です。正しい答えは ' + (spec.ans + 1) + ' です。';
        result.className = 'q-result ' + (i === spec.ans ? 'ok' : 'no');
        if (hasAfter) after.hidden = false;
        furiganize(stem, spec.stem);                               // readings appear only once the question is answered
        spans.forEach((sp, k) => furiganize(sp, spec.opts[k]));
      });
      li.appendChild(b); ol.appendChild(li);
    });
    art.appendChild(ol); art.appendChild(result);
    if (spec.after) spec.after(after);
    if (spec.explain) { const why = el('div', { class: 'q-explain' }); why.appendChild(el('p', { class: 'q-why-h', lang: 'ja' }, '解説')); spec.explain(why); after.appendChild(why); }
    if (hasAfter) art.appendChild(after);
    if (spec.source) { const s = el('p', { class: 'q-source' }); spec.source(s); art.appendChild(s); }
    return art;
  }

  /* Questions from the official practice workbook that involve this word. */
  function officialType(q, level) {
    // N2 and N1 word-formation items share their instruction with the blank-filling ones; their choices are one or two characters.
    if (q.type === 'context' && level <= 2 && q.opts.every((o) => o.length <= 2)) return 'formation';
    return q.type;
  }
  function renderOfficial(my) {
    loadOfficial().then((data) => {
      if (my !== study.seq || !data) return;
      const e = study.entry, keys = [study.query];
      if (e) { keys.push.apply(keys, e.kanji); if (e.uk || !e.kanji.length) keys.push.apply(keys, e.kana); }
      const best = new Map();
      for (const k of keys) for (const pair of (data.index[k] || [])) if (!(best.get(pair[0]) >= pair[1])) best.set(pair[0], pair[1]);
      let hits = Array.from(best.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      const tested = hits.filter((h) => h[1] >= 1);
      hits = tested.length ? tested.slice(0, 3) : hits.slice(0, 1);
      const box = $('#official-list');
      box.textContent = '';
      if (!hits.length) { $('#official-block').hidden = true; return; }
      const role = ['この言葉が問題文の中にある問題', 'この言葉が選択肢にある問題', 'この言葉が問われている問題'];
      for (const h of hits) {
        const q = data.questions[h[0]], paper = data.papers[q.paper], type = officialType(q, paper.level);
        box.appendChild(questionCard({
          kicker: '公式問題　N' + paper.level + '　' + TYPE_JA[type], sub: role[h[1]],
          instr: instrFor(type, paper.level), stem: q.stem, opts: q.opts, ans: q.ans - 1, level: paper.level,
          explain: (b) => explainChoices(b, q.opts, q.ans - 1, 'The answer key of the official workbook gives ' + q.ans + '.'),
          source: (p) => {
            p.appendChild(document.createTextNode('出典：日本語能力試験公式ウェブサイト（https://www.jlpt.jp/） '));
            p.appendChild(el('a', { href: paper.url + '#page=' + q.page, target: '_blank', rel: 'noopener' },
              '『日本語能力試験 公式問題集 第二集』N' + paper.level + ' 言語知識（文字・語彙）' + q.n + '番 ↗'));
          }
        }));
      }
      $('#official-block').hidden = false;
    });
  }

  /* ----- practice questions in JLPT format, made from the example sentences ----- */
  // How the word is written in a sentence, split into the dictionary form's ending and the ending used here.
  function formParts(e, form) {
    const heads = e.kanji.concat(e.kana);
    for (const head of heads) if (form === head) return { head: head, tailH: '', tailF: '', reading: RE_KANJI.test(head) ? e.kana[0] : head };
    const verbish = /^(v1|v5[a-z]|adj-i)$/.test(e.cls), nounish = /^(n|vs|adj-na|adv)$/.test(e.cls);
    if (!verbish && !nounish) return null;
    for (const head of heads) {
      let p = 0;
      while (p < head.length && p < form.length && head[p] === form[p]) p++;
      const tailH = head.slice(p), tailF = form.slice(p);
      if (p === 0 || !RE_HIRA.test(tailH) || !RE_KANA.test(tailF)) continue;
      if (verbish ? tailH.length !== 1 : tailH.length !== 0) continue;
      if (verbish && !tailF) continue;                          // a bare stem (食べ in 食べたい) is not a whole word to ask about
      if (RE_KANJI.test(head)) {
        const kana = e.kana[0];
        if (!kana.endsWith(tailH)) continue;
        return { head: head, tailH: tailH, tailF: tailF, reading: kana.slice(0, kana.length - tailH.length) + tailF };
      }
      return { head: head, tailH: tailH, tailF: tailF, reading: form };
    }
    return null;
  }
  // Nouns are asked about on their own: 勉強 rather than 勉強し, 満足 rather than 満足な.
  function normForm(e, form) {
    if (!/^(n|vs|adj-na|adv)$/.test(e.cls)) return form;
    const h = e.kanji.concat(e.kana).find((w) => form !== w && form.startsWith(w));
    return h || form;
  }
  // Another word put into the same form: 食べて -> 起きて, 勉強 -> 練習.
  function inflectAs(o, parts, asReading) {
    const base = asReading ? o.kana[0] : o.primary;
    if (!base.endsWith(parts.tailH) || base.length <= parts.tailH.length) return null;
    let tail = parts.tailF;
    if (o.rawCls === 'vx' && o.cls === 'v5k' && /^い[てた]/.test(tail)) tail = 'っ' + tail.slice(1);       // 行って, not 行いて
    if (o.rawCls === 'vx' && /^(問|訪|乞)う$/.test(base.slice(-2)) && /^っ[てた]/.test(tail)) tail = 'う' + tail.slice(1);   // 問うて
    return base.slice(0, base.length - parts.tailH.length) + tail;
  }
  const VOICE = (() => {
    const m = {}, add = (a, b) => { (m[a] = m[a] || []).push(b); (m[b] = m[b] || []).push(a); };
    'かが きぎ くぐ けげ こご さざ しじ すず せぜ そぞ ただ ちぢ つづ てで とど はば ひび ふぶ へべ ほぼ はぱ ひぴ ふぷ へぺ ほぽ'.split(' ').forEach((p) => add(p[0], p[1]));
    return m;
  })();
  // Near-miss readings of the kind the test uses: voiced or not, long or short vowel, small っ or not, ゃゅょ swapped.
  function readingVariants(r) {
    const voiced = new Set(), length = new Set(), sokuon = new Set();
    for (let i = 0; i < r.length; i++) {
      for (const a of (VOICE[r[i]] || [])) voiced.add(r.slice(0, i) + a + r.slice(i + 1));
      if (r[i] === 'う' && i > 0 && /[おこそとのほもよろごぞどぼぽょゅくすつぬふむゆるぐずづぶぷ]/.test(r[i - 1])) length.add(r.slice(0, i) + r.slice(i + 1));
      if (/[ょゅ]/.test(r[i]) && r[i + 1] !== 'う') length.add(r.slice(0, i + 1) + 'う' + r.slice(i + 1));
      if ('ゃゅょ'.indexOf(r[i]) >= 0) for (const y of 'ゃゅょ') if (y !== r[i]) length.add(r.slice(0, i) + y + r.slice(i + 1));
      if (r[i] === 'っ') sokuon.add(r.slice(0, i) + r.slice(i + 1));
      else if (i > 0 && /[かきくけこさしすせそたちつてとぱぴぷぺぽ]/.test(r[i]) && !/[っんゃゅょ]/.test(r[i - 1]) && r[i - 1] !== r[i]) sokuon.add(r.slice(0, i) + 'っ' + r.slice(i));
    }
    const out = shuffle(Array.from(length)).slice(0, 2).concat(shuffle(Array.from(voiced)).slice(0, 2), shuffle(Array.from(sokuon)).slice(0, 1));
    return shuffle(out.filter((v) => v !== r && v));
  }
  function pool(cls) {
    if (!study.pools) {
      study.pools = new Map();
      dict.entries.forEach((raw, i) => {
        if (!raw[7]) return;
        const key = raw[8] || 'pos:' + raw[3];                 // words with no inflection class pool by part of speech
        const a = study.pools.get(key); if (a) a.push(i); else study.pools.set(key, [i]);
      });
    }
    return study.pools.get(cls) || [];
  }
  const poolKey = (e) => e.cls || 'pos:' + e.pos;
  function byId(id) {
    if (!dict.byId) { dict.byId = new Map(); dict.entries.forEach((raw, i) => dict.byId.set(raw[6], i)); }
    const i = dict.byId.get(id);
    return i == null ? null : entryAt(i);
  }
  // English meaning words, so that choices with the same meaning as the answer are never offered as "wrong".
  const STOPW = new Set('the and for with from into something someone thing etc not one'.split(' '));
  const tokCache = new Map();
  function toks(g) {
    if (tokCache.has(g)) return tokCache.get(g);
    const out = new Set();
    for (let t of (String(g).toLowerCase().replace(/\([^)]*\)/g, ' ').match(/[a-z]{3,}/g) || [])) {
      if (STOPW.has(t)) continue;
      for (const suf of ['ingly', 'edly', 'ness', 'ally', 'ing', 'ity', 'ed', 'ly', 'es', 's']) if (t.endsWith(suf) && t.length - suf.length >= 4) { t = t.slice(0, -suf.length); break; }
      out.add(t);
    }
    tokCache.set(g, out);
    return out;
  }
  function related(a, b) {
    if (a.syn.indexOf(b.primary) >= 0 || b.syn.indexOf(a.primary) >= 0) return true;
    const ta = toks(a.gloss);
    for (const t of toks(b.gloss)) if (ta.has(t)) return true;
    return false;
  }
  const IS_KATA = (w) => /^[゠-ヿー]+$/.test(w);
  // Wrong choices of the same kind and a similar level, put into the same form. The closer they look to the answer, the better.
  function pickWords(e, parts, n, opts) {
    const level = e.jlpt || 1, seen = new Set([opts.right]), cands = [];
    for (const i of shuffle(pool(poolKey(e))).slice(0, 600)) {
      const o = entryAt(i);
      if (o.id === e.id || !o.jlpt || Math.abs(o.jlpt - level) > 1 || related(e, o)) continue;
      if (opts.avoid && opts.avoid.some((a) => a.id === o.id || related(a, o))) continue;
      const f = inflectAs(o, parts, opts.asReading);
      if (!f || seen.has(f)) continue;
      if (opts.asReading && (!RE_KANJI.test(o.primary) || Math.abs(f.length - opts.right.length) > 1)) continue;
      if (!opts.asReading && RE_KANJI.test(opts.right) !== RE_KANJI.test(f)) continue;
      let s = Math.random();
      if (o.jlpt <= level) s += 1;                                                     // as hard as the answer, or harder
      if (IS_KATA(o.primary) === IS_KATA(e.primary)) s += 1.5; else s -= 3;            // katakana with katakana
      for (const ch of e.primary) if (RE_KANJI.test(ch) && o.primary.indexOf(ch) >= 0) { s += 2; break; }   // shares a kanji
      if (o.primary.length === e.primary.length) s += 0.5;
      if (opts.asReading && f.length === opts.right.length) s += 1;
      seen.add(f); cands.push([s, f]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    return cands.slice(0, n).map((c) => c[1]);
  }
  const levelOf = (e) => (e.basis === 'c' ? 0 : (e.jlpt || 1));
  function finish(type, stem, right, wrong, x, e) {
    wrong = Array.from(new Set(wrong.filter((w) => w && w !== right)));
    if (wrong.length < 3) return null;
    const opts = shuffle([right].concat(wrong.slice(0, 3)));
    const ans = opts.indexOf(right), gloss = e.gloss.split(';').slice(0, 2).join(';');
    const explain = (box) => {
      const r = String(right).replace(new RegExp('[' + U0 + U1 + ']', 'g'), '');
      if (type === 'reading') box.appendChild(el('p', { class: 'q-why', lang: 'ja' }, '「' + (x.form || e.primary) + '」の読み方は「' + r + '」です。(' + gloss + ') The other choices are readings that do not exist for this word: a sound changed, lengthened or shortened, or another reading of one of its kanji.'));
      else if (type === 'orthography') box.appendChild(el('p', { class: 'q-why', lang: 'ja' }, '「' + e.kana[0] + '」は「' + r + '」と書きます。(' + gloss + ') The other choices use a kanji that looks or sounds alike but is wrong here.'));
      else if (type === 'usage') box.appendChild(el('p', { class: 'q-why' }, '「' + e.primary + '」 means ' + gloss + '. Only sentence ' + (ans + 1) + ' uses it with that meaning; in the others another word belongs there.'));
      else explainChoices(box, opts, ans, type === 'paraphrase' ? 'The underlined part means the same as choice ' + (ans + 1) + '.' : type === 'formation' ? 'This is the part that forms the word in the sentence.' : 'Only choice ' + (ans + 1) + ' fits the meaning of the sentence.');
    };
    return {
      type: type, instr: instrFor(type, e.jlpt || 1), stem: stem, opts: opts, ans: ans, level: levelOf(e), explain: explain,
      after: (box) => {
        const ja = el('p', { lang: 'ja' });
        renderFurigana(ja, x.furi || x.ja, x.form);          // now that it is answered, show the readings
        box.appendChild(ja);
        if (x.en) box.appendChild(el('p', { class: 'q-en' }, x.en));
      },
      source: x.id ? (p) => sourceLine(p, x.src, x.id, x.by, true) : null
    };
  }

  // 漢字読み: readings that differ in one sound, or in the reading of one kanji (けんぎゃく／かんぎゃく／けんきゃく for かんきゃく).
  function makeReading(e, x) {
    const parts = formParts(e, x.form);
    if (!parts || !RE_KANJI.test(x.form) || !RE_HIRA.test(parts.reading)) return null;
    const right = parts.reading, n = parts.head.length - parts.tailH.length;
    const segs = e.split && parts.head === e.kanji[0] ? e.split.split('|') : null;
    const known = new Set(e.kana.map(toHira));
    let wrong = [];
    if (segs && segs.length === parts.head.length) {
      const kidx = [];
      for (let i = 0; i < n; i++) if (RE_KANJI.test(parts.head[i])) kidx.push(i);
      // A sound change first (かん -> がん, きゃく -> ぎゃく); another on-reading of the same kanji only when it is close in length.
      const altFor = (i) => {
        const s = segs[i], c = parts.head[i];
        const near = readingVariants(s).filter((v) => v && v !== s);
        const other = shuffle(((dict.read && dict.read[c]) || []).filter((r) => r !== s && Math.abs(r.length - s.length) <= 1));
        return (Math.random() < 0.7 ? near.concat(other) : other.concat(near)).filter((v) => v && v !== s);
      };
      const build = (rep) => segs.slice(0, n).map((s, i) => (rep[i] != null ? rep[i] : s)).join('') + parts.tailF;
      if (kidx.length >= 2) {
        const alts = new Map(kidx.map((i) => [i, altFor(i)]));
        const ready = kidx.filter((i) => alts.get(i).length);
        if (ready.length >= 2) {                     // the grid: change one kanji, the other, or both
          const pick = shuffle(ready).slice(0, 2), A = alts.get(pick[0])[0], B = alts.get(pick[1])[0];
          wrong = [build({ [pick[0]]: A }), build({ [pick[1]]: B }), build({ [pick[0]]: A, [pick[1]]: B })];
        } else if (ready.length === 1) {             // only one kanji has a near reading: several changes to that one
          const i = ready[0];
          wrong = alts.get(i).slice(0, 3).map((v) => build({ [i]: v }));
        }
      }
    }
    const uniq = (list) => Array.from(new Set(list.filter((w) => w && w !== right && !known.has(w))));
    wrong = uniq(wrong);
    if (wrong.length < 3 && !parts.tailH && RE_KANJI.test(parts.head) && parts.head.length > 1) wrong = uniq(wrong.concat(readingVariants(right)));
    if (wrong.length < 3) wrong = uniq(wrong.concat(pickWords(e, parts, 3 - wrong.length, { asReading: true, right: right })));
    return finish('reading', wrapFirst(x.ja, x.form, U0 + x.form + U1), right, wrong.slice(0, 3), x, e);
  }

  // 表記: kanji that sound the same or look alike, in the grid the test uses (満足／万足／満続／万続).
  // Katakana that look alike, as the N5 and N4 tests use them (ワイシャツ / ワイシャソ / ウイシャツ).
  const KATA_LIKE = { シ: 'ツ', ツ: 'シ', ソ: 'ン', ン: 'ソ', ク: 'ケタ', ケ: 'ク', タ: 'ク', ウ: 'ワ', ワ: 'ウ', ス: 'ヌ', ヌ: 'ス', ナ: 'メ', メ: 'ナ',
    ル: 'レ', レ: 'ル', チ: 'テ', テ: 'チ', ロ: 'コ', コ: 'ロ', ア: 'マ', マ: 'ア', フ: 'ワ', ノ: 'メ', ト: 'ド', ド: 'ト', バ: 'パ', パ: 'バ', ビ: 'ピ', ピ: 'ビ',
    ブ: 'プ', プ: 'ブ', ベ: 'ペ', ペ: 'ベ', ボ: 'ポ', ポ: 'ボ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ッ: 'ツ', ー: '' };
  function makeKatakana(e, x) {
    const w = x.form;
    if (!IS_KATA(w) || w.length < 2) return null;
    const spots = Array.from(w).map((c, i) => (KATA_LIKE[c] != null ? i : -1)).filter((i) => i >= 0);
    if (!spots.length) return null;
    const swap = (i) => { const alts = KATA_LIKE[w[i]]; return alts === '' ? '' : alts[Math.floor(Math.random() * alts.length)]; };
    const make = (rep) => Array.from(w).map((c, i) => (rep[i] != null ? rep[i] : c)).join('');
    const wrong = new Set();
    const pick = shuffle(spots).slice(0, 2);
    if (pick.length === 2) { const A = swap(pick[0]), B = swap(pick[1]); [make({ [pick[0]]: A }), make({ [pick[1]]: B }), make({ [pick[0]]: A, [pick[1]]: B })].forEach((v) => wrong.add(v)); }
    for (let t = 0; t < 30 && wrong.size < 3; t++) { const i = spots[Math.floor(Math.random() * spots.length)]; wrong.add(make({ [i]: swap(i) })); }
    wrong.delete(w);
    const kana = Array.from(w).map((c) => (c >= '\u30a1' && c <= '\u30f6' ? String.fromCharCode(c.charCodeAt(0) - 0x60) : c)).join('');
    return finish('orthography', wrapFirst(x.ja, w, U0 + kana + U1), w, Array.from(wrong), x, e);
  }
  function makeWriting(e, x) {
    if (IS_KATA(x.form)) return makeKatakana(e, x);
    const parts = formParts(e, x.form);
    if (!parts || !RE_KANJI.test(x.form)) return null;
    const chars = Array.from(x.form), kidx = chars.map((c, i) => (RE_KANJI.test(c) && c !== '々' ? i : -1)).filter((i) => i >= 0);
    const alts = (c, prefer) => {
      const look = Array.from((dict.look && dict.look[c]) || ''), same = Array.from((dict.alt && dict.alt[c]) || '');
      const list = prefer === 'look' ? look.slice(0, 4).concat(same.slice(0, 4)) : same.slice(0, 4).concat(look.slice(0, 4));
      return shuffle(list.slice(0, 4)).concat(list.slice(4));
    };
    const ok = (w) => w !== x.form && !dict.byText.has(w);
    const wrong = new Set();
    if (kidx.length >= 2 && Math.random() < 0.6) {
      const pick = shuffle(kidx).slice(0, 2), A = alts(chars[pick[0]], 'same')[0], B = alts(chars[pick[1]], Math.random() < 0.5 ? 'same' : 'look')[0];
      if (A && B) {
        const make = (rep) => chars.map((c, i) => (rep[i] || c)).join('');
        [make({ [pick[0]]: A }), make({ [pick[1]]: B }), make({ [pick[0]]: A, [pick[1]]: B })].filter(ok).forEach((w) => wrong.add(w));
      }
    }
    for (let tries = 0; tries < 40 && wrong.size < 3; tries++) {
      const i = kidx[Math.floor(Math.random() * kidx.length)], a = alts(chars[i], Math.random() < 0.6 ? 'look' : 'same');
      if (!a.length) continue;
      const c = chars.slice(); c[i] = a[Math.floor(Math.random() * Math.min(a.length, 3))];
      const w = c.join('');
      if (ok(w)) wrong.add(w);
    }
    return finish('orthography', wrapFirst(x.ja, x.form, U0 + parts.reading + U1), x.form, Array.from(wrong), x, e);
  }

  // 語形成: the prefix or suffix of a formed word (可能（性）, （未）使用).
  function affixes(kind) {
    if (!dict.affixes) {
      dict.affixes = { S: new Set(), P: new Set() };
      for (const raw of dict.entries) if (raw[12]) dict.affixes[raw[12][0]].add(raw[12].slice(1));
    }
    return Array.from(dict.affixes[kind]);
  }
  function makeFormation(e, x) {
    if (!e.formation || x.form.indexOf(e.primary) < 0 || x.ja.indexOf(e.primary) < 0) return null;
    const kind = e.formation[0], aff = e.formation.slice(1);
    const base = kind === 'S' ? e.primary.slice(0, e.primary.length - aff.length) : e.primary.slice(aff.length);
    const words = (a) => (kind === 'S' ? base + a : a + base);
    const wrong = shuffle(affixes(kind)).filter((a) => a !== aff && a.length === aff.length && !dict.byText.has(words(a))).slice(0, 3);
    const stem = wrapFirst(x.ja, e.primary, kind === 'S' ? base + '（　　　）' : '（　　　）' + base);
    const spec = finish('formation', stem, aff, wrong, x, e);
    if (spec && e.jlpt >= 3) spec.instr = instrFor('context', e.jlpt);
    return spec;
  }

  // 文脈規定: the word that fits the blank, among words of the same kind that look like it.
  function makeContext(e, x) {
    const parts = formParts(e, x.form);
    if (!parts || (parts.tailF && !parts.tailH)) return null;
    return finish('context', wrapFirst(x.ja, x.form, '（　　　）'), x.form, pickWords(e, parts, 3, { right: x.form }), x, e);
  }

  // 言い換え類義: the word closest in meaning. At N5 and N4 the choices are whole sentences, as in the test.
  function makeParaphrase(e, x) {
    const parts = formParts(e, x.form);
    if (!parts) return null;
    // Only a close match: each word's main meaning must appear among the other's meanings (訓練 "training" / 練習 "practice; training").
    const first = (o) => toks(o.gloss.split(';')[0]);
    const meets = (a, b) => { const tb = toks(b.gloss); for (const t of first(a)) if (tb.has(t)) return true; return false; };
    let s = null;
    for (const w of e.syn) {
      s = lookupExact(w).find((o) => o.cls === e.cls && o.pos === e.pos && o.id !== e.id && meets(o, e) && meets(e, o)
        && e.primary.indexOf(o.primary) < 0 && o.primary.indexOf(e.primary) < 0) || null;     // not 時 for 時間
      if (s) break;
    }
    if (!s) {                                                  // no thesaurus synonym: a word of the same kind with the same main meaning
      let best = null;
      for (const i of pool(poolKey(e))) {
        const o = entryAt(i);
        if (o.id === e.id || o.pos !== e.pos || !o.jlpt || o.jlpt < (e.jlpt || 1) - 1 || o.primary.indexOf(e.primary) >= 0 || e.primary.indexOf(o.primary) >= 0) continue;
        if (meets(o, e) && meets(e, o) && related(e, o) && (!best || o.rank < best.rank)) best = o;
      }
      s = best;
    }
    if (!s) return null;
    const right = inflectAs(s, parts, false);
    if (!right || right === x.form) return null;
    const wrong = pickWords(e, parts, 3, { right: right, avoid: [s] });
    if ((e.jlpt || 1) >= 4) {
      if (x.ja.length > 30) return null;
      const spec = finish('paraphrase', U0 + x.ja + U1, wrapFirst(x.ja, x.form, right), wrong.map((w) => wrapFirst(x.ja, x.form, w)), x, e);
      return spec;
    }
    return finish('paraphrase', wrapFirst(x.ja, x.form, U0 + x.form + U1), right, wrong, x, e);
  }

  // 用法: the one sentence that uses the word correctly; the others are sentences where a different word belongs.
  function makeUsage(e, x) {
    const sh = study.shardData;
    // Not for adverbs and な-adjectives: swapped into another word's sentence they too often still make sense.
    if (!sh || !(/^(n|vs|v1|v5[a-z]|adj-i)$/.test(e.cls) || (x.lastResort && /^(adv|adj-na|)$/.test(e.cls))) || x.ja.length > 34) return null;
    const parts = formParts(e, x.form);
    if (!parts) return null;
    const level = e.jlpt || 1, wrong = [];
    // Adverbs and な-adjectives (only when nothing else is possible) go into a noun's place, so the wrong sentences are clearly wrong.
    const fromCls = x.lastResort && /^(adv|adj-na|)$/.test(e.cls) ? 'n' : e.cls;
    for (const id of shuffle(Object.keys(sh))) {
      if (wrong.length >= 3) break;
      const o = byId(+id);
      if (!o || o.id === e.id || o.cls !== fromCls || !o.jlpt || Math.abs(o.jlpt - level) > 2 || related(e, o)) continue;
      for (const row of shuffle(sh[id])) {
        const y = rowToEx(row), yform = normForm(o, y.form);
        if (y.ja.length > 34 || y.ja.indexOf(e.primary) >= 0 || /[A-Za-zＡ-Ｚａ-ｚ]/.test(y.ja)) continue;
        const p = formParts(o, yform);
        if (!p || p.tailH !== parts.tailH) continue;
        const t = inflectAs(e, p, false);
        if (!t) continue;
        wrong.push(wrapFirst(y.ja, yform, U0 + t + U1));
        break;
      }
    }
    return finish('usage', e.primary, wrapFirst(x.ja, x.form, U0 + x.form + U1), wrong, x, e);
  }

  // 語形成 for a base word (可能 -> 可能性): uses the formed word's own example sentences.
  function formationFromBase(e) {
    const list = (dict.compounds && dict.compounds[e.primary]) || [];
    for (const w of shuffle(list)) {
      const ce = lookupExact(w).find((o) => o.formation);
      if (ce) return loadExamples(ce.id).then((ex) => {
        for (const y of shuffle(ex)) { const spec = makeFormation(ce, Object.assign({}, y, { form: normForm(ce, y.form) })); if (spec) return spec; }
        return null;
      });
    }
    return Promise.resolve(null);
  }

  const MAKERS = [['reading', makeReading], ['orthography', makeWriting], ['formation', makeFormation],
    ['context', makeContext], ['paraphrase', makeParaphrase], ['usage', makeUsage]];
  function renderPractice() {
    const e = study.entry, box = $('#practice-list'), my = study.seq;
    box.textContent = '';
    if (!e) { $('#practice-block').hidden = true; return; }
    let sentences = shuffle(study.examples).map((x) => Object.assign({}, x, { form: normForm(e, x.form) }));
    if (!sentences.length && state.targetText && state.targetText.indexOf(study.query) >= 0) {
      sentences = [{ ja: state.targetText, en: '', id: 0, by: '', form: study.query }];   // fall back to the caption on screen
    }
    const slots = [], usedIds = new Set(), made = new Set();
    for (const [type, make] of MAKERS) {
      let spec = null;
      const order = sentences.filter((x) => !usedIds.has(x.id)).concat(sentences.filter((x) => usedIds.has(x.id)));
      for (const x of order) { spec = make(e, x); if (spec) { usedIds.add(x.id); break; } }
      if (spec) { slots.push(spec); made.add(type); }
      else if (type === 'formation' && !e.formation && dict.compounds && dict.compounds[e.primary]) { slots.push(formationFromBase(e)); made.add(type); }
    }
    // At least three kinds: when the examples are not enough, use the caption on screen, then the word on its own.
    if (made.size < 3) {
      const extra = sentences.slice();                             // the examples again (用法 may now use its last-resort form)
      for (const r of (study.grammarRows || [])) {                 // sentences found while counting grammar
        const ex = r[3], b = parseBraces(ex[0]);
        if (ex[4] > ex[3] && !sentences.some((x) => x.id === ex[2])) extra.push({ ja: b.plain, furi: ex[0], en: ex[1], id: ex[2], by: ex[9] || '', src: ex[8] || 't', form: normForm(e, b.plain.slice(ex[3], ex[4])) });
      }
      const cap = state.targetText || '';
      const head = e.kanji.concat(e.kana).find((w) => cap.indexOf(w) >= 0);
      if (head) extra.push({ ja: cap, furi: cap, en: '', id: 0, by: '', form: head });
      extra.push({ ja: e.primary, furi: e.primary, en: '', id: 0, by: '', form: e.primary, alone: true });
      for (const [type, make] of MAKERS) {
        if (made.size >= 3) break;
        if (made.has(type)) continue;
        for (const x0 of extra) {
          if (x0.alone && !/^(reading|orthography|paraphrase)$/.test(type)) continue;
          const x = type === 'usage' ? Object.assign({ lastResort: true }, x0) : x0;
          const spec = make(e, x);
          if (spec) { slots.splice(MAKERS.findIndex((m) => m[0] === type), 0, spec); made.add(type); break; }
        }
      }
    }
    let n = 0;
    const number = () => { box.querySelectorAll('.q-kicker').forEach((k, i) => { k.textContent = '問題 ' + (i + 1) + '　' + k.dataset.type; }); };
    for (const s of slots) {
      if (s && typeof s.then === 'function') {
        const holder = el('div');
        box.appendChild(holder);
        s.then((spec) => { if (my !== study.seq || !spec) { holder.remove(); return; } holder.replaceWith(practiceCard(spec)); number(); });
      } else { box.appendChild(practiceCard(s)); n++; }
    }
    number();
    $('#practice-block').hidden = slots.length === 0;
  }
  function practiceCard(spec) {
    spec.kicker = TYPE_JA[spec.type];
    const card = questionCard(spec);
    card.querySelector('.q-kicker').dataset.type = TYPE_JA[spec.type];
    return card;
  }

  /* ---------- grammar used with the word, grammar questions, reading passages ---------- */
  const BASIC_G = new Set(['masu', 'nai', 'te', 'ta', 'desu', 'ku-nai-katta-ku-nakatta', 'ou-you']);
  const band = (level) => (level >= 4 ? 5 : level === 3 ? 3 : 2);        // instruction wording: N5-N4, N3, N2-N1
  const GRAMMAR_INSTR = {
    form: { 5: '（　　　）に 何を 入れますか。１・２・３・４から いちばん いい ものを 一つ えらんで ください。',
      3: '次の文の（　　　）に入れるのに最もよいものを、１・２・３・４から一つえらびなさい。',
      2: '次の文の（　　　）に入れるのに最もよいものを、１・２・３・４から一つ選びなさい。' },
    star: { 5: '★に 入る ものは どれですか。１・２・３・４から いちばん いい ものを 一つ えらんで ください。',
      3: '次の文の　★　に入る最もよいものを、１・２・３・４から一つえらびなさい。',
      2: '次の文の　★　に入る最もよいものを、１・２・３・４から一つ選びなさい。' },
    text: { 5: 'つぎの ぶんしょうを 読んで、（ 1 ）から（ 3 ）に 何を 入れますか。ぶんしょうの いみを 考えて、１・２・３・４から いちばん いい ものを 一つ えらんで ください。',
      3: '次の文章を読んで、文章全体の内容を考えて、（ 1 ）から（ 3 ）の中に入る最もよいものを、１・２・３・４から一つえらびなさい。',
      2: '次の文章を読んで、文章全体の趣旨を踏まえて、（ 1 ）から（ 3 ）の中に入る最もよいものを、１・２・３・４から一つ選びなさい。' }
  };
  const READING_INSTR = {
    5: 'つぎの ぶんしょうを 読んで、しつもんに こたえて ください。こたえは、１・２・３・４から いちばん いい ものを 一つ えらんで ください。',
    3: '次の文章を読んで、質問に答えなさい。答えは、１・２・３・４から最もよいものを一つえらびなさい。',
    2: '次の文章を読んで、後の問いに対する答えとして最もよいものを、１・２・３・４から一つ選びなさい。',
    integrated: '次のAとBの文章を読んで、後の問いに対する答えとして最もよいものを、１・２・３・４から一つ選びなさい。',
    info5: 'つぎの あんないを 見て、しつもんに こたえて ください。こたえは、１・２・３・４から いちばん いい ものを 一つ えらんで ください。',
    info3: '次の案内を読んで、下の質問に答えなさい。答えは、１・２・３・４から最もよいものを一つえらびなさい。',
    info2: '次の案内を読んで、下の問いに対する答えとして最もよいものを、１・２・３・４から一つ選びなさい。'
  };
  const READING_TYPE = { short: '内容理解（短文）', mid: '内容理解（中文）', long: '内容理解（長文）', integrated: '統合理解', thematic: '主張理解（長文）', info: '情報検索' };
  const loaders = {};
  const loadJSON = (path) => (loaders[path] = loaders[path] || fetch(path).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  // Grammar points with where the textbooks teach them; their levels as the textbooks settle them (tools/build_grammar_refs.py).
  let grammarMetaP = null;
  function loadGrammarMeta() {
    if (!grammarMetaP) grammarMetaP = Promise.all([loadJSON('data/grammar.json'), loadJSON('data/grammar-refs.json')]).then(([m, r]) => {
      if (m && r) { for (const g in r) if (m.points[g]) m.points[g][1] = r[g].level; m.refs = r; }
      return m;
    });
    return grammarMetaP;
  }
  function refsText(meta, g) {
    const r = meta && meta.refs && meta.refs[g];
    if (!r) return '';
    const parts = [];
    if (r.minna) parts.push('みんなの日本語 第' + r.minna + '課');
    if (r.genki) parts.push('GENKI ' + (r.genki <= 12 ? 'I' : 'II') + ' 第' + r.genki + '課');
    if (r.quartet) parts.push('Quartet ' + (r.quartet[0] <= 6 ? 'I' : 'II') + ' 第' + r.quartet.slice(0, 3).join('・') + '課');
    if (r.tobira) parts.push('Tobira 第' + r.tobira.slice(0, 3).join('・') + '課');
    if (r.dojg) parts.push(r.dojg.map((v) => 'Dictionary of ' + v + ' Japanese Grammar').join(', '));
    if (r.sensei) parts.push('JLPT Sensei: ' + r.sensei.map((l) => 'N' + l).join('/'));
    return parts.join(' · ');
  }
  const loadGrammarShard = (id) => loadJSON('data/gr/' + String(id % 64).padStart(2, '0') + '.json');

  // Text with readings in braces -> pieces for drawRuby, and the plain text.
  function parseBraces(furiText) {
    const segs = [], re = /([^{}])\{([^}]*)\}|([^{}]+?)(?=[^{}]\{|$)/g;
    let m, plain = '';
    while ((m = re.exec(furiText))) {
      const t = m[1] != null ? m[1] : m[3], r = m[1] != null ? m[2] : '', prev = segs[segs.length - 1];
      if (r && prev && prev.r) { prev.t += t; prev.r += r; } else segs.push({ t: t, r: r, at: plain.length });
      plain += t;
    }
    return { segs: segs, plain: plain };
  }
  // ⟦underlined⟧ text -> plain text and ranges to underline.
  function markedToRanges(text) {
    let plain = '', open = -1;
    const ranges = [];
    for (const ch of String(text)) {
      if (ch === U0) open = plain.length;
      else if (ch === U1) { if (open >= 0) ranges.push([open, plain.length, 'u']); open = -1; }
      else plain += ch;
    }
    return { plain: plain, ranges: ranges };
  }
  // Furigana for any question text, added only once the question is answered.
  function furiganize(node, text) {
    if (!node || !RE_KANJI.test(text)) return;
    loadTokenizer().then((ok) => {
      if (!ok || !furi.tokenizer) return;
      const m = markedToRanges(text);
      try { drawRuby(node, captionSegs(m.plain), m.ranges); node.classList.add('has-furi'); } catch (e) { /* keep the plain text */ }
    });
  }

  /* The grammar panel under the word: only patterns counted with this word itself (in Tatoeba, film subtitles and Wikipedia),
     each with a sentence that uses the word with that pattern. */
  function renderGrammar(e, my) {
    const box = $('#grammar'), list = $('#grammar-list');
    list.textContent = ''; box.hidden = true; study.grammarRows = [];
    if (!e) return Promise.resolve();
    return Promise.all([loadGrammarMeta(), loadGrammarShard(e.id)]).then(([meta, sh]) => {
      if (my !== study.seq || !meta) return;
      study.grammarMeta = meta;
      const rows = ((sh && sh[e.id]) || []).filter((r) => meta.points[r[0]]);
      study.grammarRows = rows;
      for (const r of rows) if (r[1] > 0) list.appendChild(grammarItem(meta.points[r[0]], r, e));   // count 0: found elsewhere in the sentence, practice only
      box.hidden = list.children.length === 0;
    });
  }
  function grammarItem(p, row, e) {
    const li = el('li', { class: 'gr-item' });
    const head = el('div', { class: 'gr-head' });
    head.appendChild(el('span', { class: 'gr-pat', lang: 'ja' }, p[0]));
    head.appendChild(el('span', { class: 'jlpt-mini', 'data-level': String(p[1]) }, 'N' + p[1]));
    li.appendChild(head);
    li.appendChild(el('p', { class: 'gr-mean' }, p[2]));
    const meta = study.grammarMeta, books = refsText(meta, row[0]), rr = meta && meta.refs && meta.refs[row[0]];
    if (books) {
      const bp = el('p', { class: 'gr-form' });
      bp.appendChild(el('span', { class: 'gr-label' }, 'Taught in: '));
      bp.appendChild(document.createTextNode(books + (rr && rr.lists ? ' (JLPT lists say N' + rr.lists + '; the textbooks teach it at N' + rr.level + ')' : '')));
      li.appendChild(bp);
    }
    const form = el('p', { class: 'gr-form' });
    form.appendChild(el('span', { class: 'gr-label' }, 'How it attaches: '));
    form.appendChild(document.createTextNode(p[3]));
    li.appendChild(form);
    const ex = row[3], b = parseBraces(ex[0]);
    if (row[4]) {                    // a particle: the verb or adjective this word most often takes with it
      const col = el('p', { class: 'gr-col' });
      col.appendChild(el('span', { class: 'gr-label' }, 'Most often: '));
      col.appendChild(el('b', { lang: 'ja' }, e.primary + (p[4] || '') + row[4]));
      col.appendChild(document.createTextNode(' (' + row[5] + ' of the ' + row[1] + ' sentences)'));
      li.appendChild(col);
    }
    li.appendChild(el('p', { class: 'gr-count' }, 'Used with this word in ' + row[1] + ' of the ' + row[2] + ' sentences with it that were checked. Example with this word:'));
    const ja = el('p', { class: 'gr-ex', lang: 'ja' });
    drawRuby(ja, b.segs, [[ex[3], ex[4], 'mark'], [ex[5], Math.max(ex[6], ex[5]), 'u']]);
    li.appendChild(ja);
    const en = ex[1] || NO_EN[ex[8]] || '';
    if (en) li.appendChild(el('p', { class: 'ex-en' + (ex[1] ? '' : ' muted') }, en));
    const src = el('p', { class: 'ex-src' });
    sourceLine(src, ex[8] || 't', ex[2], ex[9] || '', false);
    li.appendChild(src);
    return li;
  }

  // A grammar point's own form as a choice: "〜たらどう" -> たらどう; patterns with a gap (まだ〜ていない) are not used.
  function grammarForm(pattern) {
    const f = String(pattern).split(' / ')[0].replace(/（[^）]*）|\([^)]*\)/g, '').replace(/^〜/, '').trim();
    return f && f.indexOf('〜') < 0 && f.length >= 2 && f.length <= 8 && /^[\u3040-\u30ff\u4e00-\u9fff々ー]+$/.test(f) ? f : '';
  }
  /* 文法形式の判断: the grammar after the word is blanked. Wrong choices attach to a different form, so only one fits. */
  function makeGrammarForm(e, row, meta) {
    const g = row[0], p = meta.points[g], ex = row[3];
    if (BASIC_G.has(g) || row[4] || ex[6] <= ex[5]) return null;      // particles have no one-answer blank
    const b = parseBraces(ex[0]), plain = b.plain, right = plain.slice(ex[5], ex[6]);
    if (!right || right.length > 10 || plain.length > 45) return null;
    const conns = new Set(p[5]);
    // Everything that can follow the visible text before the blank, so that no "wrong" choice is in fact grammatical there:
    // the endings of patterns attaching the same way (して + から), and endings that turn a stem into another form (食べ + ておく).
    const fits = new Set();
    for (const k in meta.points) {
      const q = meta.points[k];
      if (!q[5].some((c) => conns.has(c))) continue;
      for (const s of [q[4], grammarForm(q[0]), grammarForm(q[0]).replace(/^[てでただ]/, '')]) if (s) fits.add(s);
    }
    const startsBad = conns.has('stem') || conns.has('nai') || conns.has('astem') ? /^[てでただなずさせられれよばけかくそ]/ : conns.has('ta') ? /^[らり]/ : null;
    const cands = shuffle(Object.keys(meta.points)).filter((k) => {
      const q = meta.points[k], f = grammarForm(q[0]);
      if (k === g || BASIC_G.has(k) || !f || !q[5].length || q[5].some((c) => conns.has(c))) return false;
      if (Math.abs(q[1] - p[1]) > 1 || (startsBad && startsBad.test(f))) return false;
      for (const s of fits) if (s && (s === f || s.startsWith(f) || f.startsWith(s))) return false;
      return f !== right && !right.startsWith(f) && !f.startsWith(right);
    }).sort((x, y) => Math.abs(meta.points[x][1] - p[1]) - Math.abs(meta.points[y][1] - p[1]));
    const wrong = Array.from(new Set(cands.map((k) => grammarForm(meta.points[k][0])))).slice(0, 3);
    if (wrong.length < 3) return null;
    const opts = shuffle([right].concat(wrong));
    const pointOf = (f) => Object.keys(meta.points).find((k) => grammarForm(meta.points[k][0]) === f);
    return {
      kicker: '文法形式の判断', instr: GRAMMAR_INSTR.form[band(e.jlpt || 1)], level: p[1], levelNote: refsText(meta, g),
      stem: plain.slice(0, ex[5]) + '（　　　）' + plain.slice(ex[6]), opts: opts, ans: opts.indexOf(right),
      after: (box) => grammarAfter(box, b, ex, p),
      explain: (box) => {
        box.appendChild(el('p', { class: 'q-why' }, '「' + right + '」 (' + p[0] + ', N' + p[1] + '): ' + p[2] + '. It attaches as: ' + p[3] + '.'));
        const ul = el('ul', { class: 'q-why-list' });
        for (const o of opts) {
          if (o === right) continue;
          const k = pointOf(o), q = k && meta.points[k];
          ul.appendChild(el('li', null, '「' + o + '」' + (q ? ' (' + q[0] + ', N' + q[1] + '): ' + q[2] + ' — it attaches as ' + q[3] + ', so it cannot follow this form.' : ': does not fit here.')));
        }
        box.appendChild(ul);
      },
      source: (s) => sourceLine(s, ex[8] || 't', ex[2], ex[9] || '', true)
    };
  }
  /* 文法形式の判断 on the word's own form, as the papers ask (雨が（降り）そうです): the grammar after the word stays, the word is blanked,
     and the choices are other forms of the same word that the grammar cannot follow. */
  function makeFormBefore(e, row, meta) {
    const g = row[0], p = meta.points[g], ex = row[3];
    if (!row[1] || row[4] || BASIC_G.has(g) || ex[5] < ex[4] || ex[5] - ex[4] > 1 || ex[6] <= ex[5]) return null;
    const b = parseBraces(ex[0]), plain = b.plain, right = plain.slice(ex[3], ex[5]), rest = plain.slice(ex[5]);
    if (!right || plain.length > 45) return null;
    let forms = null;
    const vk = /^v/.test(e.cls) ? verbKind(e) : null;
    if (vk) forms = { stem: conjugate(vk, 'stem'), te: conjugate(vk, 'te'), ta: conjugate(vk, 'ta'), dict: conjugate(vk, 'dict'), nai: formOf(vk, 'naiStem'), vol: conjugate(vk, 'vol') };
    else if (e.cls === 'adj-i') { const st = e.primary.slice(0, -1); forms = { astem: st, ku: st + 'く', dict: e.primary, ta: st + 'かった', te: st + 'くて', ba: st + 'けれ' }; }
    if (!forms) return null;
    const rightConn = Object.keys(forms).find((k) => forms[k] === right);
    if (!rightConn) return null;
    // A wrong form must not be grammatical before the text that follows: no pattern attaching to that form may start the rest.
    const fitsAfter = (conn) => Object.keys(meta.points).some((k) => {
      const q = meta.points[k];
      if (q[5].indexOf(conn) < 0) return false;
      return [q[4], grammarForm(q[0])].some((sf) => sf && sf.length >= 1 && rest.startsWith(sf));
    });
    const plainPair = { dict: 'ta', ta: 'dict' };                 // plain present and past fit before the same endings
    const wrong = Object.keys(forms).filter((k) => k !== rightConn && k !== plainPair[rightConn] && p[5].indexOf(k) < 0 && forms[k] && forms[k] !== right && !fitsAfter(k))
      .map((k) => forms[k]);
    const uniq = Array.from(new Set(wrong));
    if (uniq.length < 3) return null;
    const opts = shuffle([right].concat(shuffle(uniq).slice(0, 3)));
    const NAME = { stem: 'the ます-stem', te: 'the て-form', ta: 'the た-form', dict: 'the dictionary form', nai: 'the ない-stem', vol: 'the volitional form',
      astem: 'the stem (without い)', ku: 'the く-form', ba: 'the ば-stem' };
    const nameOf = (f) => NAME[Object.keys(forms).find((k) => forms[k] === f)] || 'another form';
    return {
      kicker: '文法形式の判断', instr: GRAMMAR_INSTR.form[band(e.jlpt || 1)], level: p[1], levelNote: refsText(meta, g),
      stem: plain.slice(0, ex[3]) + '（　　　）' + rest, opts: opts, ans: opts.indexOf(right),
      after: (box) => grammarAfter(box, b, ex, p),
      explain: (box) => {
        box.appendChild(el('p', { class: 'q-why' }, p[0] + ' (N' + p[1] + ') attaches as: ' + p[3] + '. So the word takes ' + nameOf(right) + ': ' + right + '.'));
        box.appendChild(el('p', { class: 'q-why' }, 'The others are ' + opts.filter((o) => o !== right).map((o) => o + ' (' + nameOf(o) + ')').join(', ') + '; ' + p[0] + ' does not attach to them.'));
      },
      source: (src) => sourceLine(src, ex[8] || 't', ex[2], ex[9] || '', true)
    };
  }
  /* 文法形式の判断 on an adverb and the ending it calls for (副詞の呼応): （決して）嘘をつかない. The wrong adverbs each need an ending
     the sentence does not have, so only the word itself fits. */
  const NEG_RE = /(ない|ません|なかった|ず[、。にとも]|ぬ)/;
  const NEEDS = [['ぜひ', /(たい|たく|たかっ|ください|下さい|ほしい|欲しい|ましょう|ませんか)/], ['もし', /(たら|だら|ば|なら|と、|ても|でも)/],
    ['まるで', /(よう|みたい)/], ['たとえ', /(ても|でも)/], ['決して', NEG_RE], ['少しも', NEG_RE], ['めったに', NEG_RE], ['どうぞ', /(ください|下さい|どうぞ|お願い)/]];
  function makeAdverbChoice(e, row, meta) {
    const ex = row[3], p = meta.points[row[0]];
    if (!row[1] || row[4] || ex[5] <= ex[4] + 1) return null;                      // only the frames found later in the sentence
    const b = parseBraces(ex[0]), plain = b.plain, right = plain.slice(ex[3], ex[4]), rest = plain.slice(ex[4]);
    if (!right || plain.length > 45) return null;
    const own = new Set(e.kanji.concat(e.kana));
    const wrong = shuffle(NEEDS.filter(([w, re]) => !own.has(w) && !re.test(rest))).map(([w]) => w);
    const neg = wrong.filter((w) => NEEDS.find((n) => n[0] === w)[1] === NEG_RE);
    const pick = wrong.filter((w) => neg.indexOf(w) < 0).concat(neg.slice(0, 1)).slice(0, 3);   // not three negative adverbs at once
    if (pick.length < 3) return null;
    const opts = shuffle([right].concat(pick));
    const NEEDS_EN = { ぜひ: 'a wish or request (〜たい, 〜てください)', もし: 'a condition (〜たら, 〜ば)', まるで: 'a likeness (〜ようだ, 〜みたい)', たとえ: '〜ても (even if)',
      決して: 'a negative ending (〜ない)', 少しも: 'a negative ending (〜ない)', めったに: 'a negative ending (〜ない)', どうぞ: 'a request or offer (〜てください)' };
    return {
      kicker: '文法形式の判断', instr: GRAMMAR_INSTR.form[band(e.jlpt || 1)], level: Math.min(p[1], e.jlpt || 5), levelNote: refsText(meta, row[0]),
      stem: plain.slice(0, ex[3]) + '（　　　）' + rest, opts: opts, ans: opts.indexOf(right),
      after: (box) => grammarAfter(box, b, ex, p),
      explain: (box) => {
        box.appendChild(el('p', { class: 'q-why' }, '「' + right + '」 is used with ' + p[0] + ' (' + p[2] + '), and the sentence ends that way.'));
        box.appendChild(el('ul', { class: 'q-why-list' }, null));
        for (const w of pick) box.lastChild.appendChild(el('li', null, '「' + w + '」 needs ' + NEEDS_EN[w] + ', which this sentence does not have.'));
      },
      source: (src) => sourceLine(src, ex[8] || 't', ex[2], ex[9] || '', true)
    };
  }
  /* 文法形式の判断 with a particle, as N5-N3 papers ask: 写真（　）撮りました. The wrong particles are ones the data build found
     almost never before that verb and never with this word, so only one choice is natural. */
  function makeParticleForm(e, row, meta) {
    const p = meta.points[row[0]], ex = row[3], wrong = row[6] || [];
    if (!row[4] || wrong.length < 3) return null;
    const b = parseBraces(ex[0]), plain = b.plain, gs = ex[5];
    const right = /^(から|より|まで)/.test(plain.slice(gs)) ? plain.slice(gs, gs + 2) : plain[gs];
    if (plain.length > 45 || !right) return null;
    const opts = shuffle([right].concat(shuffle(wrong).slice(0, 3)));
    return {
      kicker: '文法形式の判断', instr: GRAMMAR_INSTR.form[band(e.jlpt || 1)], level: p[1], levelNote: refsText(meta, row[0]),
      stem: plain.slice(0, gs) + '（　　　）' + plain.slice(gs + right.length), opts: opts, ans: opts.indexOf(right),
      after: (box) => grammarAfter(box, b, ex, p),
      explain: (box) => {
        box.appendChild(el('p', { class: 'q-why' }, '「' + right + '」 ' + p[0] + ': ' + p[2] + '. With 「' + row[4] + '」, ' + e.primary + ' takes ' + right + ' (' + e.primary + right + row[4] + ': ' + row[5] + ' sentences in the collections).'));
        box.appendChild(el('p', { class: 'q-why' }, 'The particles ' + opts.filter((o) => o !== right).join(', ') + ' are almost never used before 「' + row[4] + '」 in about 5 million sentences.'));
      },
      source: (s) => sourceLine(s, ex[8] || 't', ex[2], ex[9] || '', true)
    };
  }
  function grammarAfter(box, b, ex, p) {
    const ja = el('p', { lang: 'ja' });
    drawRuby(ja, b.segs, [[ex[5], Math.max(ex[6], ex[5]), 'u']]);
    box.appendChild(ja);
    if (ex[1]) box.appendChild(el('p', { class: 'q-en' }, ex[1]));
    const note = el('p', { class: 'q-gram' });
    note.appendChild(el('b', { lang: 'ja' }, p[0] + '（N' + p[1] + '）'));
    note.appendChild(document.createTextNode(' ' + p[2] + '. Form: ' + p[3] + '.'));
    box.appendChild(note);
  }

  /* 文の組み立て (★): four phrases of the sentence in a scrambled order; which one goes in the starred slot? */
  function makeStar(e, row, meta) {
    const ex = row[3], b = parseBraces(ex[0]), p = meta.points[row[0]];
    return makeStarFrom(e, { plain: b.plain, cuts: ex[7], anchor: ex[6] > ex[5] ? ex[5] : ex[3], id: ex[2], src: ex[8] || 't', by: ex[9] || '',
      after: (box) => grammarAfter(box, b, ex, p) });
  }
  function makeStarFromExample(e, x) {
    if (!x.cuts || !x.id) return null;
    const at = x.ja.indexOf(x.form);
    if (at < 0) return null;
    return makeStarFrom(e, { plain: x.ja, cuts: x.cuts, anchor: at, id: x.id, src: x.src, by: x.by,
      after: (box) => {
        const ja = el('p', { lang: 'ja' });
        renderFurigana(ja, x.furi || x.ja, x.form);
        box.appendChild(ja);
        if (x.en) box.appendChild(el('p', { class: 'q-en' }, x.en));
      } });
  }
  function makeStarFrom(e, s) {
    const plain = s.plain;
    const tail = (plain.match(/[。！？!?」]+$/) || [''])[0], coreEnd = plain.length - tail.length;
    const cuts = s.cuts.filter((c) => c < coreEnd).concat([coreEnd]);
    const chunks = [];
    for (let i = 0; i < cuts.length - 1; i++) if (cuts[i + 1] > cuts[i]) chunks.push([cuts[i], cuts[i + 1]]);
    if (chunks.length < 5 || plain.length > 50) return null;
    const starts = [];
    for (let k = 0; k + 4 <= chunks.length; k++) {
      if (chunks[k][0] <= s.anchor && s.anchor < chunks[k + 3][1] && (k > 0 || k + 4 < chunks.length)) starts.push(k);
    }
    for (const k of shuffle(starts)) {
      const parts = chunks.slice(k, k + 4).map((c) => plain.slice(c[0], c[1]));
      if (new Set(parts).size < 4 || parts.some((t) => t.length > 14 || /^[、,]/.test(t))) continue;
      const star = 1 + Math.floor(Math.random() * 2);
      const blanks = parts.map((_, i) => (i === star ? '＿★＿' : '＿＿＿')).join(' ');
      const stem = plain.slice(0, chunks[k][0]) + ' ' + blanks + ' ' + plain.slice(chunks[k + 3][1]);
      const opts = shuffle(parts);
      return {
        kicker: '文の組み立て', instr: GRAMMAR_INSTR.star[band(e.jlpt || 1)], stem: stem, opts: opts, ans: opts.indexOf(parts[star]), level: levelOf(e),
        explain: (b) => b.appendChild(el('p', { class: 'q-why', lang: 'ja' }, '★は' + (star + 1) + '番目の「' + parts[star] + '」です。正しい順番：' + parts.join(' → '))),
        after: (box) => { s.after(box); box.insertBefore(el('p', { class: 'q-order', lang: 'ja' }, '正しい順番：' + parts.join(' → ')), box.firstChild); },
        source: (src) => sourceLine(src, s.src, s.id, s.by, true)
      };
    }
    return null;
  }

  /* A passage with several questions: reading (読解) or text grammar (文章の文法). */
  function subQuestion(label, stemText, opts, ans, onDone, why) {
    const wrap = el('div', { class: 'sub-q' });
    const stem = el('p', { class: 'sub-stem', lang: 'ja' });
    stem.appendChild(el('span', { class: 'sub-label' }, label));
    const stemText_ = el('span', null, stemText);
    stem.appendChild(stemText_);
    wrap.appendChild(stem);
    const long = opts.some((o) => o.length > 9);
    const ol = el('ol', { class: 'q-opts' + (long ? ' long' : '') });
    const result = el('p', { class: 'q-result', role: 'status', lang: 'ja' });
    const spans = [];
    opts.forEach((o, i) => {
      const li = el('li'), btn = el('button', { type: 'button', class: 'q-opt', lang: 'ja' });
      btn.appendChild(el('span', { class: 'n' }, String(i + 1)));
      const t = el('span', null, o); spans.push(t);
      btn.appendChild(t);
      btn.addEventListener('click', () => {
        const all = ol.querySelectorAll('button');
        all.forEach((x) => { x.disabled = true; });
        all[ans].classList.add('right');
        if (i !== ans) btn.classList.add('wrong');
        result.textContent = i === ans ? '正解です。' : '不正解です。正しい答えは ' + (ans + 1) + ' です。';
        result.className = 'q-result ' + (i === ans ? 'ok' : 'no');
        furiganize(stemText_, stemText);
        spans.forEach((sp, k) => furiganize(sp, opts[k]));
        if (why) { const w = el('div', { class: 'q-explain' }); w.appendChild(el('p', { class: 'q-why-h', lang: 'ja' }, '解説')); why(w); wrap.appendChild(w); }
        if (onDone) onDone();
      });
      li.appendChild(btn); ol.appendChild(li);
    });
    wrap.appendChild(ol); wrap.appendChild(result);
    return wrap;
  }
  // The sentence of the passage that gives the answer away: the one sharing most with the right choice and the question.
  function evidence(texts, q, right, others) {
    const sents = texts.join('\n').split(/(?<=[。！？\n])/).map((x) => x.trim()).filter((x) => x.length > 3);
    const grams = (t) => { const g = new Set(); t = t.replace(/\s/g, ''); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
    const R = grams(right), Q = grams(q || ''), O = grams(others.join(''));
    let best = '', score = -1;
    for (const x of sents) {
      const G = grams(x); let sc = 0;
      G.forEach((g) => { if (R.has(g)) sc += 2; if (Q.has(g)) sc += 1; if (O.has(g) && !R.has(g)) sc -= 0.5; });
      if (sc > score) { score = sc; best = x; }
    }
    return score > 0 ? best : '';
  }
  function passageCard(kicker, instr, texts, questions, source, level) {
    const art = el('article', { class: 'q passage' });
    const head = el('div', { class: 'q-head' });
    head.appendChild(el('p', { class: 'q-kicker', lang: 'ja' }, kicker));
    if (level != null) head.appendChild(levelPill(level));
    art.appendChild(head);
    art.appendChild(el('p', { class: 'q-instr', lang: 'ja' }, instr));
    const nodes = [];
    const box = el('div', { class: 'passage-box' + (texts.length > 1 ? ' two' : '') });
    for (const t of texts) { const p = el('div', { class: 'passage-text', lang: 'ja' }, t); nodes.push([p, t]); box.appendChild(p); }
    art.appendChild(box);
    let left = questions.length;
    const done = () => { if (--left === 0) nodes.forEach(([n, t]) => furiganize(n, t)); };   // the passage gets furigana once every question is answered
    questions.forEach((q) => art.appendChild(subQuestion(q.label, q.stem, q.opts, q.ans, done, q.why)));
    art.appendChild(el('p', { class: 'q-source', lang: 'ja' }, source));
    return art;
  }
  function textGrammarCard(t) {
    const qs = t.blanks.map((b, i) => {
      const opts = shuffle(b.opts), right = b.opts[b.ans - 1];
      const mark = '（ ' + (i + 1) + ' ）', sent = (t.text.split(/(?<=[。！？])/).find((x) => x.indexOf(mark) >= 0) || '').trim();
      return { label: mark, stem: '', opts: opts, ans: opts.indexOf(right),
        why: (w) => {
          w.appendChild(el('p', { class: 'q-why', lang: 'ja' }, '「' + right + '」を入れると：' + sent.replace(mark, '【' + right + '】')));
          w.appendChild(el('p', { class: 'q-why' }, 'Read the sentences before and after the gap: only 「' + right + '」 connects them with the right meaning and form.'));
        } };
    });
    return passageCard('文章の文法　N' + t.level, GRAMMAR_INSTR.text[band(t.level)], [t.text], qs,
      'このサイトのために書いたオリジナルの練習文です。公式の問題ではありません。', t.level);
  }
  function readingCard(p) {
    const b = band(p.level);
    const instr = p.type === 'integrated' ? READING_INSTR.integrated : p.type === 'info' ? READING_INSTR['info' + b] : READING_INSTR[b];
    const texts = p.texts || [p.text];
    const qs = p.questions.map((q, i) => {
      const right = q.opts[q.ans - 1], ev = evidence(texts, q.q, right, q.opts.filter((o, k) => k !== q.ans - 1));
      return { label: p.questions.length > 1 ? '問' + (i + 1) + '　' : '', stem: q.q, opts: q.opts, ans: q.ans - 1,
        why: (w) => {
          w.appendChild(el('p', { class: 'q-why', lang: 'ja' }, '正解は「' + right + '」。' + (ev ? '本文のここに書いてあります：「' + ev + '」' : '')));
          if (q.why) w.appendChild(el('p', { class: 'q-why' }, q.why));
        } };
    });
    return passageCard('読解　' + READING_TYPE[p.type] + '　N' + p.level, instr, texts, qs,
      'このサイトのために書いたオリジナルの練習文です。公式の問題ではありません。', p.level);
  }

  function renderGrammarPractice() {
    const e = study.entry, box = $('#grammar-practice'), meta = study.grammarMeta, my = study.seq;
    box.textContent = '';
    if (!e) { $('#sec-grammar').hidden = true; return; }
    const cards = [];
    if (meta) {
      const all = study.grammarRows || [], own = shuffle(all.filter((r) => r[1] > 0)), side = shuffle(all.filter((r) => !r[1]));
      const rows = own.concat(side);
      let form = null;
      const makers = shuffle([makeGrammarForm, makeFormBefore]).concat([makeAdverbChoice, makeParticleForm]);
      // every kind of question on the word's own grammar first; grammar found elsewhere in its sentences only when none works
      for (const group of [own, side]) {
        for (const make of makers) { for (const r of group) { form = make(e, r, meta); if (form) break; } if (form) break; }
        if (form) break;
      }
      if (form) cards.push(form);
      let star = null;
      for (const r of rows) { star = makeStar(e, r, meta); if (star) break; }
      if (!star) for (const x of shuffle(study.examples || [])) { star = makeStarFromExample(e, x); if (star) break; }
      if (star) cards.push(star);
    }
    cards.forEach((s, i) => { s.kicker = '問題 ' + (i + 1) + '　' + s.kicker; box.appendChild(questionCard(s)); });
    loadJSON('data/reading.json').then((data) => {
      if (my !== study.seq || !data) return;
      const lv = e.jlpt || 1, pick = (list) => shuffle(list.filter((t) => t.level === lv))[0];
      const tg = pick(data.textGrammar);
      if (tg) box.appendChild(textGrammarCard(tg));
      $('#sec-grammar').hidden = box.children.length === 0;
      renderReadingPractice(data);
    });
    $('#sec-grammar').hidden = cards.length === 0;
  }
  // Reading at the word's level: one passage, a different format each time "別の問題にする" is pressed.
  function renderReadingPractice(data) {
    const e = study.entry, box = $('#reading-practice');
    box.textContent = '';
    if (!e || !data) { $('#sec-reading').hidden = true; return; }
    const lv = e.jlpt || 1, list = data.passages.filter((p) => p.level === lv);
    if (!list.length) { $('#sec-reading').hidden = true; return; }
    study.readingTurn = ((study.readingTurn || Math.floor(Math.random() * list.length)) + 1) % list.length;
    box.appendChild(readingCard(list[study.readingTurn]));
    $('#sec-reading').hidden = false;
  }

  /* ---------- textbook-style drills: the conjugation tables of みんなの日本語 練習A and GENKI, and 練習B pattern changes.
     Written for this site in the textbooks' format; no textbook exercise is copied. ---------- */
  const ROW = { u: 'わいうえお', k: 'かきくけこ', g: 'がぎぐげご', s: 'さしすせそ', t: 'たちつてと', n: 'なにぬねの', b: 'ばびぶべぼ', m: 'まみむめも', r: 'らりるれろ' };
  const TE5 = { u: 'って', t: 'って', r: 'って', k: 'いて', g: 'いで', s: 'して', n: 'んで', b: 'んで', m: 'んで' };
  // How a verb conjugates: ichidan, godan (and its row), する, 来る (drilled in kana: the kanji hides the change), 行く, ある, くださる-type.
  function verbKind(e) {
    const w = e.primary, kana = e.kana[0] || '';
    if (e.rawCls === 'vx') e = Object.assign({}, e, { cls: 'vx' });
    if (e.cls === 'vs') return { kind: 'suru', base: w };
    if (e.cls === 'v1') return { kind: 'v1', base: w.slice(0, -1) };
    const m = /^v5([ugsktnbmr])$/.exec(e.cls);
    if (m) return { kind: 'v5', row: m[1], base: w.slice(0, -1) };
    if (e.cls !== 'vx') return null;
    if (/くる$/.test(kana) && /(来る|くる)$/.test(w)) return { kind: 'kuru', base: kana.slice(0, -2) };
    if (/(する|為る)$/.test(w)) return { kind: 'suru', base: w.replace(/(する|為る)$/, '') };
    if (/(行く|いく|ゆく|逝く)$/.test(w)) return { kind: 'iku', row: 'k', base: w.slice(0, -1) };
    if (/^(ある|有る|在る)$/.test(w)) return { kind: 'aru', row: 'r', base: w.slice(0, -1) };
    if (/(さる|しゃる)$/.test(w)) return { kind: 'nasaru', row: 'r', base: w.slice(0, -1) };
    return null;
  }
  // Forms a verb kind can be drilled in (ある has no potential or volitional to speak of; くださる-type verbs only the basic ones).
  const VERB_FORMS = { aru: ['te', 'ta', 'nai', 'ba'], nasaru: ['te', 'ta', 'nai'] };
  function conjugate(vk, form) {
    const b = vk.base;
    if (vk.kind === 'v1') return { masu: b + 'ます', stem: b, te: b + 'て', ta: b + 'た', nai: b + 'ない', dict: b + 'る', pot: b + 'られる', vol: b + 'よう',
      pass: b + 'られる', caus: b + 'させる', ba: b + 'れば', imp: b + 'ろ' }[form];
    if (vk.kind === 'suru') return { masu: b + 'します', stem: b + 'し', te: b + 'して', ta: b + 'した', nai: b + 'しない', dict: b + 'する', pot: b + 'できる',
      vol: b + 'しよう', pass: b + 'される', caus: b + 'させる', ba: b + 'すれば', imp: b + 'しろ' }[form];
    if (vk.kind === 'kuru') return { masu: b + 'きます', stem: b + 'き', te: b + 'きて', ta: b + 'きた', nai: b + 'こない', dict: b + 'くる', pot: b + 'こられる',
      vol: b + 'こよう', pass: b + 'こられる', caus: b + 'こさせる', ba: b + 'くれば', imp: b + 'こい' }[form];
    const r = ROW[vk.row], te = b + (vk.kind === 'iku' ? 'って' : TE5[vk.row]);
    const out = { masu: b + r[1] + 'ます', stem: b + r[1], te: te, ta: te.replace(/て$/, 'た').replace(/で$/, 'だ'), nai: b + r[0] + 'ない', dict: b + r[2],
      pot: b + r[3] + 'る', vol: b + r[4] + 'う', pass: b + r[0] + 'れる', caus: b + r[0] + 'せる', ba: b + r[3] + 'ば', imp: b + r[3] };
    if (vk.kind === 'aru') out.nai = 'ない';
    if (vk.kind === 'nasaru') { out.masu = b + 'います'; out.stem = b + 'い'; out.imp = b + 'い'; }
    return out[form];
  }
  // Mistakes learners make, by kind: する and 来る have their own.
  const SURU_ERR = { te: ['しって', 'すて', 'さて'], ta: ['しった', 'すた', 'さった'], nai: ['さない', 'すない', 'しらない'], dict: ['しる', 'す', 'さる'],
    pot: ['しられる', 'すれる', 'しえる'], vol: ['すよう', 'しろう', 'さよう'], pass: ['しられる', 'すられる', 'させられる'], caus: ['しさせる', 'すさせる', 'しせる'],
    ba: ['しれば', 'せれば', 'さば'], imp: ['すれ', 'しれ', 'さろ'] };
  const KURU_ERR = { te: ['くて', 'こて', 'きって'], ta: ['くた', 'こた', 'きった'], nai: ['きない', 'くない', 'こらない'], dict: ['きる', 'こる', 'かる'],
    pot: ['きられる', 'くられる', 'こさせる'], vol: ['きよう', 'くよう', 'ころう'], pass: ['きられる', 'くられる', 'こされる'], caus: ['きさせる', 'くさせる', 'こらせる'],
    ba: ['きれば', 'これば', 'こば'], imp: ['きろ', 'くれ', 'けろ'] };
  // allowed: which other real forms may serve as wrong choices (a pattern drill leaves out plain forms, which fit before many endings).
  function verbMistakes(vk, form, right, allowed) {
    const masu = conjugate(vk, 'masu'), b = vk.base, groupErr = [], rowErr = [], formErr = [];
    if (vk.kind === 'suru') (SURU_ERR[form] || []).forEach((x) => groupErr.push(b + x));
    else if (vk.kind === 'kuru') (KURU_ERR[form] || []).forEach((x) => groupErr.push(b + x));
    else if (vk.kind === 'v1') { groupErr.push(conjugate({ kind: 'v5', row: 'r', base: b }, form)); for (const r of 'kms') rowErr.push(conjugate({ kind: 'v5', row: r, base: b }, form)); }
    else {
      groupErr.push(conjugate({ kind: 'v1', base: vk.row === 'r' ? b : b + ROW[vk.row][1] }, form));   // 帰て, 読みて: treated as an ichidan verb
      for (const r of 'urkgsnm') if (r !== vk.row) rowErr.push(conjugate({ kind: 'v5', row: r, base: b }, form));   // the wrong sound change: 読って, 行いて
    }
    if (vk.kind === 'aru' && form === 'nai') groupErr.unshift('あらない');            // the classic one
    for (const other of (allowed || ['te', 'ta', 'nai', 'dict', 'pot', 'vol', 'pass', 'caus', 'ba'])) if (other !== form) formErr.push(conjugate(vk, other));
    const bad = (w) => !w || w === right || w === masu;
    const pick = (list) => shuffle(list.filter((w) => !bad(w))).sort((x, y) => Math.abs(x.length - right.length) - Math.abs(y.length - right.length));
    const g = pick(groupErr), r = pick(rowErr), f = pick(formErr);
    const out = [];
    for (const list of [g, r, f, g, r, f]) { const w = list.find((x) => out.indexOf(x) < 0); if (w) out.push(w); if (out.length >= 3) break; }
    return out;
  }
  const FORM_JA = { te: 'て形', ta: 'た形', nai: 'ない形', dict: '辞書形', pot: '可能形', vol: '意向形', pass: '受身形', caus: '使役形', ba: '条件形（〜ば）', imp: '命令形' };
  // A model verb for the （れい） line, of the same group but not the same sound change, so the model does not give the answer away.
  function modelVerb(vk, e) {
    const isW = (w) => e.primary === w || e.kana[0] === w;
    if (vk.kind === 'v1') return isW('食べる') || isW('たべる') ? { kind: 'v1', base: 'み' } : { kind: 'v1', base: 'たべ' };
    if (vk.kind === 'suru') return isW('勉強') ? { kind: 'suru', base: 'そうじ' } : { kind: 'suru', base: 'べんきょう' };
    if (vk.kind === 'kuru') return { kind: 'suru', base: '' };
    return /[mbn]/.test(vk.row) ? { kind: 'v5', row: 'k', base: 'か' } : { kind: 'v5', row: 'm', base: 'よ' };
  }
  // Where the textbooks teach each form (and so its level), and how each verb group makes it.
  const FORM_LEVEL = { te: 5, ta: 5, nai: 5, dict: 5, pot: 4, vol: 4, imp: 4, ba: 4, pass: 4, caus: 4 };
  const FORM_BOOK = { te: 'みんなの日本語 第14課 · GENKI I 第6課', ta: 'みんなの日本語 第19課 · GENKI I 第9課', nai: 'みんなの日本語 第17課 · GENKI I 第8課',
    dict: 'みんなの日本語 第18課 · GENKI I 第8課', pot: 'みんなの日本語 第27課 · GENKI II 第13課', vol: 'みんなの日本語 第31課 · GENKI II 第15課',
    imp: 'みんなの日本語 第33課', ba: 'みんなの日本語 第35課 · GENKI II 第22課', pass: 'みんなの日本語 第37課 · GENKI II 第21課', caus: 'みんなの日本語 第48課 · GENKI II 第22課' };
  function conjRule(vk, form, e) {
    const group = { v1: 'a る-verb (Group 2)', v5: 'an う-verb (Group 1)', suru: 'a する-verb (irregular)', kuru: '来る (irregular)', iku: '行く, an う-verb with one exception (行って, 行った)',
      aru: 'ある, an う-verb whose negative is ない', nasaru: 'a くださる-type verb (くださいます, ください)' }[vk.kind];
    const TE = { u: 'う・つ・る → って', t: 'う・つ・る → って', r: 'う・つ・る → って', k: 'く → いて', g: 'ぐ → いで', s: 'す → して', n: 'ぬ・ぶ・む → んで', b: 'ぬ・ぶ・む → んで', m: 'ぬ・ぶ・む → んで' };
    const v5 = { te: TE[vk.row], ta: (TE[vk.row] || '').replace(/て/g, 'た').replace(/で/g, 'だ'), nai: 'the last sound changes to the あ-row, then ない (う → わ: 買う → 買わない)',
      dict: 'the い-row sound before ます changes to the う-row (読みます → 読む)', pot: 'the last sound changes to the え-row, then る (読む → 読める)',
      vol: 'the last sound changes to the お-row, then う (読む → 読もう)', pass: 'the last sound changes to the あ-row, then れる (読む → 読まれる)',
      caus: 'the last sound changes to the あ-row, then せる (読む → 読ませる)', ba: 'the last sound changes to the え-row, then ば (読む → 読めば)', imp: 'the last sound changes to the え-row (読む → 読め)' };
    const v1 = { te: 'drop る, add て', ta: 'drop る, add た', nai: 'drop る, add ない', dict: 'drop ます, add る', pot: 'drop る, add られる', vol: 'drop る, add よう',
      pass: 'drop る, add られる', caus: 'drop る, add させる', ba: 'drop る, add れば', imp: 'drop る, add ろ' };
    const irr = { te: 'して / 来て (きて)', ta: 'した / 来た (きた)', nai: 'しない / 来ない (こない)', dict: 'する / 来る (くる)', pot: 'できる / 来られる (こられる)',
      vol: 'しよう / 来よう (こよう)', pass: 'される / 来られる (こられる)', caus: 'させる / 来させる (こさせる)', ba: 'すれば / 来れば (くれば)', imp: 'しろ / 来い (こい)' };
    let rule = vk.kind === 'v1' ? v1[form] : /^(suru|kuru)$/.test(vk.kind) ? 'する and 来る: ' + irr[form] : v5[form];
    if (vk.kind === 'iku' && /^(te|ta)$/.test(form)) rule = 'the exception: 行って, 行った (not 行いて)';
    if (vk.kind === 'aru' && form === 'nai') rule = 'the exception: ない (not あらない)';
    return (e ? e.primary + ' is ' : 'This is ') + group + '. ' + FORM_JA[form] + ': ' + rule + '. Taught in ' + FORM_BOOK[form] + '.';
  }
  function verbConjugationDrill(e, vk, form) {
    const masu = conjugate(vk, 'masu'), right = conjugate(vk, form);
    if (!masu || !right) return null;
    const mv = modelVerb(vk, e);
    const spec = drillSpec('活用（' + FORM_JA[form] + '）', 'れいの ように、' + FORM_JA[form] + 'に して ください。',
      '（れい）' + conjugate(mv, 'masu') + ' → ' + conjugate(mv, form) + '\n' + masu + ' → （　　　）', right, verbMistakes(vk, form, right));
    if (spec) { spec.level = FORM_LEVEL[form]; spec.levelNote = FORM_BOOK[form]; spec.explain = (b) => b.appendChild(el('p', { class: 'q-why' }, conjRule(vk, form, e))); }
    return spec;
  }
  // い-adjectives, な-adjectives and nouns: the polite past and negative forms of みんなの日本語 第8課・第12課 (GENKI 第5課), or the plain ones.
  function predicateForms(e, plain) {
    const w = e.primary;
    if (e.cls === 'adj-i' || (e.cls === 'adjx' && /いい$/.test(w))) {
      const s = e.cls === 'adjx' ? w.slice(0, -2) + 'よ' : w.slice(0, -1);
      return { kind: 'i', dict: w, s: s, base: plain ? w : w + 'です',
        f: plain ? { nai: s + 'くない', ta: s + 'かった', nakatta: s + 'くなかった', te: s + 'くて' } : { nai: s + 'くないです', ta: s + 'かったです', nakatta: s + 'くなかったです', te: s + 'くて' },
        err: plain ? [w + 'じゃない', w + 'だった', w + 'くない', w + 'かった', s + 'いくなかった', w + 'で'] : [w + 'でした', w + 'じゃありません', s + 'くないでした', w + 'かったです', w + 'じゃありませんでした', w + 'くて'] };
    }
    if (e.cls === 'adj-na' || e.cls === 'n' || e.cls === 'vs') {
      const iLike = /い$/.test(w) && e.cls === 'adj-na' ? w.slice(0, -1) : null;      // きれい, ゆうめい: look like い-adjectives
      const err = plain ? [w + 'くない', w + 'かった', w + 'だじゃない', w + 'じゃなかっただ', w + 'なかった', w + 'て'] : [w + 'くないです', w + 'かったです', w + 'じゃないでした', w + 'でしたです', w + 'だったです', w + 'くて'];
      if (iLike) err.unshift(plain ? iLike + 'くない' : iLike + 'くないです', plain ? iLike + 'かった' : iLike + 'かったです');
      return { kind: e.cls === 'adj-na' ? 'na' : 'n', dict: w, base: plain ? w + 'だ' : w + 'です',
        f: plain ? { nai: w + 'じゃない', ta: w + 'だった', nakatta: w + 'じゃなかった', te: w + 'で' } : { nai: w + 'じゃありません', ta: w + 'でした', nakatta: w + 'じゃありませんでした', te: w + 'で' },
        err: err };
    }
    return null;
  }
  const PRED_FORM_JA = { nai: '否定形', ta: '過去形', nakatta: '過去否定形', te: 'て形' };
  const PRED_MODEL = { i: ['たかい', 'ひろい', 'adj-i'], na: ['しずか', 'げんき', 'adj-na'], n: ['がくせい', 'あめ', 'n'] };
  function predicateDrill(e, form, plain) {
    const pf = predicateForms(e, plain);
    if (!pf) return null;
    const right = pf.f[form];
    const others = Object.keys(pf.f).filter((k) => k !== form).map((k) => pf.f[k]);
    const wrong = shuffle(pf.err).slice(0, 2).concat(shuffle(others)).concat(pf.err);
    const m = PRED_MODEL[pf.kind], mf = predicateForms({ cls: m[2], primary: m[0] === e.primary ? m[1] : m[0] }, plain);
    const label = (plain ? '普通形の' : 'ていねい形の') + PRED_FORM_JA[form];
    const spec = drillSpec('活用（' + label + '）', 'れいの ように、' + label + 'に して ください。',
      '（れい）' + mf.base + ' → ' + mf.f[form] + '\n' + pf.base + ' → （　　　）', right, wrong);
    if (spec) {
      spec.level = 5; spec.levelNote = pf.kind === 'i' ? 'みんなの日本語 第8課・第12課 · GENKI I 第5課' : 'みんなの日本語 第1課・第12課 · GENKI I 第2課・第4課';
      const rule = pf.kind === 'i' ? 'い-adjective: drop い, then くない (not), かった (was), くなかった (was not); add です to be polite. Not 〜いでした or 〜いじゃありません. いい changes to よ-: よくない, よかった.'
        : (pf.kind === 'na' ? 'な-adjective' : 'Noun') + ': じゃない / じゃありません (not), だった / でした (was), じゃなかった / じゃありませんでした (was not). Never くない or かった' + (pf.kind === 'na' && /い$/.test(e.primary) ? ' — ' + e.primary + ' ends in い but is a な-adjective' : '') + '.';
      spec.explain = (b) => b.appendChild(el('p', { class: 'q-why' }, rule));
    }
    return spec;
  }
  // 練習B: change the word into a pattern it is really used with (the grammar counted for this word), following a model, as the textbooks do.
  const PATTERNS = {
    'te-iru': ['te', 'います', '〜ています'], tai: ['stem', 'たいです', '〜たいです'], 'koto-ga-dekiru': ['dict', 'ことができます', '〜ことができます'],
    'ta-koto-ga-aru': ['ta', 'ことがあります', '〜たことがあります'], 'te-kudasai': ['te', 'ください', '〜てください'], 'naide-kudasai': ['nai', 'でください', '〜ないでください'],
    'nakereba-naranai-nakute-wa-ikenai': ['naiStem', 'なければなりません', '〜なければなりません'], 'te-mo-ii': ['te', 'もいいです', '〜てもいいです'],
    'te-wa-ikenai': ['te', 'はいけません', '〜てはいけません'], 'te-shimau-chau': ['te', 'しまいました', '〜てしまいました'], 'te-oku': ['te', 'おきます', '〜ておきます'],
    'te-miru': ['te', 'みます', '〜てみます'], 'hou-ga-ii': ['ta', 'ほうがいいです', '〜たほうがいいです'], tsumori: ['dict', 'つもりです', '〜つもりです'],
    mashou: ['stem', 'ましょう', '〜ましょう'], nagara: ['stem', 'ながら', '〜ながら'], 'te-kara': ['te', 'から', '〜てから'], 'mae-ni': ['dict', 'まえに', '〜まえに'],
    'ato-de': ['ta', 'あとで', '〜たあとで'], sugiru: ['stem', 'すぎました', '〜すぎました'], 'yasui-nikui': ['stem', 'やすいです', '〜やすいです'],
    'you-to-omou': ['vol', 'とおもいます', '〜（よ）うとおもいます'], tara: ['ta', 'ら', '〜たら'], 'te-ageru': ['te', 'あげます', '〜てあげます'],
    'te-kureru': ['te', 'くれました', '〜てくれました'], 'te-morau': ['te', 'もらいました', '〜てもらいました'], 'koto-ni-suru': ['dict', 'ことにします', '〜ことにします'],
    'you-ni-naru': ['dict', 'ようになりました', '〜ようになりました'], 'tame-ni': ['dict', 'ために', '〜ために'], 'te-iku': ['te', 'いきます', '〜ていきます'],
    'te-kuru': ['te', 'きます', '〜てきます'], 'hajimeru-owaru-tsuzukeru': ['stem', 'はじめます', '〜はじめます'], 'ni-iku': ['stem', 'にいきます', '〜にいきます'],
    'zu-ni': ['naiStem', 'ずに', '〜ずに'], 'ku-naru-ni-naru': ['naru', 'ました', '〜くなりました／〜になりました']
  };
  const formOf = (vk, f) => (f === 'naiStem' ? (conjugate(vk, 'nai') || '').slice(0, -2) : conjugate(vk, f));
  function patternDrill(e) {
    const meta = study.grammarMeta, vk = /^v/.test(e.cls) ? verbKind(e) : null;
    if (!meta || (vk && /^(aru|nasaru)$/.test(vk.kind))) return null;
    for (const r of shuffle(study.grammarRows || [])) {
      let pat = PATTERNS[r[0]];
      if (!r[1] || !pat || !meta.points[r[0]] || (pat[0] === 'naru') === !!vk || (r[0] === 'zu-ni' && vk && vk.kind === 'suru')) continue;
      if (r[0] === 'yasui-nikui' && /にく/.test(r[3][0])) pat = ['stem', 'にくいです', '〜にくいです'];
      let right, start, wrong, ex;
      if (vk) {
        const f = pat[0] === 'naiStem' ? 'nai' : pat[0], base = formOf(vk, pat[0]);
        if (!base) continue;
        right = base + pat[1]; start = conjugate(vk, 'masu');
        // never 食べてたい (colloquial for 食べていたい) or 食べないために (grammatical): only misconjugations, the stem, the て-form, the volitional
        const allowed = ['stem', 'vol'].concat(/^た/.test(pat[1]) ? [] : ['te']);
        wrong = verbMistakes(vk, f, conjugate(vk, f), allowed).map((w) => (pat[0] === 'naiStem' ? w.replace(/ない$/, '') : w) + pat[1]);
        const mv = modelVerb(vk, e), model = mv.kind === 'v5' ? mv : { kind: 'v5', row: 'm', base: 'よ' };
        ex = '（れい）' + conjugate(model, 'masu') + ' → ' + formOf(model, pat[0]) + pat[1];
      } else {
        const pf = predicateForms(e, true);
        if (!pf) continue;
        right = (pf.kind === 'i' ? pf.s + 'くなり' : pf.dict + 'になり') + pat[1];
        start = (predicateForms(e, false) || {}).base;
        wrong = pf.kind === 'i' ? [pf.dict + 'になりました', pf.s + 'くになりました', pf.dict + 'くなりました'] : [pf.dict + 'くなりました', pf.dict + 'なになりました', pf.dict + 'でなりました'];
        ex = pf.kind === 'i' ? (e.primary === 'たかい' ? '（れい）ひろいです → ひろくなりました' : '（れい）たかいです → たかくなりました')
          : (e.primary === 'しずか' ? '（れい）げんきです → げんきになりました' : '（れい）しずかです → しずかになりました');
      }
      const p = meta.points[r[0]];
      const spec = drillSpec('文型練習（' + pat[2] + '）', 'れいの ように、「' + pat[2] + '」の 形に して ください。', ex + '\n' + start + ' → （　　　）', right, wrong);
      if (spec) {
        spec.note = p[0] + '（N' + p[1] + '）: ' + p[2] + '. Form: ' + p[3] + '.'; spec.level = p[1]; spec.levelNote = refsText(meta, r[0]);
        spec.explain = (b) => b.appendChild(el('p', { class: 'q-why' }, pat[2] + ' attaches as: ' + p[3] + '. The wrong choices put it on a form it does not attach to, or conjugate the word wrongly.'));
        return spec;
      }
    }
    return null;
  }
  function drillSpec(kicker, instr, stem, right, wrong) {
    wrong = Array.from(new Set(wrong.filter((w) => w && w !== right)));
    if (wrong.length < 3) return null;
    const opts = shuffle([right].concat(wrong.slice(0, 3)));
    return { kicker: kicker, instr: instr, stem: stem, opts: opts, ans: opts.indexOf(right), pre: true };
  }
  function renderDrills() {
    const e = study.entry, box = $('#drill-practice');
    box.textContent = '';
    const cards = [];
    if (e && study.formInfo) {                       // a conjugated form was searched: practise that form first
      const a = formIdentify(study.query, study.formInfo), b = formDrill(e, study.query, study.formInfo);
      if (a) cards.push(a);
      if (b) cards.push(b);
    }
    if (e) {
      const level = e.jlpt || 1, vk = /^v/.test(e.cls) ? verbKind(e) : null;
      if (vk) {
        const pool = shuffle(VERB_FORMS[vk.kind] || (level >= 5 ? ['te', 'ta', 'nai', 'dict'] : level === 4 ? ['te', 'ta', 'nai', 'dict', 'pot', 'vol', 'imp', 'ba'] : Object.keys(FORM_JA)));
        for (const f of pool) { const s = verbConjugationDrill(e, vk, f); if (s) cards.push(s); if (cards.length >= 2) break; }
      }
      if (cards.length < 2 && predicateForms(e, false)) {
        const forms = shuffle(['nai', 'ta', 'nakatta']);
        for (const [f, plain] of [[forms[0], false], [forms[1], true]]) { const s = predicateDrill(e, f, plain); if (s && cards.length < 2) cards.push(s); }
      }
      const p = patternDrill(e);
      if (p) cards.push(p);
    }
    cards.forEach((s, i) => {
      s.kicker = '練習 ' + (i + 1) + '　' + s.kicker;
      if (s.note) { const note = s.note; s.after = (b) => b.appendChild(el('p', { class: 'q-gram' }, note)); }
      box.appendChild(questionCard(s));
    });
    $('#sec-drill').hidden = cards.length === 0;
  }

  /* ---------- a conjugated form: how it is made, sentences that use it, and practice on it ---------- */
  // [label, JLPT level, what it means, OpenJLPT id for the formation note]
  const FORM_LABEL = {
    masu: ['〜ます（ていねい形）', 5, 'polite form: does; will do', 'masu'], mashita: ['〜ました', 5, 'polite past: did', 'mashita'],
    masen: ['〜ません', 5, 'polite negative: does not', 'masen'], 'masen-deshita': ['〜ませんでした', 5, 'polite past negative: did not', 'masen-deshita'],
    mashou: ['〜ましょう', 5, "let's (polite)", 'mashou'], 'masen-ka': ['〜ませんか', 5, "won't you…? (polite invitation)", 'masen-ka'], 'mashou-ka': ['〜ましょうか', 5, 'shall I / shall we…?', 'mashou-ka'],
    ta: ['た形（過去）', 5, 'plain past: did', 'ta'], te: ['て形', 5, 'te-form: and; and then (joins actions)', 'te'], tara: ['〜たら', 4, 'if; when; after', 'tara'],
    tari: ['〜たり', 5, 'doing things like…', 'tari-tari-suru'], temo: ['〜ても', 4, 'even if', 'te-mo-de-mo'],
    nai: ['ない形（否定）', 5, 'plain negative: does not', 'nai'], zu: ['〜ず／〜ずに', 3, 'without doing (written style)', 'zu-ni'], naide: ['〜ないで', 4, 'without doing; instead of doing', 'naide'],
    'naide-kudasai': ['〜ないでください', 5, "please don't", 'naide-kudasai'], nakereba: ['〜なければならない', 5, 'must; have to', 'nakereba-naranai-nakute-wa-ikenai'],
    'nakute-mo-ii': ['〜なくてもいい', 5, "don't have to", 'nakute-mo-ii'],
    pot: ['可能形', 4, 'potential: can do', 'eru-rareru-potential'], pass: ['受身形', 4, 'passive: is done (by someone)', 'reru-rareru-passive'],
    passpot: ['受身形／可能形（〜られる）', 4, 'passive (is done) or potential (can do): for る-verbs and 来る the two forms are the same; the sentence tells which', 'reru-rareru-passive'],
    caus: ['使役形', 4, 'causative: make or let someone do', 'seru-saseru'], causpass: ['使役受身形', 3, "causative-passive: is made to do (against one's will)", ''],
    vol: ['意向形', 4, "volitional: let's; I'll (〜と思う: I think I'll)", 'ou-you'], ba: ['条件形（〜ば）', 4, 'conditional: if', 'ba'], imp: ['命令形', 4, 'imperative: do it! (blunt command)', 'e-ro'],
    proh: ['〜な（禁止）', 4, "don't! (strong prohibition)", 'na-prohibition'], koto: ['〜こと', 4, 'the act of doing (makes a verb a noun)', ''], tsumori: ['〜つもり', 4, 'intend to', 'tsumori'],
    tai: ['〜たい', 5, 'want to', 'tai'], tagaru: ['〜たがる', 4, '(someone else) wants to', 'tagaru'], nagara: ['〜ながら', 5, 'while doing', 'nagara'],
    sou: ['〜そうだ（様子）', 4, 'looks like; is about to', 'sou-da-appearance'], sugiru: ['〜すぎる', 4, 'too much; over-', 'sugiru'], yasui: ['〜やすい', 4, 'easy to', 'yasui-nikui'],
    nikui: ['〜にくい', 4, 'hard to', 'yasui-nikui'], nasai: ['〜なさい', 4, 'do (an instruction, e.g. to a child)', 'nasai'], 'ni-iku': ['〜に行く／〜に来る', 5, 'go / come to do', 'ni-iku'],
    kata: ['〜方', 4, 'how to; the way of doing', 'kata'], hajimeru: ['〜始める', 4, 'start doing', 'hajimeru-owaru-tsuzukeru'], dasu: ['〜出す', 4, 'suddenly start doing', 'dasu'],
    tsuzukeru: ['〜続ける', 4, 'keep doing', 'hajimeru-owaru-tsuzukeru'], owaru: ['〜終わる', 4, 'finish doing', 'hajimeru-owaru-tsuzukeru'],
    'te-iru': ['〜ている', 5, 'is doing (now); is in a state (as a result)', 'te-iru'], 'te-oku': ['〜ておく', 4, 'do in advance; leave as is', 'te-oku'],
    'te-shimau': ['〜てしまう（〜ちゃう）', 4, 'do completely; end up doing (often with regret)', 'te-shimau-chau'], 'te-miru': ['〜てみる', 4, 'try doing (to see)', 'te-miru'],
    'te-aru': ['〜てある', 4, 'has been done (and stays so)', 'te-aru'], 'te-kuru': ['〜てくる', 4, 'do and come back; has been changing up to now', 'te-kuru'],
    'te-iku': ['〜ていく', 4, 'do and go; will go on changing', 'te-iku'], 'te-ageru': ['〜てあげる', 4, 'do for someone', 'te-ageru'],
    'te-kureru': ['〜てくれる', 4, 'someone does for me', 'te-kureru'], 'te-morau': ['〜てもらう', 4, 'have someone do (for me)', 'te-morau'],
    'te-itadaku': ['〜ていただく', 4, 'have someone do (humble)', 'te-kudasaru-te-itadaku'], 'te-kudasaru': ['〜てくださる', 4, 'someone kindly does (honorific)', 'te-kudasaru-te-itadaku'],
    'te-kudasai': ['〜てください', 5, 'please do', 'te-kudasai'], 'te-mo-ii': ['〜てもいい', 5, 'may; it is all right to', 'te-mo-ii'],
    'te-wa-ikenai': ['〜てはいけない', 5, 'must not', 'te-wa-ikenai'], 'te-hoshii': ['〜てほしい', 4, 'want someone to do', 'te-hoshii'],
    'adj-ta': ['〜かった（過去）', 5, 'past: was (ない and 〜たい change like い-adjectives: なかった, たかった)', 'ku-nai-katta-ku-nakatta'],
    'adj-nai': ['〜くない（否定）', 5, 'negative: is not', 'ku-nai-katta-ku-nakatta'], 'adj-nakatta': ['〜くなかった', 5, 'past negative: was not', 'ku-nai-katta-ku-nakatta'],
    'adj-te': ['〜くて', 5, 'and (joins)', 'kute-de'], 'adj-adv': ['〜く（副詞）', 5, 'adverb: -ly (はやく = quickly)', ''], 'adj-ba': ['〜ければ', 4, 'if', 'ba'],
    'adj-tara': ['〜かったら', 4, 'if; when', 'tara'], 'adj-temo': ['〜くても', 4, 'even if', 'te-mo-de-mo'], 'adj-sa': ['〜さ', 4, '-ness (たかさ = height)', 'sa'],
    'adj-sou': ['〜そうだ（様子）', 4, 'looks', 'sou-da-appearance'], 'adj-sugiru': ['〜すぎる', 4, 'too', 'sugiru'], 'adj-naru': ['〜くなる', 5, 'become', 'ku-naru-ni-naru'],
    'adj-garu': ['〜がる', 4, '(someone else) shows signs of feeling', 'garu'], 'adj-desu': ['〜いです', 5, 'polite: is', 'desu'], 'adj-suru': ['〜くする', 4, 'make (something) so', 'ku-suru-ni-suru'],
    'na-da': ['〜だ', 5, 'is (plain)', 'da'], 'na-desu': ['〜です', 5, 'is (polite)', 'desu'], 'na-ta': ['〜だった', 5, 'was (plain)', 'da'], 'na-deshita': ['〜でした', 5, 'was (polite)', 'deshita'],
    'na-nai': ['〜じゃない／〜ではない', 5, 'is not', 'de-wa-arimasen-ja-nai'], 'na-nakatta': ['〜じゃなかった／〜ではありませんでした', 5, 'was not', 'de-wa-arimasen-ja-nai'],
    'na-na': ['〜な＋名詞', 5, 'before a noun (しずかな町)', 'na-na-adjective'], 'na-ni': ['〜に（副詞）', 5, 'adverb: -ly (しずかに)', ''], 'na-de': ['〜で', 5, 'and (joins)', 'kute-de'],
    'na-nara': ['〜なら', 4, 'if', 'nara'], 'na-tara': ['〜だったら', 4, 'if; when', 'tara'], 'na-sou': ['〜そうだ（様子）', 4, 'looks', 'sou-da-appearance'],
    'na-sugiru': ['〜すぎる', 4, 'too', 'sugiru'], 'na-naru': ['〜になる', 5, 'become', 'ku-naru-ni-naru'], 'na-suru': ['〜にする', 4, 'make (something) so', 'ku-suru-ni-suru'],
    'na-dearu': ['〜である', 3, 'is (written style; である・であり・であった)', ''], darou: ['〜だろう', 4, 'probably; I suppose (plain)', 'darou'],
    deshou: ['〜でしょう', 5, 'probably (polite)', 'deshou'], renyou: ['連用形（中止形）', 3, 'the continuative stem: "…and" in written Japanese (読み、書き), and the base other endings attach to', ''],
    'te-kure': ['〜てくれ', 4, 'do it for me (blunt request)', 'te-kureru'], beki: ['〜べきだ', 3, 'should; ought to', 'beki-da-beki-de-wa-nai'],
    rashii: ['〜らしい', 4, 'it seems; I hear that', 'rashii'],
    'nai-col': ['〜ん／〜ねえ（話し言葉の否定）', 0, 'spoken negative: 分からない → 分かんない, 分からん; 知らない → 知らねえ (rough)', 'nai'],
    'nai-kansai': ['〜へん（関西弁の否定）', 0, 'Kansai dialect negative: 分からへん = 分からない', 'nai'],
    'adj-col': ['〜えー（くだけた発音）', 0, 'casual, rough pronunciation of an い-adjective: すごい → すげえ, うまい → うめー, ない → ねえ, さむい → さみい', ''],
    jan: ['〜じゃん', 0, "casual: …, right? / see? (from じゃないか)", ''], ssu: ['〜っす', 0, 'casual polite, short for です (younger speakers, to seniors they are close to)', 'desu'],
    'n-da': ['〜んだ／〜のです', 4, 'explaining, or asking for an explanation', 'n-desu-no-desu'], tte: ['〜って（伝聞）', 4, 'I hear; they say (spoken)', ''],
    mon: ['〜もん', 0, 'because… (spoken, a bit childish or emotional)', ''], kedo: ['〜けど', 4, 'but; …, though (softens the sentence)', ''],
    kana: ['〜かな', 4, 'I wonder…', ''], kamo: ['〜かもしれない', 4, 'might; maybe', 'kamo-shirenai'], kke: ['〜っけ', 3, 'was it…? (trying to remember)', ''],
    'te-wa': ['〜ちゃ／〜じゃ（〜ては）', 4, 'if you do… (spoken 〜ては, usually before だめ or いけない)', 'te-wa-ikenai'],
    'ba-col': ['〜りゃ／〜きゃ（〜ばの話し言葉）', 0, 'spoken 〜ば: 行けば → 行きゃ, 食べれば → 食べりゃ, 高ければ → 高けりゃ', 'ba'],
    yagaru: ['〜やがる', 0, 'vulgar: shows contempt for what someone does', ''], 'adj-ki': ['〜き（古い形）', 1, 'old attributive form (よき, 良き)', '']
  };
  // Where みんなの日本語 and GENKI teach each form: [みんなの日本語 lesson, GENKI lesson] (0 = not a lesson point).
  // A form's grammar level follows the books (1-25 / GENKI I = N5, 26-50 / GENKI II = N4) when they disagree with the list level.
  const FORM_BOOKS = { masu: [4, 3], mashita: [4, 4], masen: [4, 3], 'masen-deshita': [4, 4], mashou: [6, 5], 'masen-ka': [6, 3], te: [14, 6], ta: [19, 9],
    tara: [25, 17], tari: [19, 11], temo: [25, 23], nai: [17, 8], 'naide-kudasai': [17, 0], nakereba: [17, 12], 'nakute-mo-ii': [17, 17], pot: [27, 13],
    pass: [37, 21], passpot: [37, 21], caus: [48, 22], causpass: [0, 23], vol: [31, 15], ba: [35, 22], imp: [33, 0], proh: [33, 0], tai: [13, 11],
    nagara: [28, 18], sou: [43, 13], sugiru: [44, 12], yasui: [44, 0], nikui: [44, 0], 'ni-iku': [13, 0], kata: [0, 23], hajimeru: [0, 18],
    'te-iru': [14, 7], 'te-oku': [30, 15], 'te-shimau': [29, 18], 'te-miru': [40, 13], 'te-aru': [30, 21], 'te-ageru': [24, 16], 'te-kureru': [24, 16],
    'te-morau': [24, 16], 'te-kudasai': [14, 6], 'te-mo-ii': [15, 6], 'te-wa-ikenai': [15, 6], 'te-hoshii': [0, 21], 'adj-ta': [12, 5], 'adj-nai': [8, 5],
    'adj-nakatta': [12, 5], 'adj-te': [16, 7], 'adj-naru': [19, 10], 'adj-sou': [43, 13], 'adj-sugiru': [44, 12], 'na-da': [20, 8], 'na-ta': [20, 9],
    'na-deshita': [12, 5], 'na-nai': [8, 5], 'na-nakatta': [12, 5], 'na-na': [8, 5], 'na-de': [16, 7], 'na-naru': [19, 10], 'n-da': [26, 12],
    deshou: [21, 12], kamo: [32, 14], tsumori: [31, 10], tte: [0, 17] };
  function formBooks(g) {
    const b = FORM_BOOKS[g];
    if (!b) return '';
    return [b[0] ? 'みんなの日本語 第' + b[0] + '課' : '', b[1] ? 'GENKI ' + (b[1] <= 12 ? 'I' : 'II') + ' 第' + b[1] + '課' : ''].filter(Boolean).join(' · ');
  }
  function formLevelOf(g) {
    const lv = (FORM_LABEL[g] || [g, 5])[1], b = FORM_BOOKS[g];
    if (!b || !lv) return lv;
    const books = new Set(b.map((n, i) => (n ? (n <= (i === 0 ? 25 : 12) ? 5 : 4) : 0)).filter(Boolean));
    return books.has(lv) ? lv : Array.from(books).sort((x, y) => Math.abs(x - lv) - Math.abs(y - lv))[0];
  }
  const formLabel = (g) => { const L = FORM_LABEL[g] || [g, 5, '', '']; return [L[0], formLevelOf(g), L[2], L[3]]; };
  // The level of a searched form: the hardest of the word and the grammar steps that made it.
  function formLevel(e, info) {
    const parts = [{ what: e.primary, level: e.basis === 'c' ? 0 : (e.jlpt || 0), note: 'the word' }];
    for (const st of info.steps) parts.push({ what: formLabel(st.g)[0], level: formLabel(st.g)[1], note: formBooks(st.g) });
    const tested = parts.map((p) => p.level).filter((l) => l > 0);
    return { level: tested.length ? Math.min(...tested) : 0, casual: parts.some((p) => !p.level), parts: parts };
  }
  const FORM_HOW = {
    causpass: 'る-verb stem + させられる (食べさせられる); う-verb ない-stem + せられる, or the short される (書かせられる / 書かされる); する → させられる; 来る → こさせられる',
    renyou: 'the ます-stem: 食べ, 書き, し, 来 (き)', 'adj-adv': 'い-adjective stem + く (高い → 高く)', 'na-ni': 'な-adjective + に (静か → 静かに)',
    'na-dearu': 'noun / な-adjective + である', koto: 'dictionary form + こと', 'adj-ki': 'い-adjective stem + き', passpot: 'る-verb stem + られる (食べられる); 来る → こられる',
    'te-kure': 'Verb-te + くれ', 'adj-nakatta': 'い-adjective stem + くなかった'
  };
  const shortLabel = (g) => formLabel(g)[0].replace(/（[^）]*）$/, '');
  // Apply grammar to a dictionary form, the way the rules above undo it: 食べる + [caus, pass, ta] -> 食べさせられた.
  function forwardForm(base, kind, gids) {
    let cur = base, k = kind;
    const list = [];
    for (const g of gids) { if (g === 'causpass') list.push('caus', 'pass'); else list.push(g); }
    for (let g of list) {
      if ((g === 'pass' || g === 'pot') && (k === 'v1' || k === 'vk')) g = 'passpot';      // 食べられる, 食べさせられる, 来られる
      let best = null;
      for (const r of DEINFLECT.rules) {
        const kindOk = r.bk === k || (k === 'na' && r.bk === 'nn') || (k === 'nn' && r.bk === 'na');
        if (r.g !== g || !kindOk || !cur.endsWith(r.b) || (k === 'vk' && !/^(く|来)/.test(r.b))) continue;
        if (!best || r.b.length > best.b.length) best = r;
      }
      if (!best) return null;
      cur = cur.slice(0, cur.length - best.b.length) + best.i; k = best.ik || k;
    }
    return cur;
  }
  function renderForm(e, query, info, my) {
    const box = $('#form'), steps = $('#form-steps'), exBox = $('#form-ex'), list = $('#form-list'), alts = $('#form-alts');
    steps.textContent = ''; exBox.textContent = ''; list.textContent = ''; alts.textContent = '';
    box.hidden = true; alts.hidden = true; $('#form-list-wrap').hidden = true; steps.hidden = !info;
    study.formRow = null;
    if (!e) return Promise.resolve();
    const meta = study.grammarMeta;
    if (info) {
      $('#form-title').textContent = '';
      $('#form-title').appendChild(document.createTextNode('How '));
      $('#form-title').appendChild(el('span', { lang: 'ja' }, query));
      $('#form-title').appendChild(document.createTextNode(' is made'));
      const first = el('li', { class: 'fs-step fs-base' });
      const w = el('span', { class: 'fs-form', lang: 'ja' }, info.base);
      first.appendChild(w); furiganize(w, info.base);
      first.appendChild(el('span', { class: 'fs-what' }, 'dictionary form of ' + e.primary + ' (' + e.gloss.split(';')[0] + ')'));
      steps.appendChild(first);
      for (const s of info.steps) {
        const L = formLabel(s.g), li = el('li', { class: 'fs-step' });
        const head = el('div', { class: 'fs-head' });
        const f = el('span', { class: 'fs-form', lang: 'ja' }, s.form);
        head.appendChild(el('span', { class: 'fs-arrow', 'aria-hidden': 'true' }, '→'));
        head.appendChild(f); furiganize(f, s.form);
        head.appendChild(el('span', { class: 'gr-pat', lang: 'ja' }, L[0]));
        head.appendChild(el('span', { class: 'jlpt-mini', 'data-level': String(L[1]) }, 'N' + L[1]));
        li.appendChild(head);
        li.appendChild(el('p', { class: 'gr-mean' }, L[2]));
        const fb = formBooks(s.g);
        if (fb) { const bp = el('p', { class: 'gr-form' }); bp.appendChild(el('span', { class: 'gr-label' }, 'Taught in: ')); bp.appendChild(document.createTextNode(fb)); li.appendChild(bp); }
        const p = meta && L[3] && meta.points[L[3]], how = (p && p[3]) || FORM_HOW[s.g];
        if (how) { const fp = el('p', { class: 'gr-form' }); fp.appendChild(el('span', { class: 'gr-label' }, 'How it attaches: ')); fp.appendChild(document.createTextNode(how)); li.appendChild(fp); }
        steps.appendChild(li);
      }
      if (info.alts && info.alts.length) {
        alts.appendChild(document.createTextNode('It can also be read as a form of: '));
        info.alts.forEach((a) => { const b = el('button', { type: 'button', class: 'chip', lang: 'ja' }, a.entry.primary); b.addEventListener('click', () => submitSearch(a.entry.primary)); alts.appendChild(b); });
        alts.hidden = false;
      }
      box.hidden = false;
    } else {
      $('#form-title').textContent = 'This word in its different forms';
    }
    if (!/^(v|adj-i|adjx|adj-na)/.test(e.cls) && !info) return Promise.resolve();
    const sigs = info ? loadJSON('data/form-sig.json') : Promise.resolve(null);
    return Promise.all([loadJSON('data/fm/' + String(e.id % 64).padStart(2, '0') + '.json'), sigs]).then(([sh, sig]) => {
      if (my !== study.seq) return;
      const rows = (sh && sh[e.id]) || [];
      const sentence = (x, mark) => {
        const b = parseBraces(x[0]), ja = el('p', { class: 'gr-ex', lang: 'ja' });
        drawRuby(ja, b.segs, [mark]);
        exBox.appendChild(ja);
        const en = x[1] || NO_EN[x[6]] || '';
        if (en) exBox.appendChild(el('p', { class: 'ex-en' + (x[1] ? '' : ' muted') }, en));
        const src = el('p', { class: 'ex-src' }); sourceLine(src, x[6] || 't', x[2], x[7] || '', false); exBox.appendChild(src);
      };
      if (info) {
        let row = rows.find((r) => r[0] === query), note = '';
        const same = !row && sig ? (sig[info.steps.map((st) => st.g).join('+')] || []).filter((x) => x[1] !== e.primary).slice(0, 2) : [];
        if (same.length) {                 // nobody used this exact form with this word: the same grammar with other words, from real sentences
          exBox.appendChild(el('h3', { class: 'sub-h' }, 'The same grammar in real sentences, with other words:'));
          for (const x of same) {
            const r = x[2];
            sentence([r[0], r[1], r[2], 0, 0, 0, r[6], r[7]], [r[3], r[4], 'mark']);
            exBox.lastChild.appendChild(document.createTextNode(' · ' + x[0] + ' is a form of ' + x[1]));
          }
        }
        if (!row) {
          const common = (a) => { let i = 0; while (i < a.length && i < query.length && a[i] === query[i]) i++; return i; };
          row = rows.slice().sort((a, b) => common(b[0]) - common(a[0]) || b[1] - a[1])[0];
          if (row) note = 'No sentence in the collections uses exactly ' + query + ' with this word. Its nearest form in a real sentence is ' + row[0] + ':';
        }
        if (row) {
          study.formRow = row;
          exBox.appendChild(el('h3', { class: 'sub-h' }, note || 'In a real sentence'));
          const x = row[2];
          sentence(x, [x[3], x[4], 'mark']);
        }
      }
      const shown = rows.filter((r) => r[0] !== query).slice(0, 12);
      for (const r of shown) {
        const d = deinflect(r[0]);
        if (!d || d.entry.id !== e.id) continue;
        const b = el('button', { type: 'button', class: 'chip form-chip' });
        b.appendChild(el('b', { lang: 'ja' }, r[0]));
        b.appendChild(el('small', null, d.steps.map((s) => shortLabel(s.g)).join(' + ') + ' · ' + r[1]));
        b.addEventListener('click', () => submitSearch(r[0]));
        list.appendChild(b);
      }
      if (list.children.length) { $('#form-list-wrap').hidden = false; box.hidden = false; }
      if (info && study.formRow) renderFormStar();
    });
  }
  // Practice on the form itself: which grammar it uses, making the same form from another word, and ordering its sentence.
  const FORM_GROUPS = [['pass', 'caus', 'pot', 'causpass', 'passpot'], ['vol', 'ba', 'imp', 'tara', 'proh'], ['te-iru', 'te-oku', 'te-shimau', 'te-miru', 'te-aru', 'te-kuru', 'te-iku'],
    ['tai', 'tagaru', 'sou', 'sugiru', 'yasui', 'nikui', 'nagara'], ['ta', 'te', 'nai', 'masu', 'mashita', 'masen', 'zu', 'naide'], ['te-ageru', 'te-kureru', 'te-morau'],
    ['te-kudasai', 'te-mo-ii', 'te-wa-ikenai', 'nakereba'], ['adj-ta', 'adj-nai', 'adj-te', 'adj-adv', 'adj-ba', 'adj-naru', 'adj-sou', 'adj-sa'],
    ['na-ta', 'na-nai', 'na-na', 'na-ni', 'na-de', 'na-naru', 'na-sou']];
  function formIdentify(query, info) {
    const gids = info.steps.map((s) => s.g);
    const core = info.steps.slice().sort((a, b) => formLabel(a.g)[1] - formLabel(b.g)[1])[0].g;   // the most advanced grammar in it
    const group = FORM_GROUPS.find((gr) => gr.indexOf(core) >= 0) || FORM_GROUPS[4];
    const pool = shuffle(group).concat(shuffle([].concat(...FORM_GROUPS)));
    const wrong = [];
    for (const g of pool) {
      if (g === core || gids.indexOf(g) >= 0 || wrong.indexOf(g) >= 0) continue;
      if ((core === 'passpot' && /^(pass|pot)$/.test(g)) || (/^(pass|pot)$/.test(core) && g === 'passpot') || (core === 'causpass' && /^(caus|pass|passpot)$/.test(g))) continue;
      if (formLabel(g)[0] === formLabel(core)[0]) continue;
      wrong.push(g);
      if (wrong.length >= 3) break;
    }
    if (wrong.length < 3) return null;
    const opts = shuffle([core].concat(wrong));
    return { kicker: '文法の確認', instr: '「' + query + '」に 使われて いる 文法は どれですか。', stem: query, opts: opts.map((g) => formLabel(g)[0]), ans: opts.indexOf(core),
      level: formLabel(core)[1],
      explain: (b) => info.steps.forEach((s) => { const q = el('p', { class: 'q-gram' }); q.appendChild(el('b', { lang: 'ja' }, s.form)); q.appendChild(document.createTextNode('  ' + formLabel(s.g)[0] + ': ' + formLabel(s.g)[2])); b.appendChild(q); }) };
  }
  function formDrill(e, query, info) {
    const gids = info.steps.map((s) => s.g), kind = info.kind;
    if (!gids.length) return null;
    const isW = (w) => e.primary === w || e.kana[0] === w;
    let model;
    if (kind === 'v1') model = isW('食べる') ? 'みる' : 'たべる';
    else if (kind === 'v5') model = /[むぶぬ]$/.test(info.base) ? 'かく' : 'よむ';
    else if (kind === 'vs') model = isW('勉強') ? 'そうじする' : 'べんきょうする';
    else if (kind === 'vk') model = 'する';
    else if (kind === 'adj') model = isW('高い') || isW('たかい') ? 'ひろい' : 'たかい';
    else model = isW('静か') || isW('しずか') ? 'げんき' : 'しずか';
    const mk = kind === 'vk' ? 'vs' : kind === 'nn' ? 'na' : kind;
    const mForm = forwardForm(model, mk, gids);
    if (!mForm) return null;
    const right = query, wrong = [];
    const tryAdd = (f) => { if (f && f !== right && wrong.indexOf(f) < 0) wrong.push(f); };
    const SIB = { pass: ['caus', 'pot'], caus: ['pass', 'pot'], pot: ['pass', 'caus'], passpot: ['caus'], causpass: ['caus', 'pass'], ta: ['te', 'nai'], te: ['ta'],
      nai: ['ta'], masu: ['mashita', 'masen'], mashita: ['masu', 'masen-deshita'], masen: ['masu', 'masen-deshita'], 'masen-deshita': ['mashita', 'masen'], vol: ['ba', 'imp'],
      ba: ['vol', 'tara'], imp: ['vol', 'ba'], tara: ['ba', 'ta'], tai: ['nai', 'ta'], 'te-iru': ['te-aru', 'te-oku'], 'te-oku': ['te-iru', 'te-shimau'],
      'te-shimau': ['te-oku', 'te-iru'], 'adj-ta': ['adj-nai', 'adj-te'], 'adj-nai': ['adj-ta'], 'adj-te': ['adj-adv', 'adj-ta'], 'na-ta': ['na-nai'], 'na-nai': ['na-ta'],
      'na-da': ['na-ta', 'na-nai', 'na-na'], 'na-desu': ['na-deshita', 'na-nai', 'na-na'], 'na-dearu': ['na-ta', 'na-nai', 'na-ni'], darou: ['deshou', 'na-ta'] };
    gids.forEach((g, i) => (SIB[g] || []).forEach((s) => tryAdd(forwardForm(info.base, kind, gids.slice(0, i).concat([s], gids.slice(i + 1))))));
    if (gids.length > 1) gids.forEach((g, i) => tryAdd(forwardForm(info.base, kind, gids.slice(0, i).concat(gids.slice(i + 1)))));
    // other grammar of the same family (行かなければならない: 行ってもいい, 行ってはいけない), and the wrong う-verb row (行がなければ)
    gids.forEach((g, i) => { const gr = FORM_GROUPS.find((x) => x.indexOf(g) >= 0) || []; shuffle(gr).forEach((s) => { if (s !== g) tryAdd(forwardForm(info.base, kind, gids.slice(0, i).concat([s], gids.slice(i + 1)))); }); });
    if (kind === 'v5') for (const end of shuffle(['う', 'る', 'す', 'ぐ'])) {          // never another real verb (行く -> 行う)
      const nb = info.base.slice(0, -1) + end;
      if (!info.base.endsWith(end) && !lookupExact(nb).length) tryAdd(forwardForm(nb, 'v5', gids));
    }
    // the wrong verb group: 読む treated as a る-verb (読みさせられた), 食べる as an う-verb (食べらせられた)
    if (kind === 'v5') { const st = info.base.slice(0, -1) + ({ う: 'い', く: 'き', ぐ: 'ぎ', す: 'し', つ: 'ち', ぬ: 'に', ぶ: 'び', む: 'み', る: '' })[info.base.slice(-1)]; tryAdd(forwardForm(st + 'る', 'v1', gids)); }
    if (kind === 'v1') tryAdd(forwardForm(info.base, 'v5', gids));
    if (kind === 'v1' && gids[0] === 'passpot') tryAdd(forwardForm(info.base.slice(0, -1) + 'れる', 'v1', gids.slice(1)));   // 見れる: ら抜き, not the textbook form
    const basic = kind === 'adj' ? ['adj-ta', 'adj-nai', 'adj-te', 'adj-adv', 'adj-ba'] : /^(na|nn)$/.test(kind) ? ['na-ta', 'na-nai', 'na-na', 'na-ni', 'na-de', 'na-desu']
      : ['ta', 'te', 'nai', 'masu', 'mashita', 'masen', 'vol', 'ba'];
    if (wrong.length < 3) for (const g of shuffle(basic)) {   // other basic forms of the same word
      if (gids.indexOf(g) < 0) tryAdd(forwardForm(info.base, kind, gids.slice(0, -1).concat([g])));
      if (wrong.length >= 3) break;
    }
    const pick = wrong.slice(0, 2).concat(shuffle(wrong.slice(2))).slice(0, 3);          // the closest mistakes first
    if (pick.length < 3) return null;
    const opts = shuffle([right].concat(pick));
    const lv = formLevel(e, info).level;
    return { kicker: '活用（この形を作る）', instr: 'れいの ように、同じ 形に して ください。', stem: '（れい）' + model + ' → ' + mForm + '\n' + info.base + ' → （　　　）',
      opts: opts, ans: opts.indexOf(right), pre: true, level: lv,
      explain: (b) => info.steps.forEach((st, i) => b.appendChild(el('p', { class: 'q-why' }, (i ? '→ ' : info.base + ' → ') + st.form + ': ' + formLabel(st.g)[0] + ' — ' + formLabel(st.g)[2]))) };
  }
  function renderFormStar() {
    const row = study.formRow, e = study.entry;
    if (!row || !e) return;
    const x = row[2], b = parseBraces(x[0]);
    const spec = makeStarFrom(e, { plain: b.plain, cuts: x[5], anchor: x[3], id: x[2], src: x[6], by: x[7] || '',
      after: (box) => { const ja = el('p', { lang: 'ja' }); drawRuby(ja, b.segs, [[x[3], x[4], 'mark']]); box.appendChild(ja); if (x[1]) box.appendChild(el('p', { class: 'q-en' }, x[1])); } });
    if (!spec) return;
    const box = $('#drill-practice');
    spec.kicker = '練習 ' + (box.querySelectorAll('.q').length + 1) + '　文の組み立て（' + row[0] + '）';
    box.appendChild(questionCard(spec));
    $('#sec-drill').hidden = false;
  }

  /* ---------- wiring ---------- */
  function init() {
    const input = $('#q');
    const form = $('#search-form');

    // Enter while the Japanese keyboard is still converting must not search yet.
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.isComposing || ev.keyCode === 229)) ev.preventDefault(); });
    input.addEventListener('focus', () => { try { input.select(); } catch (e) { /* older Safari */ } });
    form.addEventListener('submit', (ev) => { ev.preventDefault(); submitSearch(input.value); });

    $('#prev-btn').addEventListener('click', () => { if (state.widget && state.track > 1) state.widget.previous(); });
    $('#next-btn').addEventListener('click', () => { if (state.widget && state.track < state.total) state.widget.next(); });
    $('#replay-btn').addEventListener('click', () => { if (state.widget) state.widget.replay(); });
    $('#back-btn').addEventListener('click', () => { if (state.widget) state.widget.move(-5); });
    $('#pause-btn').addEventListener('click', () => { if (!state.widget) return; if (state.playing) state.widget.pause(); else state.widget.play(); });
    $('#speed').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-speed]');
      if (!b) return;
      const sp = Number(b.dataset.speed);
      if (SPEEDS.indexOf(sp) < 0) return;
      state.wantSpeed = sp;
      renderSpeed(sp);
      if (state.widget) state.widget.setSpeed(sp);
    });

    const auto = $('#auto-next'), reps = $('#repeats');
    auto.checked = state.autoNext; reps.value = String(state.repeats);
    auto.addEventListener('change', () => { state.autoNext = auto.checked; state.views = 0; store.set('autoNext', state.autoNext); });
    reps.addEventListener('change', () => { state.repeats = Number(reps.value) || 1; state.views = 0; store.set('repeats', state.repeats); });

    $('#copy-btn').addEventListener('click', () => { if (state.targetText) copyText(state.targetText, 'Sentence copied'); });
    $('#save-btn').addEventListener('click', toggleSaved);
    $('#saved-copy').addEventListener('click', () => copyText(savedList().map((s) => [s.w, s.r, s.g].join('\t')).join('\n'), 'Saved words copied'));
    $('#history-clear').addEventListener('click', () => { store.set('history', []); renderHistory(); });
    $('#furi-btn').addEventListener('click', () => { furi.on = !furi.on; store.set('furigana', furi.on); ensureFurigana(); redrawCaptions(); });
    renderFuriButton(false);
    $('#examples-more').addEventListener('click', () => { study.showAll = !study.showAll; renderExamples(); });
    $('#practice-new').addEventListener('click', () => { renderDrills(); renderFormStar(); renderPractice(); renderGrammarPractice(); });

    $('#theme-toggle').addEventListener('click', () => {
      const root = document.documentElement;
      const dark = root.getAttribute('data-theme') ? root.getAttribute('data-theme') === 'dark'
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      const next = dark ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('kikitori.theme', next); } catch (e) { /* ignore */ }
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const tgt = ev.target || {}, tag = tgt.tagName;
      const typing = (tag === 'INPUT' && tgt.type !== 'checkbox' && tgt.type !== 'radio' && tgt.type !== 'button') || tag === 'TEXTAREA' || tag === 'SELECT' || tgt.isContentEditable;
      if (typing) return;
      const k = ev.key.toLowerCase();
      if (k === '/') { ev.preventDefault(); input.focus(); return; }
      if ($('#controls').hidden) return;
      if (k === 'n') $('#next-btn').click();
      else if (k === 'p') $('#prev-btn').click();
      else if (k === 'r') $('#replay-btn').click();
      else if (k === 'b') $('#back-btn').click();
      else if (k === 'k') $('#pause-btn').click();
    });

    const starters = $('#starter-chips');
    STARTERS.forEach((s) => starters.appendChild(wordChip(s[0], s[1], { literal: true })));

    renderHistory(); renderSaved(); renderSaveButton(); renderSpeed(1);

    // A link such as ?q=食べる fills the box; the video starts once Search is pressed, so a reopened tab stays quiet.
    let fromUrl = '';
    try { fromUrl = cleanQuery(new URLSearchParams(location.search).get('q') || ''); } catch (e) { fromUrl = ''; }
    if (fromUrl) input.value = fromUrl;

    loadWidgetScript();
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 600));
    idle(() => { loadDict(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  // Small surface for automated checks.
  window.__kikitori = { state: state, study: study, makeGrammarForm: makeGrammarForm, makeStar: makeStar, furiganize: furiganize, makeFormation: makeFormation, makeContext: makeContext, makeParaphrase: makeParaphrase, makeUsage: makeUsage, MAKERS: MAKERS, byId: byId, normForm: normForm, furi: furi, loadTokenizer: loadTokenizer, alignReading: alignReading, captionSegs: captionSegs, deinflect: deinflect, formParts: formParts, readingVariants: readingVariants, makeReading: makeReading, makeWriting: makeWriting, entryAt: entryAt, parseCaption: parseCaption, romajiToKana: romajiToKana, lookupExact: lookupExact, lookupReading: lookupReading, loadDict: loadDict,
    events: { onFetchDone: onFetchDone, onVideoChange: onVideoChange, onCaptionChange: onCaptionChange, onCaptionConsumed: onCaptionConsumed, onPlayerStateChange: onPlayerStateChange, onSpeedChange: onSpeedChange, onError: onError } };
})();
