# Kikitori (聞き取り)

Type a Japanese word, hear it said in real YouTube videos, then study it.

- The video starts at the moment the word is spoken, with the caption shown underneath and your word marked.
- You see how many videos use the word, and **Next video** jumps to another one.
- You can type kanji (`食べる`), kana (`たべる`), romaji (`taberu`) or a conjugated form (`食べた`).
- Replay the sentence, go back 5 seconds, slow the speech down, or let it move through videos by itself.
- Each word shows its reading, meaning and **JLPT level** (N5 to N1, or not on the lists).
- **Example sentences** with English translations.
- **Practice**: questions from the official JLPT practice workbook when your word appears in one, and questions in JLPT format (kanji reading, fill in the blank, writing in kanji) made from the example sentences. Tap an answer to check it.
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
- **JLPT levels are a best guess.** The JLPT has published no word list since 2010. The levels here are Jonathan Waller's widely used lists, the same ones Jisho shows.
- **Official questions** are the 162 vocabulary questions of the *Official Practice Workbook Vol. 2* (2018), all five levels, with their answer keys. Actual exam papers are not released, so this workbook is the official source there is. The 2012 workbook is published as scanned images and is not included.
- **Practice questions are made by the page**, not by the JLPT. The wrong choices are picked automatically, so now and then one of them could also fit the sentence.
- On phones the browser may wait for a tap on the video before it plays sound.
- Saved words and history are kept in the browser you use. The laptop and the phone each have their own list.
- A link such as `…/japanese-vocab-VideoSearching/?q=食べる` opens with the word filled in.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The page |
| `data/dict.json` | 23,000 words: spelling, reading, meaning, JLPT level |
| `data/ex/*.json` | 58,000 example sentences with translations, in 64 pieces loaded as needed |
| `data/jlpt-official.json` | The official workbook questions and which words each one tests |
| `tools/build_dict.py` | Rebuilds `data/dict.json` |
| `tools/build_examples.py` | Rebuilds `data/ex/` from the Tatoeba exports |
| `tools/build_jlpt_questions.py` | Rebuilds `data/jlpt-official.json` from the workbook PDFs |
| `vendor/wanakana.min.js` | Romaji to kana conversion |
| `manifest.webmanifest`, `icons/` | Name and icon for the home screen |

Each build script says at its top where its input files come from.

## Credits

- [YouGlish](https://youglish.com) for the video index, timing and captions.
- [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) and KANJIDIC2 © Electronic Dictionary Research and Development Group, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). `data/dict.json` is derived from them and carries the same licence.
- JLPT levels from [Jonathan Waller's JLPT Resources](http://www.tanos.co.uk/jlpt/), CC BY, matched to JMdict entries by [stephenmk/yomitan-jlpt-vocab](https://github.com/stephenmk/yomitan-jlpt-vocab).
- Example sentences from [Tatoeba](https://tatoeba.org), [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/). Each sentence links to its Tatoeba page and names its author where known.
- Official questions. Source: Official Worldwide Japanese-Language Proficiency Test Website (https://www.jlpt.jp/), *Japanese-Language Proficiency Test Official Practice Workbook Vol. 2*. Used under the site policy for Japanese-language education at no charge; copyright stays with the Japan Foundation and Japan Educational Exchanges and Services.
- [WanaKana](https://github.com/WaniKani/WanaKana), MIT licence (`vendor/wanakana.LICENSE.txt`).
- Fonts: Klee One and Zen Kaku Gothic New (SIL Open Font License), served by Google Fonts.
