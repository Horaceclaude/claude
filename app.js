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
        return true;
      })
      .catch(() => false);
    return dict.promise;
  }
  function entryAt(i) {
    const e = dict.entries[i];
    const kanji = e[0] ? e[0].split('|') : [], kana = e[1].split('|'), uk = !!e[4];
    return { kanji, kana, gloss: e[2], pos: e[3], uk, rank: e[5], id: e[6], jlpt: e[7] || 0, cls: e[8] || '', primary: (uk || !kanji.length) ? kana[0] : kanji[0] };
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
    }
    addHistory(state.query, total);
  }
  function onVideoChange(e) {
    state.track = Number(e && e.trackNumber) || 0;
    state.videoId = e && e.video ? String(e.video) : null;
    state.clipTime = -1; state.views = 0; state.targetCid = null; state.targetText = '';
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
      renderSegs($('#slate-target'), cap.segs);
      $('#slate-live').hidden = true;
      renderLinks();
    } else {
      // The video has moved on: show the running caption under the pinned sentence.
      const live = $('#slate-live');
      live.textContent = cap.plain;
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
  const LEVEL_NOTE = { 5: 'the easiest level', 4: 'elementary level', 3: 'intermediate level', 2: 'upper-intermediate level', 1: 'the hardest level' };
  const TASK = {
    reading: 'Choose the correct reading of the underlined word.',
    orthography: 'Choose the correct way to write the underlined word.',
    context: 'Choose the word that best fills the blank.',
    paraphrase: 'Choose the option closest in meaning to the underlined part.',
    usage: 'Choose the sentence that uses this word correctly.'
  };
  const INSTR = {
    reading: '＿＿のことばの読み方として最もよいものを、１・２・３・４から一つえらびなさい。',
    orthography: '＿＿のことばを漢字で書くとき、最もよいものを、１・２・３・４から一つえらびなさい。',
    context: '（　　　）に入れるのに最もよいものを、１・２・３・４から一つえらびなさい。'
  };
  const study = { entry: null, query: '', examples: [], showAll: false, seq: 0, shards: new Map(), official: null, pools: null };

  function loadExamples(id) {
    const key = String(id % 64).padStart(2, '0');
    if (!study.shards.has(key)) {
      study.shards.set(key, fetch('data/ex/' + key + '.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
    }
    // The sentence arrives with readings in braces, 学{がっ}校{こう}; keep that for display and a plain copy for everything else.
    return study.shards.get(key).then((sh) => (sh[id] || []).map((x) => ({ ja: x[0].replace(/\{[^}]*\}/g, ''), furi: x[0], en: x[1], id: x[2], by: x[3], form: x[4] })));
  }
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
  function renderFurigana(node, furi, form) {
    node.textContent = '';
    const segs = [];
    const re = /([^{}])\{([^}]*)\}|([^{}]+?)(?=[^{}]\{|$)/g;
    let m, plain = '';
    while ((m = re.exec(furi))) {
      const t = m[1] != null ? m[1] : m[3], r = m[1] != null ? m[2] : '', prev = segs[segs.length - 1];
      if (r && prev && prev.r) { prev.t += t; prev.r += r; }          // 学+校 share one reading box, so the kanji stay evenly spaced
      else segs.push({ t: t, r: r, at: plain.length });
      plain += t;
    }
    const from = plain.indexOf(form), to = from < 0 ? -1 : from + form.length;
    let mark = null;
    const target = (inside) => { if (!inside) { mark = null; return node; } if (!mark) { mark = el('mark'); node.appendChild(mark); } return mark; };
    for (const s of segs) {
      if (s.r) {
        const ruby = el('ruby', null, s.t);
        ruby.appendChild(el('rt', null, s.r));
        target(s.at < to && s.at + s.t.length > from).appendChild(ruby);
      } else {
        for (let i = 0; i < s.t.length; i++) target(s.at + i >= from && s.at + i < to).appendChild(document.createTextNode(s.t[i]));
      }
    }
    node.normalize();
  }
  const wrapFirst = (text, part, by) => { const i = text.indexOf(part); return i < 0 ? text : text.slice(0, i) + by + text.slice(i + part.length); };

  function renderLevel(e) {
    const row = $('#word-level');
    if (!e) { row.hidden = true; return; }
    const pill = $('#word-jlpt');
    pill.dataset.level = String(e.jlpt || 0);
    pill.textContent = e.jlpt ? 'JLPT N' + e.jlpt : 'Not in the JLPT lists';
    $('#word-jlpt-note').textContent = e.jlpt ? LEVEL_NOTE[e.jlpt] : 'not on the N5 to N1 study lists';
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
    loadExamples(e.id).then((list) => {
      if (my !== study.seq) return;
      study.examples = list;
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
    art.appendChild(el('p', { class: 'q-kicker' }, spec.kicker));
    const instr = el('p', { class: 'q-instr' }, spec.instr);
    if (spec.instrLang) instr.lang = spec.instrLang;
    art.appendChild(instr);
    const stem = el('p', { class: 'q-stem', lang: 'ja' });
    renderMarked(stem, spec.stem);
    art.appendChild(stem);
    const long = spec.opts.some((o) => o.replace(new RegExp('[' + U0 + U1 + ']', 'g'), '').length > 9);
    const ol = el('ol', { class: 'q-opts' + (long ? ' long' : '') });
    const result = el('p', { class: 'q-result', role: 'status' });
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
        result.textContent = i === spec.ans ? 'Correct' : 'Not quite. The answer is ' + (spec.ans + 1) + '.';
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
      const role = ['Your word appears in the sentence', 'Your word is one of the choices', 'This question tests your word'];
      for (const h of hits) {
        const q = data.questions[h[0]], paper = data.papers[q.paper];
        box.appendChild(questionCard({
          kicker: 'Official JLPT question · N' + paper.level + ' · ' + role[h[1]],
          instr: TASK[q.type] || '', stem: q.stem, opts: q.opts, ans: q.ans - 1,
          source: (p) => {
            p.appendChild(document.createTextNode('Source: Official Worldwide Japanese-Language Proficiency Test Website (https://www.jlpt.jp/). '));
            p.appendChild(el('a', { href: paper.url + '#page=' + q.page, target: '_blank', rel: 'noopener' }, paper.title + ', question ' + q.n + ' ↗'));
          }
        }));
      }
      $('#official-block').hidden = false;
    });
  }

  /* ----- practice questions made from the example sentences ----- */
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
  const VOICE = (() => {
    const m = {}, add = (a, b) => { (m[a] = m[a] || []).push(b); (m[b] = m[b] || []).push(a); };
    'かが きぎ くぐ けげ こご さざ しじ すず せぜ そぞ ただ ちぢ つづ てで とど はば ひび ふぶ へべ ほぼ はぱ ひぴ ふぷ へぺ ほぽ'.split(' ').forEach((p) => add(p[0], p[1]));
    return m;
  })();
  // Near-miss readings of the kind the test uses: voiced or not, long or short vowel, small っ or not.
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
    return shuffle(out.filter((v) => v !== r));
  }
  function pool(cls) {
    if (!study.pools) {
      study.pools = new Map();
      dict.entries.forEach((raw, i) => { if (!raw[7] || !raw[8]) return; const a = study.pools.get(raw[8]); if (a) a.push(i); else study.pools.set(raw[8], [i]); });
    }
    return study.pools.get(cls) || [];
  }
  // Other words of the same kind and a similar level, put into the same form (食べて -> 起きて, 見て …).
  function otherWords(e, parts, want, asReading) {
    const level = e.jlpt || 2, out = [], seen = new Set([asReading ? parts.reading : parts.head.slice(0, parts.head.length - parts.tailH.length) + parts.tailF]);
    const kanjiWanted = !asReading && RE_KANJI.test(parts.head);
    for (const pass of [1, 4]) {
      for (const i of shuffle(pool(e.cls))) {
        if (out.length >= want) return out;
        const o = entryAt(i);
        if (o.id === e.id || Math.abs((o.jlpt || 2) - level) > pass) continue;
        const base = asReading ? o.kana[0] : o.primary;
        if (!base.endsWith(parts.tailH) || base.length <= parts.tailH.length) continue;
        if (asReading && (!RE_KANJI.test(o.primary) || Math.abs(base.length - (parts.reading.length - parts.tailF.length + parts.tailH.length)) > 1)) continue;
        if (kanjiWanted && !RE_KANJI.test(base)) continue;
        const f = base.slice(0, base.length - parts.tailH.length) + parts.tailF;
        if (seen.has(f)) continue;
        seen.add(f); out.push(f);
      }
    }
    return out;
  }
  function finish(kind, stem, right, wrong, x) {
    if (wrong.length < 3) return null;
    const opts = shuffle([right].concat(wrong.slice(0, 3)));
    return {
      kicker: kind, instr: INSTR[kind === 'Kanji reading' ? 'reading' : kind === 'Writing in kanji' ? 'orthography' : 'context'], instrLang: 'ja',
      stem: stem, opts: opts, ans: opts.indexOf(right),
      after: (box) => {
        const ja = el('p', { lang: 'ja' });
        renderMarked(ja, wrapFirst(x.ja, x.form, U0 + x.form + U1), 'mark');
        box.appendChild(ja);
        if (x.en) box.appendChild(el('p', null, x.en));
      },
      source: x.id ? (p) => {
        p.appendChild(document.createTextNode('Sentence: '));
        p.appendChild(el('a', { href: 'https://tatoeba.org/sentences/show/' + x.id, target: '_blank', rel: 'noopener' }, 'Tatoeba #' + x.id));
      } : null
    };
  }
  function makeReading(e, x) {
    const parts = formParts(e, x.form);
    if (!parts || !RE_KANJI.test(x.form) || !RE_HIRA.test(parts.reading)) return null;
    const headReading = parts.reading.slice(0, parts.reading.length - parts.tailF.length);
    let wrong = [];
    if (!parts.tailH) wrong = readingVariants(headReading).map((v) => v + parts.tailF);     // nouns: near-miss readings
    wrong = wrong.slice(0, 3);
    if (wrong.length < 3) wrong = wrong.concat(otherWords(e, parts, 3 - wrong.length, true).filter((w) => wrong.indexOf(w) < 0));
    return finish('Kanji reading', wrapFirst(x.ja, x.form, U0 + x.form + U1), parts.reading, wrong, x);
  }
  function makeWriting(e, x) {
    const parts = formParts(e, x.form);
    if (!parts || !RE_KANJI.test(x.form) || !dict.alt) return null;
    const chars = Array.from(x.form), spots = chars.map((c, i) => (dict.alt[c] ? i : -1)).filter((i) => i >= 0);
    if (!spots.length) return null;
    const wrong = new Set();
    for (let tries = 0; tries < 60 && wrong.size < 3; tries++) {
      const c = chars.slice();
      const picks = spots.length > 1 && Math.random() < 0.35 ? spots : [spots[Math.floor(Math.random() * spots.length)]];
      for (const i of picks) { const a = Array.from(dict.alt[chars[i]]); c[i] = a[Math.floor(Math.random() * Math.min(a.length, 6))]; }
      const w = c.join('');
      if (w !== x.form && !dict.byText.has(w)) wrong.add(w);
    }
    return finish('Writing in kanji', wrapFirst(x.ja, x.form, U0 + parts.reading + U1), x.form, Array.from(wrong), x);
  }
  function makeBlank(e, x) {
    const parts = formParts(e, x.form);
    if (!parts || (parts.tailF && !parts.tailH)) return null;   // 満足な would need distractors that also take な
    return finish('Fill in the blank', wrapFirst(x.ja, x.form, '（　　　）'), x.form, otherWords(e, parts, 3, false), x);
  }
  function renderPractice() {
    const e = study.entry, box = $('#practice-list');
    box.textContent = '';
    if (!e) { $('#practice-block').hidden = true; return; }
    let sentences = shuffle(study.examples);
    if (!sentences.length && state.targetText && state.targetText.indexOf(study.query) >= 0) {
      sentences = [{ ja: state.targetText, en: '', id: 0, by: '', form: study.query }];   // fall back to the caption on screen
    }
    if (/^(n|vs|adj-na|adv)$/.test(e.cls)) {                 // ask about 勉強, not 勉強し or 満足な
      const heads = e.kanji.concat(e.kana);
      sentences = sentences.map((x) => { const h = heads.find((w) => x.form !== w && x.form.startsWith(w)); return h ? Object.assign({}, x, { form: h }) : x; });
    }
    const cards = [];
    [makeReading, makeBlank, makeWriting].forEach((make, k) => {
      for (let j = 0; j < sentences.length; j++) {
        const spec = make(e, sentences[(j + k) % sentences.length]);
        if (spec) { cards.push(spec); break; }
      }
    });
    cards.forEach((c) => box.appendChild(questionCard(c)));
    $('#practice-block').hidden = cards.length === 0;
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
  window.__kikitori = { state: state, study: study, deinflect: deinflect, formParts: formParts, readingVariants: readingVariants, makeReading: makeReading, makeWriting: makeWriting, makeBlank: makeBlank, entryAt: entryAt, parseCaption: parseCaption, romajiToKana: romajiToKana, lookupExact: lookupExact, lookupReading: lookupReading, loadDict: loadDict,
    events: { onFetchDone: onFetchDone, onVideoChange: onVideoChange, onCaptionChange: onCaptionChange, onCaptionConsumed: onCaptionConsumed, onPlayerStateChange: onPlayerStateChange, onSpeedChange: onSpeedChange, onError: onError } };
})();
