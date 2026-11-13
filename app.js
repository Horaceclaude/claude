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
        return true;
      })
      .catch(() => false);
    return dict.promise;
  }
  function entryAt(i) {
    const e = dict.entries[i];
    const kanji = e[0] ? e[0].split('|') : [], kana = e[1].split('|'), uk = !!e[4];
    return { kanji, kana, gloss: e[2], pos: e[3], uk, rank: e[5], id: e[6], jlpt: e[7] || 0, cls: e[8] || '', basis: e[9] || '', split: e[10] || '',
      syn: e[11] ? e[11].split('|') : [], formation: e[12] || '', primary: (uk || !kanji.length) ? kana[0] : kanji[0] };
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

  /* ----- conjugated input (食べた, 高くない, 勉強します) -> its dictionary word ----- */
  const MASU = { い: 'う', き: 'く', ぎ: 'ぐ', し: 'す', ち: 'つ', に: 'ぬ', び: 'ぶ', み: 'む', り: 'る' };
  const NAI = { わ: 'う', か: 'く', が: 'ぐ', さ: 'す', た: 'つ', な: 'ぬ', ば: 'ぶ', ま: 'む', ら: 'る' };
  const ENDS = {
    masu: ['ませんでした', 'ましょう', 'ました', 'ません', 'ます', 'たかった', 'たくない', 'たい', 'ながら', 'やすい', 'にくい'],
    te: ['ていました', 'ています', 'てください', 'ていない', 'ている', 'ていた', 'たら', 'たり', 'て', 'た'],
    de: ['でいました', 'でいます', 'でください', 'でいない', 'でいる', 'でいた', 'だら', 'だり', 'で', 'だ'],
    nai: ['なかった', 'なければ', 'ないで', 'なくて', 'ない'],
    adj: ['くなかった', 'くない', 'かった', 'ければ', 'くて', 'く'],
    na: ['でした', 'です', 'な', 'に', 'だ']
  };
  function deinflect(q) {
    const cands = [];                                   // [dictionary form, inflection class it must have]
    const strip = (list, fn) => { for (const end of list) if (q.length > end.length && q.endsWith(end)) { fn(q.slice(0, q.length - end.length)); break; } };
    const last = (b) => b[b.length - 1], cut = (b) => b.slice(0, b.length - 1);
    strip(ENDS.masu, (b) => { cands.push([b + 'る', /^v1$/]); if (MASU[last(b)]) cands.push([cut(b) + MASU[last(b)], /^v5/]); if (last(b) === 'し') cands.push([cut(b), /^vs$/]); });
    strip(ENDS.te, (b) => {
      cands.push([b + 'る', /^v1$/]);
      if (last(b) === 'っ') for (const k of 'うつる') cands.push([cut(b) + k, /^v5/]);
      if (last(b) === 'い') cands.push([cut(b) + 'く', /^v5k$/]);
      if (last(b) === 'し') { cands.push([cut(b) + 'す', /^v5s$/]); cands.push([cut(b), /^vs$/]); }
    });
    strip(ENDS.de, (b) => { if (last(b) === 'ん') for (const k of 'むぶぬ') cands.push([cut(b) + k, /^v5/]); if (last(b) === 'い') cands.push([cut(b) + 'ぐ', /^v5g$/]); });
    strip(ENDS.nai, (b) => { cands.push([b + 'る', /^v1$/]); if (NAI[last(b)]) cands.push([cut(b) + NAI[last(b)], /^v5/]); if (last(b) === 'し') cands.push([cut(b), /^vs$/]); });
    strip(ENDS.adj, (b) => cands.push([b + 'い', /^adj-i$/]));
    strip(ENDS.na, (b) => cands.push([b, /^(adj-na|n|vs|adv)$/]));
    const odd = /^行っ/.test(q) ? '行く' : /^来(た|て|ます|ました|ない|ません|なかった)/.test(q) ? '来る' : /^し(た|て|ます|ました|ない|ません|なかった)(い[るた]|います)?$/.test(q) ? 'する' : '';
    if (odd) { const hit = lookupExact(odd)[0]; if (hit) return { entry: hit, base: odd }; }
    for (const c of cands) {
      const hit = lookupExact(c[0]).find((e) => c[1].test(e.cls) && (e.primary === c[0] || e.kanji.indexOf(c[0]) >= 0 || !isKanaOnly(c[0])));
      if (hit) return { entry: hit, base: c[0] };
    }
    return null;
  }

  /* ---------- word details + kana hints (needs the dictionary) ---------- */
  function showWord(query) {
    const exact = lookupExact(query);
    let e = exact.length && (exact[0].primary === query || exact[0].kanji.indexOf(query) >= 0 || exact[0].kana.indexOf(query) >= 0) ? exact[0] : null;
    const base = e ? null : deinflect(query);            // 食べた is not in the dictionary, 食べる is
    if (base) e = base.entry;
    state.entry = e;
    $('#word-main').textContent = query;
    const reading = base ? 'a form of ' + base.base + (e.kana[0] !== base.base ? '（' + e.kana[0] + '）' : '') : (e && e.kana[0] !== query ? e.kana[0] : '');
    $('#word-reading').textContent = reading;
    // A kana query that is the reading of several kanji words has no single meaning to show.
    const kanaAmbiguous = e && !base && isKanaOnly(query) && e.primary !== query && lookupReading(query).length > 1;
    const showGloss = e && !kanaAmbiguous;
    $('#word-gloss').textContent = showGloss ? e.gloss : '';
    const pos = $('#word-pos');
    pos.textContent = showGloss ? e.pos : '';
    pos.hidden = !(showGloss && e.pos);
    $('#jisho-word').href = 'https://jisho.org/search/' + encodeURIComponent(query);
    $('#word').hidden = false;
    renderSaveButton();
    renderLevel(showGloss ? e : null);
    renderStudy(e, query, !!kanaAmbiguous);
  }
  function kanaHints(query, seq) {
    if (!isKanaOnly(query)) return;
    const others = lookupReading(query).filter((e) => e.primary !== query).slice(0, 5);
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
  const rowToEx = (x) => ({ ja: x[0].replace(/\{[^}]*\}/g, ''), furi: x[0], en: x[1], id: x[2], by: x[3], form: x[4] });
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
  function drawRuby(node, segs, ranges) {
    node.textContent = '';
    const inside = (at, len) => ranges.some((r) => at < r[1] && at + len > r[0]);
    let mark = null;
    const target = (hit) => { if (!hit) { mark = null; return node; } if (!mark) { mark = el('mark'); node.appendChild(mark); } return mark; };
    for (const s of segs) {
      if (s.r) {
        // The highlight goes on the word only, inside the <ruby>, so its reading stays above the coloured box.
        const hit = inside(s.at, s.t.length), ruby = el('ruby', hit ? { class: 'hit' } : null);
        ruby.appendChild(hit ? el('mark', null, s.t) : document.createTextNode(s.t));
        ruby.appendChild(el('rt', null, s.r));
        mark = null;
        node.appendChild(ruby);
      } else {
        for (let i = 0; i < s.t.length; i++) target(inside(s.at + i, 1)).appendChild(document.createTextNode(s.t[i]));
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
  const FIXED = { 一人: 'ひとり', 二人: 'ふたり', 一つ: 'ひとつ', 二つ: 'ふたつ', 三つ: 'みっつ', 四つ: 'よっつ', 五つ: 'いつつ', 六つ: 'むっつ', 七つ: 'ななつ', 八つ: 'やっつ', 九つ: 'ここのつ', 二十歳: 'はたち', 一日中: 'いちにちじゅう' };
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
    if (!e) { row.hidden = true; return; }
    const pill = $('#word-jlpt');
    pill.dataset.level = String(e.jlpt || 0);
    pill.dataset.basis = e.basis || '';
    pill.textContent = !e.jlpt ? 'Beyond N1' : 'JLPT N' + e.jlpt + (e.basis === 'e' ? ' (estimate)' : '');
    $('#word-jlpt-note').textContent = !e.jlpt ? 'rarer than the vocabulary the JLPT N1 expects'
      : LEVEL_NOTE[e.jlpt] + (BASIS_NOTE[e.basis] ? ' · ' + BASIS_NOTE[e.basis] : '');
    row.hidden = false;
  }

  function renderStudy(e, query, ambiguous) {
    const my = ++study.seq;
    study.entry = ambiguous ? null : e; study.query = query; study.examples = []; study.showAll = false;
    $('#study').hidden = false;
    $('#examples-list').textContent = '';
    $('#official-list').textContent = '';
    $('#practice-list').textContent = '';
    $('#examples-more').hidden = true;
    $('#official-block').hidden = true;
    $('#practice-block').hidden = true;
    const empty = $('#examples-empty');
    empty.hidden = false;
    renderOfficial(my);
    if (!study.entry) {
      empty.textContent = ambiguous
        ? 'This spelling can be several words. Pick one above to see its examples and practice.'
        : 'No dictionary entry for this exact text, so there are no examples or practice for it. Try a single word in its dictionary form.';
      return;
    }
    empty.textContent = 'Loading examples…';
    Promise.all([loadExamples(e.id), loadShard(e.id)]).then(([list, shard]) => {
      if (my !== study.seq) return;
      study.examples = list; study.shardData = shard;
      renderExamples();
      renderPractice();
    });
  }

  function renderExamples() {
    const list = study.examples, ol = $('#examples-list'), empty = $('#examples-empty'), more = $('#examples-more');
    ol.textContent = '';
    if (!list.length) {
      empty.textContent = 'No example sentence for this word in the Tatoeba collection.';
      empty.hidden = false; more.hidden = true;
      return;
    }
    empty.hidden = true;
    for (const x of (study.showAll ? list : list.slice(0, 3))) {
      const li = el('li');
      const ja = el('p', { class: 'ex-ja', lang: 'ja' });
      renderFurigana(ja, x.furi || x.ja, x.form);
      li.appendChild(ja);
      li.appendChild(el('p', { class: 'ex-en' }, x.en));
      const src = el('p', { class: 'ex-src' });
      src.appendChild(el('a', { href: 'https://tatoeba.org/sentences/show/' + x.id, target: '_blank', rel: 'noopener' }, 'Tatoeba #' + x.id + (x.by ? ' by ' + x.by : '')));
      li.appendChild(src);
      ol.appendChild(li);
    }
    more.hidden = list.length <= 3;
    more.textContent = study.showAll ? 'Show fewer' : 'Show all ' + list.length;
  }

  /* One multiple-choice card, used for official and for generated questions. */
  function questionCard(spec) {
    const art = el('article', { class: 'q' });
    art.appendChild(el('p', { class: 'q-kicker', lang: 'ja' }, spec.kicker));
    if (spec.sub) art.appendChild(el('p', { class: 'q-sub', lang: 'ja' }, spec.sub));
    const instr = el('p', { class: 'q-instr', lang: 'ja' }, spec.instr);
    art.appendChild(instr);
    const stem = el('p', { class: 'q-stem', lang: 'ja' });
    renderMarked(stem, spec.stem);
    art.appendChild(stem);
    const long = spec.opts.some((o) => o.replace(new RegExp('[' + U0 + U1 + ']', 'g'), '').length > 9);
    const ol = el('ol', { class: 'q-opts' + (long ? ' long' : '') });
    const result = el('p', { class: 'q-result', role: 'status', lang: 'ja' });
    const after = el('div', { class: 'q-after' });
    after.hidden = true;
    spec.opts.forEach((o, i) => {
      const li = el('li'), b = el('button', { type: 'button', class: 'q-opt', lang: 'ja' });
      b.appendChild(el('span', { class: 'n' }, String(i + 1)));
      const t = el('span');
      renderMarked(t, o);
      b.appendChild(t);
      b.addEventListener('click', () => {
        const all = ol.querySelectorAll('button');
        all.forEach((x) => { x.disabled = true; });
        all[spec.ans].classList.add('right');
        if (i !== spec.ans) b.classList.add('wrong');
        result.textContent = i === spec.ans ? '正解です。' : '不正解です。正しい答えは ' + (spec.ans + 1) + ' です。';
        result.className = 'q-result ' + (i === spec.ans ? 'ok' : 'no');
        if (spec.after) after.hidden = false;
      });
      li.appendChild(b); ol.appendChild(li);
    });
    art.appendChild(ol); art.appendChild(result);
    if (spec.after) { spec.after(after); art.appendChild(after); }
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
          instr: instrFor(type, paper.level), stem: q.stem, opts: q.opts, ans: q.ans - 1,
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
    return base.slice(0, base.length - parts.tailH.length) + parts.tailF;
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
      dict.entries.forEach((raw, i) => { if (!raw[7] || !raw[8]) return; const a = study.pools.get(raw[8]); if (a) a.push(i); else study.pools.set(raw[8], [i]); });
    }
    return study.pools.get(cls) || [];
  }
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
    for (const i of shuffle(pool(e.cls)).slice(0, 600)) {
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
  function finish(type, stem, right, wrong, x, e) {
    wrong = Array.from(new Set(wrong.filter((w) => w && w !== right)));
    if (wrong.length < 3) return null;
    const opts = shuffle([right].concat(wrong.slice(0, 3)));
    return {
      type: type, instr: instrFor(type, e.jlpt || 1), stem: stem, opts: opts, ans: opts.indexOf(right),
      after: (box) => {
        const ja = el('p', { lang: 'ja' });
        renderFurigana(ja, x.furi || x.ja, x.form);          // now that it is answered, show the readings
        box.appendChild(ja);
        if (x.en) box.appendChild(el('p', { class: 'q-en' }, x.en));
      },
      source: x.id ? (p) => {
        p.appendChild(document.createTextNode('例文：'));
        p.appendChild(el('a', { href: 'https://tatoeba.org/sentences/show/' + x.id, target: '_blank', rel: 'noopener' }, 'Tatoeba #' + x.id));
      } : null
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
  function makeWriting(e, x) {
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
    if (!e.syn.length) return null;
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
    if (!sh || !/^(n|vs|v1|v5[a-z]|adj-i)$/.test(e.cls) || x.ja.length > 34) return null;
    const parts = formParts(e, x.form);
    if (!parts) return null;
    const level = e.jlpt || 1, wrong = [];
    for (const id of shuffle(Object.keys(sh))) {
      if (wrong.length >= 3) break;
      const o = byId(+id);
      if (!o || o.id === e.id || o.cls !== e.cls || !o.jlpt || Math.abs(o.jlpt - level) > 2 || related(e, o)) continue;
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
    const slots = [], usedIds = new Set();
    for (const [type, make] of MAKERS) {
      let spec = null;
      const order = sentences.filter((x) => !usedIds.has(x.id)).concat(sentences.filter((x) => usedIds.has(x.id)));
      for (const x of order) { spec = make(e, x); if (spec) { usedIds.add(x.id); break; } }
      if (spec) slots.push(spec);
      else if (type === 'formation' && !e.formation && dict.compounds && dict.compounds[e.primary]) slots.push(formationFromBase(e));
    }
    let n = 0;
    const number = () => { box.querySelectorAll('.q-kicker').forEach((k, i) => { k.textContent = '練習問題 ' + (i + 1) + '　' + k.dataset.type; }); };
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
    $('#practice-new').addEventListener('click', renderPractice);

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
  window.__kikitori = { state: state, study: study, makeFormation: makeFormation, makeContext: makeContext, makeParaphrase: makeParaphrase, makeUsage: makeUsage, MAKERS: MAKERS, byId: byId, normForm: normForm, furi: furi, loadTokenizer: loadTokenizer, alignReading: alignReading, captionSegs: captionSegs, deinflect: deinflect, formParts: formParts, readingVariants: readingVariants, makeReading: makeReading, makeWriting: makeWriting, entryAt: entryAt, parseCaption: parseCaption, romajiToKana: romajiToKana, lookupExact: lookupExact, lookupReading: lookupReading, loadDict: loadDict,
    events: { onFetchDone: onFetchDone, onVideoChange: onVideoChange, onCaptionChange: onCaptionChange, onCaptionConsumed: onCaptionConsumed, onPlayerStateChange: onPlayerStateChange, onSpeedChange: onSpeedChange, onError: onError } };
})();
