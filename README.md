# Kikitori (聞き取り)

Type a Japanese word, hear it said in real YouTube videos, then study it.

- The video starts at the moment the word is spoken, with the caption shown underneath and your word marked.
- You see how many videos use the word, and **Next video** jumps to another one.
- You can type kanji (`食べる`), kana (`たべる`), romaji (`taberu`) or a conjugated form (`食べた`).
- Replay the sentence, go back 5 seconds, slow the speech down, or let it move through videos by itself.
- Each word shows its reading, meaning and **JLPT level**, with how the level was decided (see below).
- **Furigana** over the kanji in the video captions (with an on/off switch), in the example sentences, and in the sentence shown after you answer a practice question.
- **Example sentences** with English translations.
- **Grammar used with the word**: the grammar patterns that most often follow the word in Tatoeba's sentences, each with its JLPT level, an English explanation, how it attaches, and an example. Words with too few sentences show the patterns typical of that kind of word at its level.
- **Practice, all in Japanese and in JLPT style**, in three parts:
  - **語彙 (vocabulary)**: 漢字読み, 表記 (including katakana spelling), 語形成, 文脈規定, 言い換え類義 and 用法; at least three types for most words.
  - **文法 (grammar)**: 文法形式の判断 and 文の組み立て (★ ordering) made from sentences that use the word, and a 文章の文法 passage at the word's level.
  - **読解 (reading)**: a passage at the word's JLPT level, in the test's formats: short, medium and long passages, 統合理解 (two texts), 主張理解 (opinion piece) and 情報検索 (notices and flyers).
  - Questions from the official JLPT practice workbook appear when your word is in one.
  - Instructions are worded as each level's test booklet words them. Furigana appears only after you answer, on the question, every choice and the passage.
- Save words and reopen recent searches.

It is a plain website: it works in the browser on a laptop and on a phone.

## Put it online (one time)

The site is served by GitHub Pages straight from this repository.

1. Open the repository on GitHub, then **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick the branch **main** and the folder **/ (root)**, then **Save**.
3. Wait about a minute. The address appears at the top of that page:
   `https://horaceclaude.github.io/japanese-vocab-VideoSearching/`

On a free GitHub account, Pages only works for public repositories.

## Add it to your phone

Open the address on the phone, then:

- **iPhone (Safari):** Share → *Add to Home Screen*.
- **Android (Chrome):** menu ⋮ → *Add to Home screen* (or *Install app*).

## Good to know

- Search results, timing and captions come from [YouGlish](https://youglish.com/japanese) through its official widget. The count is the number of videos in YouGlish's Japanese index, not all of YouTube. The widget is free for non-commercial education use.
- Videos play in the YouTube player, so the [YouTube Terms of Service](https://www.youtube.com/t/terms) and the [Google Privacy Policy](https://policies.google.com/privacy) apply.
- **How JLPT levels are decided.** The JLPT has published no official word list since 2010, so levels combine independent evidence (`tools/build_levels.py`):
  1. Jonathan Waller's lists (the ones Jisho shows), with the community corrections of the Open Anki JLPT decks.
  2. The "egg rolls JLPT 10k" list, compiled from Chinese JLPT study books, about 10,000 words.
  3. Real exams: words that appeared in at least 3 N4, N3 or N2 exams since 2010 are placed no higher than that level.
  4. Words the official 2018 workbook tests at a given level.

  When the lists agree the level is shown as is. When they disagree, the level nearer the word's frequency-based estimate is kept. Words on no list get an estimate, labelled "(estimate)", from a model trained on the listed words (how common the word is, the JLPT level of its kanji, length and part of speech); on held-out listed words it gets the exact level about half the time and is within one level about 90% of the time. Very rare words are labelled "Beyond N1". Counts: about 12,500 words from the lists or exams, about 9,900 estimated, about 2,100 beyond N1.
- **Official questions** are the 162 vocabulary questions of the *Official Practice Workbook Vol. 2* (2018), all five levels, with their answer keys. Actual exam papers are not released, so this workbook is the official source there is. The 2012 workbook is published as scanned images and is not included.
- **Practice questions are made by the page**, not by the JLPT. Wrong choices are chosen to be close: readings that differ by one sound or one kanji's reading, kanji that look or sound alike, and words of the same kind and level that share a kanji. Because they are picked automatically, now and then a wrong choice could also fit; 用法 questions are only made for nouns, verbs and い-adjectives to keep that rare.
- **Caption furigana is worked out by the page**, with the kuromoji tokenizer, because YouGlish captions come without readings. It is usually right but can misread names and unusual words. Its dictionary is 18 MB, downloaded once in the background and then kept by the browser; the *Furigana* button under the caption switches it off. Furigana in the example sentences comes from Tatoeba.
- **Reading and text-grammar passages are original**, written for this site (25 reading passages and 5 text-grammar passages, covering N5 to N1). They follow the JLPT formats but are shorter than real long passages, and they are not about the searched word; they match its level. Not every word gets every question type: 文法形式の判断 needs a sentence where the word is followed by a recognised grammar pattern (about a quarter of words).
- **Grammar detection is automatic** (Sudachi tokenizer plus about 300 pattern rules over every Tatoeba sentence), so the counts are a guide, not a complete analysis.
- On phones the browser may wait for a tap on the video before it plays sound.
- Saved words and history are kept in the browser you use. The laptop and the phone each have their own list.
- A link such as `…/japanese-vocab-VideoSearching/?q=食べる` opens with the word filled in.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The page |
| `data/dict.json` | 24,000 words: spelling, reading, meaning, JLPT level, synonyms, word formation, and kanji tables for the questions |
| `data/ex/*.json` | 58,000 example sentences with translations, in 64 pieces loaded as needed |
| `data/jlpt-official.json` | The official workbook questions and which words each one tests |
| `data/grammar.json`, `data/gr/*.json` | Grammar points (level, English meaning, form) and the patterns found with each word |
| `data/reading.json` | The original reading and text-grammar passages |
| `tools/build_levels.py` | Combines the JLPT level sources and estimates the rest |
| `tools/build_grammar.py` | Finds the grammar used with each word in the Tatoeba sentences |
| `tools/build_dict.py` | Rebuilds `data/dict.json` |
| `tools/build_examples.py` | Rebuilds `data/ex/` from the Tatoeba exports |
| `tools/build_jlpt_questions.py` | Rebuilds `data/jlpt-official.json` from the workbook PDFs |
| `vendor/wanakana.min.js` | Romaji to kana conversion |
| `vendor/kuromoji/` | Tokenizer and dictionary used for caption furigana |
| `manifest.webmanifest`, `icons/` | Name and icon for the home screen |

Each build script says at its top where its input files come from.

## Credits

- [YouGlish](https://youglish.com) for the video index, timing and captions.
- [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) and KANJIDIC2 © Electronic Dictionary Research and Development Group, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). `data/dict.json` is derived from them and carries the same licence.
- JLPT levels: [Jonathan Waller's JLPT Resources](http://www.tanos.co.uk/jlpt/), CC BY, matched to JMdict entries by [stephenmk/yomitan-jlpt-vocab](https://github.com/stephenmk/yomitan-jlpt-vocab) and corrected by [jamsinclair/open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks); the "egg rolls JLPT 10k" list via [@polyglot-bundles/ja-jlpt-syllabi](https://www.npmjs.com/package/@polyglot-bundles/ja-jlpt-syllabi); exam word counts from the N2, N3 and N4 summaries of [IreneZihuiLi](https://github.com/IreneZihuiLi/jlpt-n2-stats) (counts only; no exam text is used); estimates with [wordfreq](https://github.com/rspeer/wordfreq) (data CC BY-SA 4.0).
- Grammar points, levels and English explanations: [OpenJLPT](https://github.com/evanclan/OpenJLPT), CC BY-SA 4.0. Sentences analysed with [SudachiPy](https://github.com/WorksApplications/sudachi.rs) (Apache 2.0) when the data is built.
- Synonyms: [Japanese WordNet](https://bond-lab.github.io/wnja/) © 2009-2011 NICT, via the Open Multilingual Wordnet data.
- Look-alike kanji: Lars Yencken's kanji confusion datasets (CC BY 3.0) and KanjiVG (CC BY-SA 3.0), via [@johnmorrisdotca/jisho](https://www.npmjs.com/package/@johnmorrisdotca/jisho).
- Example sentences from [Tatoeba](https://tatoeba.org), [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/). Each sentence links to its Tatoeba page and names its author where known.
- Official questions. Source: Official Worldwide Japanese-Language Proficiency Test Website (https://www.jlpt.jp/), *Japanese-Language Proficiency Test Official Practice Workbook Vol. 2*. Used under the site policy for Japanese-language education at no charge; copyright stays with the Japan Foundation and Japan Educational Exchanges and Services.
- [WanaKana](https://github.com/WaniKani/WanaKana), MIT licence (`vendor/wanakana.LICENSE.txt`).
- [kuromoji.js](https://github.com/takuyaa/kuromoji.js), Apache License 2.0, with the mecab-ipadic dictionary (`vendor/kuromoji/NOTICE.md`).
- Fonts: Klee One and Zen Kaku Gothic New (SIL Open Font License), served by Google Fonts.
