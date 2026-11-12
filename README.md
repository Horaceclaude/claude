# Kikitori (聞き取り)

Type a Japanese word and hear it said in real YouTube videos.

- The video starts at the moment the word is spoken, with the caption shown underneath and your word marked.
- You see how many videos use the word, and **Next video** jumps to another one.
- You can type kanji (`食べる`), kana (`たべる`) or romaji (`taberu`). Kana and romaji are matched to the usual spelling, because far more videos are indexed under it.
- Replay the sentence, go back 5 seconds, slow the speech down, or let it move through videos by itself.
- Each word shows its reading and meaning. You can save words and reopen recent searches.

It is a plain website: it works in the browser on a laptop and on a phone.

## Put it online (one time)

The site is served by GitHub Pages straight from this repository.

1. Open the repository on GitHub, then **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick the branch **main** and the folder **/ (root)**, then **Save**.
3. Wait about a minute. The address appears at the top of that page:
   `https://horaceclaude.github.io/claude/`

On a free GitHub account, Pages only works for public repositories. If the Pages screen asks for that, change it under **Settings → General → Danger Zone → Change repository visibility**. Nothing in this repository is personal.

## Add it to your phone

Open the address on the phone, then:

- **iPhone (Safari):** Share → *Add to Home Screen*.
- **Android (Chrome):** menu ⋮ → *Add to Home screen* (or *Install app*).

It then opens from its own icon, full screen.

## Good to know

- Search results, timing and captions come from [YouGlish](https://youglish.com/japanese) through its official widget. The count is the number of videos in YouGlish's Japanese index, which is large but is not all of YouTube.
- YouGlish offers the widget free for non-commercial education use. Ask them first before using this commercially or inside a packaged mobile app (see their [developer policy](https://youglish.com/api/doc/js-api)).
- Videos play in the YouTube player, so the [YouTube Terms of Service](https://www.youtube.com/t/terms) and the [Google Privacy Policy](https://policies.google.com/privacy) apply.
- On phones the browser may wait for a tap on the video before it plays sound. That is a browser rule.
- Saved words and history are kept in the browser you use. The laptop and the phone each have their own list.
- A link such as `…/claude/?q=食べる` opens with the word filled in.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The page |
| `data/dict.json` | 22,000 common words (spelling, reading, meaning) for the word card and the kana/romaji help |
| `tools/build_dict.py` | Rebuilds `data/dict.json` from the `jamdict-data` package on PyPI |
| `vendor/wanakana.min.js` | Romaji to kana conversion |
| `manifest.webmanifest`, `icons/` | Name and icon for the home screen |

To change the example words under "Try one", edit `STARTERS` at the top of `app.js`.

## Credits

- [YouGlish](https://youglish.com) for the video index, timing and captions.
- [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) © Electronic Dictionary Research and Development Group, used under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). `data/dict.json` is derived from it and carries the same licence.
- [WanaKana](https://github.com/WaniKani/WanaKana), MIT licence (`vendor/wanakana.LICENSE.txt`).
- Fonts: Klee One and Zen Kaku Gothic New (SIL Open Font License), served by Google Fonts.
