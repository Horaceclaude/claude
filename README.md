# Kikitori (聞き取り)

Type a Japanese word, hear it said in real YouTube videos, then study it.

- The video starts at the moment the word is spoken, with the caption shown underneath and your word marked.
- You see how many videos use the word, and **Next video** jumps to another one.
- You can type kanji (`食べる`), kana (`たべる`), romaji (`taberu`) or any conjugated form (`食べた`, `食べさせられなかった`, `読んでいる`, `高くなかった`, `静かだった`).
- **Conjugated forms are explained**: the page finds the dictionary word and shows, step by step, the grammar that made the form (食べる → 食べさせられる 使役受身形 → 食べさせられない ない形 → 食べさせられなかった 過去), each with its JLPT level and an English explanation. It shows a real sentence that uses that exact form, the word's other forms found in real sentences, and practice on the form: which grammar it uses, making the same form from another verb (with learner mistakes as wrong choices), and ordering the sentence (★).
- Replay the sentence, go back 5 seconds, slow the speech down, or let it move through videos by itself.
- Each word shows its reading, meaning and **JLPT level**, with how the level was decided (see below), and the lesson of *みんなの日本語* and *GENKI* that teaches it, when one does.
- **Furigana** over the kanji in the video captions (with an on/off switch), in the example sentences, and in the sentence shown after you answer a practice question.
- **Example sentences for every word**, with English translations where the source has them: from Tatoeba, from film and TV subtitles (JESC), and from Japanese Wikipedia. For the few words none of them contains (about 5%), the page makes a simple sentence and labels it as made by the page.
- **Grammar used with the word**: only the patterns found with this word itself, never a general list for its level. Each comes with its JLPT level, an English explanation, how it attaches, and a sentence that uses the word with it (with furigana). For nouns this includes the particle and the verb it usually leads to (電車に乗る, 雨が降る); for adverbs, the ending they call for (決して〜ない, たぶん〜でしょう, もし〜たら).
- **Textbook-style drills**, in the format of the *みんなの日本語* 練習A/練習B and *GENKI* conjugation drills (written for this site, not copied from the books):
  - verbs: change the ます-form into the て, た, ない or dictionary form (N5), and the potential, volitional, conditional, imperative, passive or causative form at higher levels. Wrong choices are the mistakes learners make: 読みて, 帰て, 行いて, しって.
  - い- and な-adjectives and nouns: the polite and plain past and negative forms (たかかったです, not たかいでした; きれいじゃありません, not きれくないです).
  - 練習B pattern changes with grammar this word is really used with, following a model: よみます → よんでいます.
- **Everyday spoken Japanese and slang**: about 30,600 words, adding every word common in real Japanese and the slang people use daily (やばい, マジ, めっちゃ, ウザい, ダサい, ドタキャン…), each marked with its register (slang, colloquial, familiar…). Slang no JLPT list or textbook has is labelled "casual · not in the JLPT" rather than given an invented level. Spoken forms are understood and explained too: 分かんない, 知らねえ, すげえ, いいじゃん, 行くっす, 行きゃ, 持ってく, 食べちゃ, 行ったっけ, 分からへん.
- **Grammar is named in Japanese and explained in English**: each pattern shows its Japanese name (〜に（到着点・方向）, 使役受身形, 副詞の呼応) and its connection in Japanese terms (接続：名詞 + に, 動詞て形 + いる), with the English meaning and the English form of the connection beside it.
- **Every question shows its JLPT level** (the word's level, the grammar point's level, or for conjugation drills the level of the form, with the みんなの日本語 and GENKI lessons that teach it), and **every question explains its answer** once answered, in English: the reading of each kanji and the kind of slip in each wrong reading (濁音, 長音, 促音, 拗音, another kanji reading); the wrong kanji in each wrong spelling; what each choice means and what the sentence means; which word each wrong 用法 sentence really needs; the grammar's Japanese name, meaning and 接続, and why each wrong choice cannot attach there; the verb group (一段動詞, 五段動詞, する・来る), the rule, why each wrong form is wrong and the verb's full conjugation table; or the line of the passage that gives the answer.
- **Practice, all in Japanese and in JLPT style**, in three parts:
  - **語彙 (vocabulary)**: 漢字読み, 表記 (including katakana spelling), 語形成, 文脈規定, 言い換え類義 and 用法; at least three types for most words.
  - **文法 (grammar)**: 文法形式の判断 in the forms the papers use (the grammar after the word; the word's own form before a pattern, as in 雨が（降り）そうです; the adverb that matches the sentence's ending, as in （決して）〜ない; or the particle, as in 写真（を）撮る), 文の組み立て (★ ordering) made from sentences that use the word, and a 文章の文法 passage at the word's level.
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
  5. The textbooks: words taught in *みんなの日本語 初級 I* (lessons 1–25) or *GENKI I* count as N5, *初級 II* (26–50) or *GENKI II* as N4; the Japan Foundation's *まるごと* (Starter A1 = N5, Elementary 1–2 A2 = N4, Pre-intermediate A2/B1 = N3, from its official vocabulary indexes) and *中級日本語カルテット Quartet* (I = N3, II = N2, from its official word index). A word's textbook level is the earliest stage any of these books teaches it at. Only which lesson teaches which word is used.

  When the lists agree the level is shown as is. When they disagree, the level nearer the word's frequency-based estimate is kept. Words on no list get an estimate, labelled "(estimate)", from a model trained on the listed words (how common the word is, the JLPT level of its kanji, length and part of speech); on held-out listed words it gets the exact level about half the time and is within one level about 90% of the time. Very rare words are labelled "Beyond N1". Counts: about 12,600 words from the lists, textbooks or exams, about 10,400 estimated, about 1,500 beyond N1.
- **Official questions** are the 162 vocabulary questions of the *Official Practice Workbook Vol. 2* (2018), all five levels, with their answer keys. Actual exam papers are not released, so this workbook is the official source there is. The 2012 workbook is published as scanned images and is not included.
- **Practice questions are made by the page**, not by the JLPT. Wrong choices are chosen to be close: readings that differ by one sound or one kanji's reading, kanji that look or sound alike, and words of the same kind and level that share a kanji. Because they are picked automatically, now and then a wrong choice could also fit; 用法 questions are only made for nouns, verbs and い-adjectives to keep that rare.
- **Caption furigana is worked out by the page**, with the kuromoji tokenizer, because YouGlish captions come without readings. It is usually right but can misread names and unusual words. Its dictionary is 18 MB, downloaded once in the background and then kept by the browser; the *Furigana* button under the caption switches it off. Furigana in the example sentences comes from Tatoeba.
- **Reading and text-grammar passages are original**, written for this site (25 reading passages and 5 text-grammar passages, covering N5 to N1). They follow the JLPT formats but are shorter than real long passages, and they are not about the searched word; they match its level.
- **A conjugated form's level** is the hardest of its parts: the word's own level and the level of each grammar step, where a step's level comes from when みんなの日本語 and GENKI teach it. 食べさせられた = 食べる (N5) + 使役受身形 (N4, GENKI II 第23課) + た形 (N5) → N4. The word card shows the breakdown.
- **Grammar levels are checked against the textbooks.** Each grammar point shows where it is taught: みんなの日本語 and GENKI (lessons of the core patterns), Tobira (its grammar index), and which volume of *A Dictionary of Basic / Intermediate / Advanced Japanese Grammar* has it (Basic ≈ N5–N4, Intermediate ≈ N3–N2, Advanced ≈ N1). The OpenJLPT level stands unless the textbooks disagree with it; four points change that way (〜ながら N4, 〜ことができる N5, 〜と思う N5, 〜ことにしている N4), and the page says so. Quartet I/II (its official grammar index) and a second list, JLPT Sensei, are used too: JLPT Sensei agrees with OpenJLPT on 348 of 419 shared points; where they differ, the textbooks decide. 新完全マスター and 総まとめ N1 publish no grammar index, so they are not used.
- **Grammar detection is automatic** (the Sudachi tokenizer plus about 300 pattern rules and particle rules, over about 2.3 million sentences from Tatoeba, JESC and Wikipedia), so the counts are a guide, not a complete analysis. A pattern is shown only when it appears with the word in at least 3% of the word's sentences (and at least twice).
- **Which question types a word gets.** Every word gets example sentences, at least three vocabulary types, a 文章の文法 passage and a reading passage at its level. 文法形式の判断 and 文の組み立て come from sentences with the word; when a word has no grammar pattern of its own (common for rare nouns), the 文法形式 question blanks another grammar point in a sentence that uses the word, and that point is not listed under "Grammar used with this word". Textbook drills are made for verbs, adjectives and nouns; adverbs and particles have none.
- **How conjugated forms are recognised.** The page undoes the endings with the standard conjugation tables (る-verbs, every う-verb row, する, 来る, 行く, い- and な-adjectives, nouns with the copula), step by step, and checks the result against the dictionary. Where a form can belong to two words (いった: 行く or 言う; きた: 来る or 着る), it picks the easier, more basic one and offers the others. Tested on the 51,000 forms found in the sentences (as the Sudachi tokenizer analysed them): the right word comes first for 96% of them (98% counting how often each form occurs), it is among the other readings offered for another 0.6%, and 2.7% (mostly dialect and slang, such as こだわってん) are not recognised. When no sentence uses the exact form with the searched word, the page shows real sentences with the same grammar and other words.
- **Checks on the sentences.** A subtitle's English is shown only when it contains a word of the dictionary meaning of the word it illustrates (subtitle translations are often loose or misaligned); otherwise the sentence is shown without a translation, and checked translations are preferred. Sentences must contain hiragana (no Chinese lines from the subtitles), and a kana word is not matched inside a longer kana word (テックス in ミューテックス).
- **Subtitles and Wikipedia** give everyday spoken Japanese and written Japanese. Subtitle translations are the film's English subtitles, so they can be loose; Wikipedia sentences have no translation. Each sentence names its source and links to it.
- On phones the browser may wait for a tap on the video before it plays sound.
- Saved words and history are kept in the browser you use. The laptop and the phone each have their own list.
- A link such as `…/japanese-vocab-VideoSearching/?q=食べる` opens with the word filled in.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The page |
| `data/dict.json` | 24,000 words: spelling, reading, meaning, JLPT level, synonyms, word formation, and kanji tables for the questions |
| `data/ex/*.json` | about 160,000 example sentences (every word has some), in 64 pieces loaded as needed |
| `data/jlpt-official.json` | The official workbook questions and which words each one tests |
| `data/grammar.json`, `data/gr/*.json` | Grammar points (level, English meaning, form) and the patterns found with each word |
| `data/reading.json` | The original reading and text-grammar passages |
| `tools/build_levels.py` | Combines the JLPT level sources and estimates the rest |
| `tools/build_corpus.py` | Adds subtitle and Wikipedia sentences, finds the grammar (and particles) used with each word, and records each verb's and adjective's conjugated forms |
| `data/fm/*.json` | Conjugated forms of each verb and adjective as found in the sentences, how often, and a sentence for each |
| `data/form-fix.json`, `data/form-sig.json` | Which word a form belongs to when it fits two (as the sentences use it), and real sentences for each chain of grammar |
| `data/grammar-refs.json`, `tools/build_grammar_refs.py` | Where the textbooks teach each grammar point, and the level that follows |
| `tools/build_form_fix.js` | Builds those two files by running the page's own deinflector over the recorded forms (`node tools/build_form_fix.js`) |
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
- まるごと 日本のことばと文化 vocabulary indexes © The Japan Foundation ([marugoto.jpf.go.jp](https://www.marugoto.jpf.go.jp/en/download/)); 中級日本語カルテット word and grammar indexes © The Japan Times ([quartet.japantimes.co.jp](https://quartet.japantimes.co.jp/en/learner/)); grammar levels of [JLPT Sensei](https://jlptsensei.com/complete-jlpt-grammar-list/). Only which level or lesson has a word or pattern is used.
- Textbook grammar references: lesson numbers of みんなの日本語 (3A Corporation) and GENKI (The Japan Times) from their tables of contents; Tobira chapters from the grammar index of [SethClydesdale/tobira-study-resources](https://github.com/SethClydesdale/tobira-study-resources); *A Dictionary of Basic / Intermediate / Advanced Japanese Grammar* (Makino & Tsutsui, The Japan Times) volumes from the DoJG data of [aiko-tanaka/Grammar-Dictionaries](https://github.com/aiko-tanaka/Grammar-Dictionaries). Only which book and lesson teach a pattern is used.
- Grammar points, levels and English explanations: [OpenJLPT](https://github.com/evanclan/OpenJLPT), CC BY-SA 4.0. Sentences analysed with [SudachiPy](https://github.com/WorksApplications/sudachi.rs) (Apache 2.0) when the data is built.
- Synonyms: [Japanese WordNet](https://bond-lab.github.io/wnja/) © 2009-2011 NICT, via the Open Multilingual Wordnet data.
- Look-alike kanji: Lars Yencken's kanji confusion datasets (CC BY 3.0) and KanjiVG (CC BY-SA 3.0), via [@johnmorrisdotca/jisho](https://www.npmjs.com/package/@johnmorrisdotca/jisho).
- Example sentences from [Tatoeba](https://tatoeba.org), [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/); each links to its Tatoeba page and names its author where known. Film and TV subtitle sentences from [JESC](https://nlp.stanford.edu/projects/jesc/) (Pryzant et al., Stanford University, Google Brain and Rakuten Institute of Technology), CC BY 4.0 as given on its [dataset card](https://huggingface.co/datasets/nntsuzu/JESC). Sentences from [Japanese Wikipedia](https://ja.wikipedia.org/) ([CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)), each linking to its article.
- Textbook lessons: which lesson of *みんなの日本語* (3A Corporation) teaches a word, via [ganseed/minna-no-nihongo-vocabulary](https://github.com/ganseed/minna-no-nihongo-vocabulary), and of *GENKI* (The Japan Times), via [jackiewkr/genki1-vocab](https://github.com/jackiewkr/genki1-vocab). The word selections belong to their publishers; only lesson references are used, and no textbook text or exercise is reproduced.
- Official questions. Source: Official Worldwide Japanese-Language Proficiency Test Website (https://www.jlpt.jp/), *Japanese-Language Proficiency Test Official Practice Workbook Vol. 2*. Used under the site policy for Japanese-language education at no charge; copyright stays with the Japan Foundation and Japan Educational Exchanges and Services.
- [WanaKana](https://github.com/WaniKani/WanaKana), MIT licence (`vendor/wanakana.LICENSE.txt`).
- [kuromoji.js](https://github.com/takuyaa/kuromoji.js), Apache License 2.0, with the mecab-ipadic dictionary (`vendor/kuromoji/NOTICE.md`).
- Fonts: Klee One and Zen Kaku Gothic New (SIL Open Font License), served by Google Fonts.
