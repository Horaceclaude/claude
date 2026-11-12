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
  const dict = { promise: null, entries: null, byText: null, byReading: null };
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
        dict.entries = E; dict.byText = byText; dict.byReading = byReading;
        return true;
      })
      .catch(() => false);
    return dict.promise;
  }
  function entryAt(i) {
    const e = dict.entries[i];
    const kanji = e[0] ? e[0].split('|') : [], kana = e[1].split('|'), uk = !!e[4];
    return { kanji, kana, gloss: e[2], pos: e[3], uk, rank: e[5], primary: (uk || !kanji.length) ? kana[0] : kanji[0] };
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

  /* ---------- word details + kana hints (needs the dictionary) ---------- */
  function showWord(query) {
    const exact = lookupExact(query);
    const e = exact.length && (exact[0].primary === query || exact[0].kanji.indexOf(query) >= 0 || exact[0].kana.indexOf(query) >= 0) ? exact[0] : null;
    state.entry = e;
    $('#word-main').textContent = query;
    const reading = e && e.kana[0] !== query ? e.kana[0] : '';
    $('#word-reading').textContent = reading;
    // A kana query that is the reading of several kanji words has no single meaning to show.
    const kanaAmbiguous = e && isKanaOnly(query) && e.primary !== query && lookupReading(query).length > 1;
    const showGloss = e && !kanaAmbiguous;
    $('#word-gloss').textContent = showGloss ? e.gloss : '';
    const pos = $('#word-pos');
    pos.textContent = showGloss ? e.pos : '';
    pos.hidden = !(showGloss && e.pos);
    $('#jisho-word').href = 'https://jisho.org/search/' + encodeURIComponent(query);
    $('#word').hidden = false;
    renderSaveButton();
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
  window.__kikitori = { state: state, parseCaption: parseCaption, romajiToKana: romajiToKana, lookupExact: lookupExact, lookupReading: lookupReading, loadDict: loadDict,
    events: { onFetchDone: onFetchDone, onVideoChange: onVideoChange, onCaptionChange: onCaptionChange, onCaptionConsumed: onCaptionConsumed, onPlayerStateChange: onPlayerStateChange, onSpeedChange: onSpeedChange, onError: onError } };
})();
