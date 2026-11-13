// Which word a conjugated form belongs to when it fits two (おります: 居る, not 降りる; いった: 行く or 言う).
// Reads the forms counted in the sentence collections (data/fm, from tools/build_corpus.py), runs the page's own
// deinflector (the DEINFLECT block of app.js) on each, and keeps the cases where the corpus clearly prefers another word.
// It also keeps, for each chain of grammar (使役受身形 + た形, 〜ている + た形...), real sentences that use it with any word, so a
// form no sentence uses with the searched word can still be shown in use (data/form-sig.json).
// Usage: node tools/build_form_fix.js   (from the repository root) -> data/form-fix.json, data/form-sig.json
const fs = require('fs');
const app = fs.readFileSync('app.js', 'utf8');
const block = app.slice(app.indexOf('/* DEINFLECT START */'), app.indexOf('/* DEINFLECT END */'));
const rc = app.slice(app.indexOf('  function regularClass(w)'), app.indexOf('  // Words spelled exactly like q'));
const D = JSON.parse(fs.readFileSync('data/dict.json', 'utf8'));
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const isKanaOnly = (s) => /^[ぁ-ゟァ-ヿー]+$/.test(s);
const src = `const dict = { formFix: null };
function setFix(f) { dict.formFix = f; }
${rc}
function entryAt(i) {
  const e = D.entries[i]; const kanji = e[0] ? e[0].split('|') : [], kana = e[1].split('|'), uk = !!e[4];
  const primary = (uk || !kanji.length) ? kana[0] : kanji[0], raw = e[8] || '';
  return { kanji, kana, gloss: e[2], pos: e[3], uk, rank: e[5], id: e[6], jlpt: e[7] || 0, cls: raw === 'vx' ? regularClass(primary) : raw, rawCls: raw, primary };
}
const byText = new Map(), byReading = new Map();
D.entries.forEach((e, i) => {
  for (const t of (e[0] ? e[0].split('|') : []).concat(e[1].split('|'))) { if (!byText.has(t)) byText.set(t, []); byText.get(t).push(i); }
  for (const k of e[1].split('|')) { const h = toHira(k); if (!byReading.has(h)) byReading.set(h, []); byReading.get(h).push(i); }
});
function lookupExact(q) {
  const ids = new Set(byText.get(q) || []);
  if (isKanaOnly(q)) for (const i of (byReading.get(toHira(q)) || [])) ids.add(i);
  return Array.from(ids).map(entryAt).sort((a, b) => a.rank - b.rank);
}
${block}
return { deinflect, deinflectAll, setFix };`;
const H = new Function('D', 'toHira', 'isKanaOnly', src)(D, toHira, isKanaOnly);
const byForm = new Map();
for (let i = 0; i < 64; i++) {
  const sh = JSON.parse(fs.readFileSync('data/fm/' + String(i).padStart(2, '0') + '.json', 'utf8'));
  for (const id in sh) for (const [form, cnt] of sh[id]) {
    if (!byForm.has(form)) byForm.set(form, new Map());
    byForm.get(form).set(+id, (byForm.get(form).get(+id) || 0) + cnt);
  }
}
const fix = {};
let checked = 0;
for (const [form, m] of byForm) {
  const total = Array.from(m.values()).reduce((a, b) => a + b, 0);
  const [id, n] = Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0];
  if (n < 5 || n / total < 0.6) continue;
  checked++;
  const r = H.deinflect(form);
  if (!r || r.entry.id === id) continue;
  if (r.alts.some((a) => a.entry.id === id)) fix[form] = id;
}
fs.writeFileSync('data/form-fix.json', JSON.stringify(fix));
console.error('forms checked', checked, '| corrections', Object.keys(fix).length, '| bytes', fs.statSync('data/form-fix.json').size);

// ---- grammar chains in real sentences, from any word
H.setFix(fix);
const level = new Map(D.entries.map((e) => [e[6], e[7] || 0])), prim = new Map(D.entries.map((e) => [e[6], (e[4] || !e[0] ? e[1] : e[0]).split('|')[0]]));
const sig = {};
for (let i = 0; i < 64; i++) {
  const sh = JSON.parse(fs.readFileSync('data/fm/' + String(i).padStart(2, '0') + '.json', 'utf8'));
  for (const id in sh) for (const [form, cnt, row] of sh[id]) {
    const r = H.deinflect(form);
    if (!r || r.entry.id !== +id) continue;
    const key = r.steps.map((s) => s.g).join('+');
    const lv = level.get(+id) || 0;
    const score = (row[1] ? 0 : 60) + Math.abs(row[0].replace(/\{[^}]*\}/g, '').length - 18) + (lv ? (5 - lv) * 4 : 30);
    (sig[key] = sig[key] || []).push([score, form, prim.get(+id), row]);
  }
}
const out = {};
for (const k in sig) {
  const seen = new Set(), keep = [];
  for (const x of sig[k].sort((a, b) => a[0] - b[0])) { if (seen.has(x[2])) continue; seen.add(x[2]); keep.push(x.slice(1)); if (keep.length >= 3) break; }
  out[k] = keep;
}
fs.writeFileSync('data/form-sig.json', JSON.stringify(out));
console.error('grammar chains with real sentences', Object.keys(out).length, '| bytes', fs.statSync('data/form-sig.json').size);
