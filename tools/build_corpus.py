"""Build the sentence data: example sentences for every word, and the grammar each word is used with.

Corpora
  Tatoeba        human-translated sentences (CC BY 2.0 FR): jpn_indices.csv, jpn_sentences_detailed.tsv.bz2,
                 eng_sentences_detailed.tsv.bz2, jpn_transcriptions.tsv.bz2 from https://downloads.tatoeba.org/exports/
  JESC           Japanese-English Subtitle Corpus (Pryzant et al. 2018), film and TV subtitles with English,
                 https://huggingface.co/datasets/nntsuzu/JESC (data/train-00000-of-00001.parquet)
  Wikipedia      Japanese Wikipedia (CC BY-SA), https://huggingface.co/datasets/wikimedia/wikipedia (20231101.ja parquet files)
Grammar points: data/csv of https://github.com/evanclan/OpenJLPT (CC BY-SA 4.0)
Needs: pip install sudachipy sudachidict_core pyarrow

Usage: python3 tools/build_corpus.py data/dict.json GRAMMAR_DIR TATOEBA_DIR jesc.parquet "wiki00.parquet,wiki01.parquet" data
       (run tools/build_examples.py first: its Tatoeba examples in data/ex are kept and topped up from the other corpora)

Writes
  data/ex/00..63.json  examples per word: [sentence with readings in braces, English, id, author or article, the word as written,
                       phrase boundaries, source: t Tatoeba / j JESC / w Wikipedia / m made by this page]
  data/gr/00..63.json  grammar per word: [[grammar id, sentences with it, sentences looked at,
                       [sentence with readings, English, id, word start, word end, grammar start, grammar end, phrase boundaries, source, article],
                       and for a particle (〜を, 〜に...): the verb or adjective it most often leads to, in how many sentences,
                       and the case particles almost never used before that verb (wrong choices for a particle question)]]
                       A count of 0 marks grammar found elsewhere in a sentence with the word: for practice questions only.
  data/grammar.json    grammar points: id -> [pattern, level, English meaning, formation, most common surface, how it attaches]
"""
import sys, os, re, csv, bz2, json, collections, math
from sudachipy import Dictionary, SplitMode

dict_path, grammar_dir, tdir, jesc_path, wiki_paths, out_dir = sys.argv[1:7]
SHARDS, PER_WORD_SENTENCES, PER_WORD_POINTS, PER_WORD_EXAMPLES = 64, 400, 5, 6
WIKI_SENTENCES = 2500000

# ------------------------------------------------------------------ grammar points
G = {}
for n in (5, 4, 3, 2, 1):
    with open(os.path.join(grammar_dir, 'grammar-n%d.csv' % n), encoding='utf-8') as f:
        for r in csv.DictReader(f):
            G[r['id']] = [r['pattern'], n, r['meaning'], r['formation'], '']

# (grammar id, connections, word kinds, regex on the text right after the connection point)
#   connections: stem (連用形), te (after て/で), ta (after た/だ), dict (終止・連体形), nai (未然形), ba (仮定形),
#                vol (意志形), ku (adjective く-form), astem (adjective stem), noun (after a noun or な-adjective)
#   kinds: V verb, A い-adjective, N noun / な-adjective / adverb
V, A, N, VA = 'V', 'A', 'ND', 'VA'      # N rules also apply to な-adjectives (D)
R = [
    # ---- masu-stem
    ('tagaru', 'stem', V, r'たが[らりるれっ]'), ('tai', 'stem', V, r'(たい|たく|たかっ|たけれ)'),
    ('nagara', 'stem', V, r'ながら'), ('sugiru', 'stem', V, r'(すぎ|過ぎ)'), ('yasui-nikui', 'stem', V, r'(やす|にく)[いくかけさそ]'),
    ('kata', 'stem', V, r'方(?![向面])'), ('hajimeru-owaru-tsuzukeru', 'stem', V, r'(始め|はじめ|終わ|終え|おわ|続け|つづけ)'),
    ('dasu', 'stem', V, r'出[さしすせそ]'), ('nasai', 'stem', V, r'なさい'), ('mashou-ka', 'stem', V, r'ましょうか'),
    ('mashou', 'stem', V, r'ましょう'), ('masen-ka', 'stem', V, r'ませんか'),
    ('masu-you-ni', 'stem', V, r'ま(す|せん)ように'),
    ('ni-iku', 'stem', V, r'に(行|い[かきくけこっ]|来|き[たてま]|く[るれ]|帰)'),
    ('sou-ni-nai-sou-mo-nai', 'stem', V, r'そう(に|も)な'), ('sou-da-appearance', 'stem', V, r'そう(だ|です|な|に|で)'),
    ('kiru-kirenai', 'stem', V, r'切[らりるれっ]'), ('kakeru', 'stem', V, r'かけ[るたてまの]'), ('au', 'stem', V, r'合[わいうえっ]'),
    ('naosu', 'stem', V, r'直[さしすせそ]'), ('zurai', 'stem', V, r'づら'), ('gachi', 'stem', V, r'がち'),
    ('kanenai', 'stem', V, r'かねな'), ('kaneru', 'stem', V, r'かね[るま]'), ('tsutsu-aru', 'stem', V, r'つつあ'),
    ('tsutsu-tsutsu-mo', 'stem', V, r'つつ'), ('ppanashi', 'stem', V, r'っぱなし'), ('nuku', 'stem', V, r'抜[かきくけこい]'),
    ('uru-enai', 'stem', V, r'得[るな]'), ('gatai', 'stem', V, r'がた[いく]'), ('you-ga-nai', 'stem', V, r'ようがな'),
    ('shidai', 'stem', V, r'次第'), ('kko-nai', 'stem', V, r'っこな'), ('gatera', 'stem', V, r'がてら'),
    ('ppoi', 'stem', V, r'っぽ'), ('gimi', 'stem', V, r'気味'),
    # ---- て-form
    ('te-kuremasen-ka-te-itadakemasen-ka', 'te', V, r'(くれませんか|いただけませんか)'),
    ('te-kudasai', 'te', V, r'ください(?!ま)'), ('te-kudasaru-te-itadaku', 'te', V, r'(くださ[るっりいれ]|いただ|頂)'),
    ('te-mo-ii', 'te', V, r'も(いい|よい|良い|よろし)'), ('te-mo-kamawanai', 'te', VA, r'も(構わ|かまわ)'),
    ('te-wa-irarenai', 'te', V, r'はいられな'), ('te-wa-ikenai', 'te', V, r'は(いけ|いか|だめ|ダメ|ならな)'),
    ('te-mo-de-mo', 'te', VA, r'も'), ('te-kara-to-iu-mono', 'te', V, r'からというもの'),
    ('te-kara-de-nai-to', 'te', V, r'からでな'), ('te-kara', 'te', V, r'から'),
    ('te-shimau-chau', 'te', V, r'しま[うわいえおっ]'), ('te-oku', 'te', V, r'お[かきくけこい](?!り)'),
    ('te-miru', 'te', V, r'み[るたてまよなれ]'), ('te-aru', 'te', V, r'あ[るりっ]'), ('te-ageru', 'te', V, r'(あげ|上げ|やっ|やる)'),
    ('te-kureru', 'te', V, r'くれ'), ('te-morau', 'te', V, r'もら'), ('te-iku', 'te', V, r'(い[かきくけこっ]|行)'),
    ('te-kuru', 'te', V, r'(く[るれ]|き[たてま]|来)'), ('te-iru', 'te', V, r'(い[るまたなてれ]|る|おり|おる)'),
    ('te-hoshii', 'te', V, r'(ほし|欲し)'), ('te-shou-ga-nai-te-shikata-ga-nai', 'te', VA, r'(しょうがな|しようがな|しかたがな|しかたな|仕方がな|仕方な)'),
    ('te-tamaranai', 'te', VA, r'たまらな'), ('te-naranai', 'te', VA, r'ならな'), ('te-hajimete', 'te', V, r'(はじめて|初めて)'),
    ('te-bakari-iru', 'te', V, r'ばかり'), ('te-koso', 'te', V, r'こそ'), ('te-irai', 'te', V, r'以来'), ('te-yamanai', 'te', V, r'やまな'),
    # ---- た-form
    ('ta-koto-ga-aru', 'ta', V, r'こと(が|は)(あ|な)'), ('hou-ga-ii', 'ta', V, r'(ほう|方)が(いい|よい|良)'),
    ('ato-de', 'ta', V, r'(後|あと)(で|に)'), ('ta-bakari', 'ta', V, r'ばかり'), ('tara-saigo-ga-saigo', 'ta', V, r'ら最後'),
    ('tara-dou', 'ta', V, r'らどう'), ('tara', 'ta', VA, r'ら'), ('tari-tari-suru', 'ta', V, r'り'),
    ('ta-tokoro-de', 'ta', V, r'ところで'), ('ta-tokoro', 'ta', V, r'ところ'), ('mama', 'ta', V, r'まま'),
    ('ta-totan-ta-totan-ni', 'ta', V, r'(とたん|途端)'), ('ageku', 'ta', V, r'あげく'), ('sue-ni', 'ta', V, r'末'),
    ('kiri', 'ta', V, r'きり'), ('ue-de', 'ta', V, r'上で'), ('kai-mo-naku', 'ta', V, r'かいもなく'),
    ('ka-to-omottara-ka-to-omou-to', 'ta', V, r'かと(思|おも)'),
    # ---- ない-form (未然形)
    ('nakereba-naranai-nakute-wa-ikenai', 'nai', V, r'(なければ(なら|いけ)な|なくて?は(いけ|なら)な|なくちゃ|なきゃ)'),
    ('nakute-mo-ii', 'nai', V, r'なくても(いい|よい|良|構|かま)'), ('naide-kudasai', 'nai', V, r'ないでくださ'),
    ('nai-to-ikenai-nakucha', 'nai', V, r'ないと(いけ|だめ|ダメ)'), ('zu-ni-wa-irarenai', 'nai', V, r'ずにはいられな'),
    ('zu-ni-sumu-naide-sumu', 'nai', V, r'(ずに|ないで)(済|す[むんみま])'), ('zu-ni', 'nai', V, r'ずに'),
    ('naide', 'nai', V, r'ないで'), ('zaru-o-enai', 'nai', V, r'ざるを(得|え)な'), ('zu-jimai', 'nai', V, r'ずじまい'),
    ('nai-kagiri', 'nai', V, r'ない(限り|かぎり)'), ('nai-koto-wa-nai', 'nai', V, r'ないことはな'),
    ('nai-koto-ni-wa', 'nai', V, r'ないことには'),
    # ---- other forms
    ('ba-yokatta', 'ba', VA, r'ばよかった'), ('ba-ii', 'ba', VA, r'ば(いい|よい|良い)'), ('ba-hodo', 'ba', VA, r'ば.{1,6}ほど'),
    ('ba', 'ba', VA, r'ば'), ('you-to-omou', 'vol', V, r'と(思|おも)'), ('you-to-suru', 'vol', V, r'と(す|し)'),
    ('you-de-wa-nai-ka', 'vol', V, r'ではない'), ('ou-you', 'vol', V, r''),
    ('ku-naru-ni-naru', 'ku', A, r'な[らりるれっ]'), ('ku-suru-ni-suru', 'ku', A, r'(す[るれ]|し[たてま])'),
    ('te-mo-de-mo', 'ku', A, r'ても'), ('te-reason', 'ku', A, r'て'),
    ('sugiru', 'astem', A, r'(すぎ|過ぎ)'), ('sou-da-appearance', 'astem', A, r'そう'), ('sa', 'astem', A, r'さ(?![せれ])'),
    ('garu', 'astem', A, r'が[らりるれっ]'), ('ppoi', 'astem', A, r'っぽ'),
    # ---- dictionary / plain form
    ('koto-ga-dekiru', 'dict', V, r'ことが(でき|出来)'), ('tsumori', 'dict', V, r'つもり'),
    ('koto-ni-shite-iru', 'dict', V, r'ことにして(い|る)'), ('koto-ni-suru', 'dict', V, r'ことに(す|し)'),
    ('koto-ni-natte-iru', 'dict', V, r'ことになって(い|る)'), ('koto-ni-naru', 'dict', V, r'ことにな'),
    ('koto-ga-aru', 'dict', V, r'ことが(あ|な)'), ('mae-ni', 'dict', V, r'(前|まえ)に'),
    ('tame-ni', 'dict', V, r'ため(に|の|です|だ)'), ('you-ni-suru', 'dict', V, r'ように(す|し)'),
    ('you-ni-naru', 'dict', V, r'ようにな'), ('you-ni-iu-you-ni-tanomu', 'dict', V, r'ように(言|い[うっわ]|頼|たの)'),
    ('you-ni', 'dict', V, r'ように'), ('beki-da-beki-de-wa-nai', 'dict', V, r'べき'), ('tokoro-datta', 'dict', V, r'ところだった'),
    ('tokoro-da', 'dict', V, r'ところ(だ|です)'), ('yotei', 'dict', V, r'予定'), ('ippou-da', 'dict', V, r'一方(だ|です)'),
    ('ni-tsurete', 'dict', V, r'につれ'), ('ni-shitagatte', 'dict', V, r'に(従|したが)っ'), ('osore-ga-aru', 'dict', V, r'(おそれ|恐れ)があ'),
    ('bakari-da', 'dict', V, r'ばかり(だ|です)'), ('hoka-nai', 'dict', V, r'(ほか|他)(しか)?な'), ('koto-naku', 'dict', V, r'ことなく'),
    ('made-mo-nai', 'dict', V, r'までもな'), ('ya-ina-ya', 'dict', V, r'(や否や|やいなや)'), ('beku', 'dict', V, r'べく'),
    ('wake-ni-wa-ikanai', 'dict', V, r'わけにはいかな'), ('shika-nai-no-choice', 'dict', V, r'しかな'),
    ('koto-wa-nai', 'dict', V, r'ことはな'), ('koto-da', 'dict', V, r'こと(だ|です)'), ('mono-de-wa-nai', 'dict', V, r'もので(は|も)な'),
    ('kagiri', 'dict', V, r'(限り|かぎり)'), ('tabi-ni', 'dict', V, r'(たび|度)に'), ('ni-saishite', 'dict', V, r'に際'),
    ('uchi-ni', 'dict', VA, r'うちに'), ('noni-purpose', 'dict', V, r'のに(便利|必要|使|役|いい|十分|かか)'),
    ('mono-ka', 'dict', V, r'ものか'), ('dokoro-de-wa-nai', 'dict', V, r'どころではな'),
    ('kurai-nara-gurai-nara', 'dict', V, r'(くらい|ぐらい)なら'), ('na-prohibition', 'dict', V, r'な(?=[。！!」]|$)'),
    ('to-omou', 'dict', VA, r'と(思|おも)'), ('kamo-shirenai', 'dict', VA, r'かも(しれ|知れ)'), ('darou', 'dict', VA, r'(だろう|でしょう)'),
    ('hazu-ga-nai', 'dict', VA, r'はず(が|は)な'), ('hazu-da', 'dict', VA, r'はず'), ('node', 'dict', VA, r'ので'),
    ('noni-although', 'dict', VA, r'のに'), ('nara', 'dict', VA, r'なら'), ('to', 'dict', VA, r'と[、,]'),
    ('rashii', 'dict', VA, r'らしい'), ('sou-da-hearsay', 'dict', VA, r'そう(だ|です)'), ('you-da', 'dict', VA, r'よう(だ|です|に見え)'),
    ('mitai', 'dict', VA, r'みたい'), ('n-desu-no-desu', 'dict', VA, r'(ん|の)(です|だ)'), ('ka-dou-ka', 'dict', VA, r'かどうか'),
    ('to-iu-koto-da', 'dict', VA, r'ということ(だ|です)'), ('wake-de-wa-nai', 'dict', VA, r'わけ(では|じゃ)な'),
    ('wake-ga-nai', 'dict', VA, r'わけ(が|は)な'), ('wake-da', 'dict', VA, r'わけ(だ|です)'), ('mono-da', 'dict', VA, r'もの(だ|です)'),
    ('ni-chigai-nai', 'dict', VA, r'に(違い|ちがい)な'), ('ni-kimatte-iru', 'dict', VA, r'に決まって'),
    ('ki-ga-suru', 'dict', VA, r'(気|き)がす'), ('hodo', 'dict', VA, r'ほど'), ('kurai-gurai-extent', 'dict', VA, r'(くらい|ぐらい)'),
    ('dake-de-naku', 'dict', VA, r'だけ(で|じゃ)な'), ('dake', 'dict', V, r'だけ'), ('bakari-de-naku', 'dict', VA, r'ばかりで(な|は)'),
    ('kara-koso', 'dict', VA, r'からこそ'), ('kara-ni-wa', 'dict', V, r'からには'), ('kara-to-itte', 'dict', VA, r'からといって'),
    ('kara-reason', 'dict', VA, r'から'), ('kedo-keredomo', 'dict', VA, r'(けど|けれど)'), ('shi', 'dict', VA, r'し[、,]'),
    ('toki', 'dict', VA, r'(とき|時)(に|は|、|も)'), ('aida-aida-ni', 'dict', V, r'(間|あいだ)'), ('okage-de', 'dict', VA, r'おかげ'),
    ('sei-ka', 'dict', VA, r'せいか'), ('sei-de', 'dict', VA, r'せいで'), ('to-wa-kagiranai', 'dict', VA, r'とは(限|かぎ)らな'),
    ('ni-suginai', 'dict', V, r'に(過ぎ|すぎ)な'), ('dokoro-ka', 'dict', VA, r'どころか'), ('to-iu-yori', 'dict', VA, r'というより'),
    ('wari-ni-wari-ni-wa', 'dict', VA, r'わりに'), ('kuse-ni', 'dict', VA, r'くせに'), ('furi-o-suru', 'dict', VA, r'ふり'),
    ('baai-wa', 'dict', VA, r'場合'), ('to-sureba-to-shitara', 'dict', VA, r'と(すれば|したら)'), ('to-shite-mo', 'dict', VA, r'としても'),
    ('ni-shite-wa', 'dict', V, r'にしては'), ('ni-shite-mo', 'dict', V, r'にしても'), ('ijou-wa', 'dict', V, r'以上(は|、)'),
    ('ue-ni', 'dict', VA, r'上に'), ('mono-no', 'dict', VA, r'ものの'), ('to-itte-mo', 'dict', VA, r'といっても'),
    ('ka-no-you-da', 'dict', VA, r'かのよう'), ('ni-mo-kakawarazu', 'dict', VA, r'にも(かかわ|関わ)らず'), ('to-wa-ie', 'dict', VA, r'とはいえ'),
    ('nomi-narazu', 'dict', VA, r'のみならず'), ('ni-soui-nai', 'dict', VA, r'に相違な'), ('kana-kashira', 'dict', VA, r'(かな|かしら)'),
    ('ka-embedded-question', 'dict', VA, r'か(わか|分か|知|教え|聞|き[いきくけ]|たず|尋)'),
    # ---- after a noun or な-adjective
    ('ni-tsuite', 'noun', N, r'について'), ('ni-yoru-to-ni-yoreba', 'noun', N, r'に(よると|よれば)'), ('ni-yotte-ni-yoru', 'noun', N, r'によ[っるり]'),
    ('ni-taishite', 'noun', N, r'に対(し|す)'), ('to-shite', 'noun', N, r'として'), ('ni-totte', 'noun', N, r'にとって'),
    ('ni-kanshite-ni-kansuru', 'noun', N, r'に関(し|す)'), ('ni-kurabete', 'noun', N, r'(に|と)(比べ|くらべ)'),
    ('tame-ni', 'noun', N, r'の(ため|為)(に|の|だ|です)'), ('mae-ni', 'noun', N, r'の(前|まえ)に'), ('ato-de', 'noun', N, r'の(後|あと)で'),
    ('toki', 'noun', N, r'の(時|とき)'), ('aida-aida-ni', 'noun', N, r'の(間|あいだ)に?'), ('uchi-ni', 'noun', N, r'のうちに'),
    ('okage-de', 'noun', N, r'のおかげ'), ('sei-de', 'noun', N, r'のせいで'), ('mama', 'noun', N, r'のまま'),
    ('you-na-you-ni-like', 'noun', N, r'のよう[なに]'), ('dake', 'noun', N, r'だけ'), ('bakari', 'noun', N, r'ばかり'),
    ('shika-nai', 'noun', N, r'しか'), ('sae', 'noun', N, r'(さえ|でさえ|にさえ)'), ('koso', 'noun', N, r'こそ'),
    ('nado', 'noun', N, r'など'), ('nanka-nante', 'noun', N, r'(なんか|なんて)'), ('ga-hoshii', 'noun', N, r'が(ほし|欲し)'),
    ('ga-suki-ga-kirai', 'noun', N, r'が(好き|すき|嫌い|きらい)'), ('ga-jouzu-ga-heta', 'noun', N, r'が(上手|下手|じょうず|へた)'),
    ('ku-naru-ni-naru', 'noun', N, r'にな[らりるれっ]'), ('ku-suru-ni-suru', 'noun', N, r'に(す[るれ]|し[たてま])'),
    ('o-kudasai', 'noun', N, r'をくださ'), ('ni-iku', 'noun', N, r'に(行|い[かきくけこっ])'), ('to-iu-named', 'noun', N, r'という'),
    ('kurai-gurai', 'noun', N, r'(くらい|ぐらい)'), ('goro', 'noun', N, r'(ごろ|頃)'),
    ('o-tsuujite-o-tooshite', 'noun', N, r'を通(じ|し)'), ('o-megutte', 'noun', N, r'をめぐ'), ('ni-motozuite', 'noun', N, r'に基づ'),
    ('ni-oite-ni-okeru', 'noun', N, r'にお(いて|ける)'), ('o-chuushin-ni', 'noun', N, r'を中心'), ('o-hajime', 'noun', N, r'をはじめ'),
    ('ni-kagirazu', 'noun', N, r'に(限|かぎ)らず'), ('ni-kagitte', 'noun', N, r'に(限|かぎ)って'), ('ni-tomonatte', 'noun', N, r'に伴'),
    ('ni-oujite', 'noun', N, r'に応じ'), ('ni-watatte', 'noun', N, r'にわた[っる]'), ('ni-sotte', 'noun', N, r'に沿'),
    ('ni-kuwaete', 'noun', N, r'に加え'), ('o-kikkake-ni', 'noun', N, r'をきっかけ'), ('o-nozoite', 'noun', N, r'を除'),
    ('wa-mochiron-wa-motoyori', 'noun', N, r'は(もちろん|もとより)'), ('ni-mo-kakawarazu', 'noun', N, r'にも(かかわ|関わ)らず'),
    ('ni-kakawarazu', 'noun', N, r'に(かかわ|関わ)らず'), ('o-towazu', 'noun', N, r'を問わず'), ('o-moto-ni', 'noun', N, r'を(もと|基)に'),
    ('ni-mukete', 'noun', N, r'に向け'), ('muki-muke', 'noun', N, r'向[きけ]'), ('rashii-typical-of', 'noun', N, r'らしい'),
    ('ppoi', 'noun', N, r'っぽ'), ('darake', 'noun', N, r'だらけ'), ('gimi', 'noun', N, r'気味'), ('ni-atatte', 'noun', N, r'にあた[っり]'),
    ('ni-saishite', 'noun', N, r'に際'), ('ni-sakidatte', 'noun', N, r'に先立'), ('to-tomo-ni', 'noun', N, r'と(とも|共)に'),
    ('ni-shitagatte', 'noun', N, r'に(従|したが)っ'), ('ni-tsurete', 'noun', N, r'につれ'), ('tabi-ni', 'noun', N, r'の(たび|度)に'),
    ('goto-ni', 'noun', N, r'ごとに'), ('saichuu-ni', 'noun', N, r'の最中'), ('kawari-ni', 'noun', N, r'の(代わり|かわり)に'),
    ('ni-kawatte', 'noun', N, r'に代わ'), ('toori-ni-doori-ni', 'noun', N, r'(どおり|通り|の(とおり|通り))'),
    ('ni-shite-wa', 'noun', N, r'にしては'), ('ni-shite-mo', 'noun', N, r'にしても'), ('kara-ni-kakete', 'noun', N, r'にかけて'),
    ('buri', 'noun', N, r'ぶり'), ('to-iu-no-wa', 'noun', N, r'というのは'), ('ni-suginai', 'noun', N, r'に(過ぎ|すぎ)な'),
    ('ni-kakete-wa', 'noun', N, r'にかけては'), ('no-moto-de-no-moto-ni', 'noun', N, r'のもと[でに]'), ('nuki-de-nuki-ni', 'noun', N, r'抜き'),
    ('o-komete', 'noun', N, r'を(こめ|込め)'), ('ni-tsuki', 'noun', N, r'につき'), ('ni-kotaete', 'noun', N, r'に(こたえ|応え)'),
    ('o-motte', 'noun', N, r'をもって'), ('mamire', 'noun', N, r'まみれ'), ('o-yoso-ni', 'noun', N, r'をよそに'),
    ('o-kinjienai', 'noun', N, r'を禁じ得な'), ('o-yogi-naku-sareru', 'noun', N, r'を余儀なく'), ('o-fumaete', 'noun', N, r'を踏まえ'),
    ('ni-sokushite', 'noun', N, r'に即し'), ('ni-nottotte', 'noun', N, r'に則'), ('nara-de-wa', 'noun', N, r'ならでは'),
    ('wa-oroka', 'noun', N, r'はおろか'), ('sura', 'noun', N, r'(すら|ですら)'), ('o-kawakiri-ni', 'noun', N, r'を皮切り'),
    ('o-ki-ni', 'noun', N, r'を機に'), ('ni-chigai-nai', 'noun', N, r'に(違い|ちがい)な'), ('ni-kimatte-iru', 'noun', N, r'に決まって'),
    ('kamo-shirenai', 'noun', N, r'かも(しれ|知れ)'), ('rashii', 'noun', N, r'らしい'), ('mitai', 'noun', N, r'みたい'),
    ('ga-suru', 'noun', N, r'が(する|した|します)'), ('sugiru', 'noun', N, r'(すぎ|過ぎ)'), ('sou-da-appearance', 'noun', N, r'そう(だ|です|な|に)'),
    ('sa', 'noun', N, r'さ(?![せれ])'), ('made-ni', 'noun', N, r'までに'), ('ni-yoru-to-ni-yoreba', 'noun', N, r'によると'),
    ('to-ieba-to-iu-to', 'noun', N, r'と(いえば|いうと)'), ('ni-kakawaru', 'noun', N, r'に(かかわ|関わ)る'),
    ('ga-aru-ga-iru', 'noun', N, r'が(あ[るりっ]|い[るまた]|な[いく])'), ('yori', 'noun', N, r'より'), ('zutsu', 'noun', N, r'ずつ'),
    ('ka-dou-ka', 'noun', N, r'かどうか'), ('deshou', 'noun', N, r'(でしょう|だろう)'), ('n-desu-no-desu', 'noun', N, r'な(ん|の)(です|だ)'),
    ('node', 'noun', N, r'なので'), ('noni-although', 'noun', N, r'なのに'), ('nara', 'noun', N, r'なら'),
    ('kara-reason', 'noun', N, r'(だ|です)から'), ('to-omou', 'noun', N, r'だと(思|おも)'), ('hazu-da', 'noun', N, r'のはず'),
    ('you-da', 'noun', N, r'のよう(だ|です)'), ('sou-da-hearsay', 'noun', N, r'だそう'), ('tara', 'noun', N, r'だったら'),
    ('ni-suru', 'noun', N, r'にし(ます|よう)'), ('to-iu-say', 'noun', N, r'と(言|い[うっいわ])'),
    # basic forms: counted, but shown only when nothing more specific is found
    ('masu', 'stem', V, r'ま(す|し|せ)'), ('nai', 'nai', V, r'な[いかくけ]'), ('te', 'te', V, r'[、,]?'), ('ta', 'ta', V, r'[。！？!?、]?'),
    ('desu', 'noun', N, r'(です|だ)'), ('ku-nai-katta-ku-nakatta', 'ku', A, r'な[いかく]'),
    # ---- な-adjectives only (kind D): 簡単な問題, 簡単で、
    ('na-na-adjective', 'noun', 'D', r'な(?!ので|のに|ん|ら|の|い|く|け|さ|か)'), ('kute-de', 'noun', 'D', r'で[、,]'),
]
BASIC = {'masu', 'nai', 'te', 'ta', 'desu', 'ku-nai-katta-ku-nakatta'}
RULES = collections.defaultdict(list)
CONN_OF = collections.defaultdict(set)
for gid, conn, kind, rx in R:
    CONN_OF[gid].add(conn)
    if gid not in G: print('unknown grammar id', gid, file=sys.stderr); continue
    RULES[conn].append((gid, kind, re.compile(rx)))


# ------------------------------------------------------------------ words
E = json.load(open(dict_path, encoding='utf-8'))['entries']
def hira(s): return ''.join(chr(ord(ch) - 0x60) if 'ァ' <= ch <= 'ヶ' else ch for ch in s)
IS_K = lambda ch: '一' <= ch <= '鿿' or ch == '々'
by_text, info, LV = collections.defaultdict(list), {}, {}
lemma = collections.defaultdict(set)
for e in E:
    kj = e[0].split('|') if e[0] else []; kn = e[1].split('|')
    primary = kn[0] if (e[4] or not kj) else kj[0]
    info[e[6]] = (kj, kn, primary, e[8], e[3]); LV[e[6]] = e[7] or 1
    for t in kj + kn: by_text[t].append(e[6]); lemma[t].add(e[6])

def compatible(cls, pos):
    if cls.startswith('v') and cls != 'vs': return pos == '動詞'
    if cls == 'adj-i': return pos == '形容詞'
    return pos in ('名詞', '形状詞', '副詞', '代名詞', '接続詞', '感動詞', '連体詞')
CONTENT_POS = {'名詞', '動詞', '形容詞', '形状詞', '副詞', '代名詞', '接続詞', '感動詞', '連体詞'}
def entry_for(m):
    """The dictionary entry a token is, or None when unknown or ambiguous."""
    pos = m.part_of_speech()
    if pos[0] not in CONTENT_POS or pos[1] in ('固有名詞', '数詞'): return None
    d, nf = m.dictionary_form(), m.normalized_form()
    ids = [i for i in (lemma.get(d) or lemma.get(nf) or ()) if compatible(info[i][3], pos[0])]
    if len(ids) > 1: ids = [i for i in ids if info[i][2] in (d, nf)] or ids
    if len(ids) > 1: ids = [i for i in ids if nf in info[i][0]] or ids
    return ids[0] if len(ids) == 1 else None

# ------------------------------------------------------------------ Tatoeba occurrences (its own word index)
TOKEN = re.compile(r'^(?P<head>[^\(\[\{~|]+)(?:\|\d+)?(?:\((?P<read>[^)]+)\))?(?:\[(?P<sense>\d+)\])?(?:\{(?P<form>[^}]+)\})?(?P<good>~)?$')
occ = collections.defaultdict(list)
need_j, need_e = set(), set()
with open(os.path.join(tdir, 'jpn_indices.csv'), encoding='utf-8') as f:
    for line in f:
        p = line.rstrip('\n').split('\t')
        if len(p) < 3: continue
        try: sid, mid = int(p[0]), int(p[1])
        except ValueError: continue
        for t in p[2].split(' '):
            m = TOKEN.match(t)
            if not m: continue
            head, read, form = m.group('head'), m.group('read'), m.group('form') or m.group('head')
            ids = by_text.get(head)
            if not ids: continue
            if read: ids = [i for i in ids if hira(read) in [hira(k) for k in info[i][1]]]
            if len(ids) > 1: ids = [i for i in ids if info[i][2] == head] or []
            if len(ids) != 1 or len(occ[ids[0]]) >= PER_WORD_SENTENCES: continue
            occ[ids[0]].append((sid, mid, form)); need_j.add(sid)
            if mid > 0: need_e.add(mid)

def load(name, need):
    out = {}
    with bz2.open(os.path.join(tdir, name), 'rt', encoding='utf-8') as f:
        for line in f:
            p = line.rstrip('\n').split('\t')
            if len(p) < 4: continue
            try: i = int(p[0])
            except ValueError: continue
            if i in need: out[i] = (p[2], p[3] if p[3] != '\\N' else '')
    return out
J = load('jpn_sentences_detailed.tsv.bz2', need_j)
EN = load('eng_sentences_detailed.tsv.bz2', need_e)
READ = {}
tp = os.path.join(tdir, 'jpn_transcriptions.tsv.bz2')
if os.path.exists(tp):
    def ruby(m):
        parts = m.group(1).split('|'); base, rd = parts[0], parts[1:]
        if len(rd) == len(base): return ''.join(c + ('{' + r + '}' if r else '') for c, r in zip(base, rd))
        return base + '{' + ''.join(rd) + '}'
    with bz2.open(tp, 'rt', encoding='utf-8') as f:
        for line in f:
            p = line.rstrip('\n').split('\t')
            if len(p) < 5 or p[2] != 'Hrkt': continue
            try: i = int(p[0])
            except ValueError: continue
            if i not in J or '{' in p[4]: continue
            if re.sub(r'\[([^\]|]*)\|[^\]]*\]', r'\1', p[4]) != J[i][0]: continue
            READ[i] = re.sub(r'\[([^\]]*)\]', ruby, p[4])

# ------------------------------------------------------------------ analysis helpers
tok = Dictionary().create()
CONTENT = {'名詞', '動詞', '形容詞', '副詞', '連体詞', '接続詞', '感動詞', '代名詞', '形状詞', '接頭辞'}
def phrases(ms):
    """Phrase (文節) boundaries: a content word starts a phrase; particles, endings and helper verbs join the one before."""
    cuts, prev = [0], None
    for m in ms:
        pos = m.part_of_speech()
        starts = pos[0] in CONTENT and not (prev is not None and (prev[0] == '接頭辞' or (pos[0] == '名詞' and prev[0] == '名詞')
                                                              or (pos[0] == '動詞' and pos[1] == '非自立可能' and prev[0] in ('助詞', '助動詞'))
                                                              or (pos[0] == '動詞' and prev[0] == '動詞' and prev[5].startswith('連用形'))
                                                              or (pos[0] == '動詞' and m.dictionary_form() in ('する', 'できる') and prev[0] == '名詞')
                                                              or (pos[0] == '形容詞' and pos[1] == '非自立可能')))
        if starts and m.begin() > 0 and m.begin() != cuts[-1]: cuts.append(m.begin())
        prev = pos
    return cuts

def furigana(ms):
    """The sentence with the reading of each kanji in braces: 学{がっ}校{こう}へ行{い}く."""
    out = []
    for m in ms:
        s = m.surface()
        if not any(IS_K(ch) for ch in s):
            out.append(s); continue
        rd = hira(m.reading_form())
        runs = re.findall(r'[一-鿿々]+|[^一-鿿々]+', s)
        pat = '^' + ''.join('(.+)' if IS_K(r[0]) else re.escape(hira(r)) for r in runs) + '$'
        mm = re.match(pat, rd)
        groups = list(mm.groups()) if mm else None
        if not groups and len([r for r in runs if IS_K(r[0])]) == 1:
            groups = None
        piece, gi = [], 0
        for r in runs:
            if not IS_K(r[0]): piece.append(r); continue
            rr = groups[gi] if groups else (rd if len(runs) == 1 else None); gi += 1
            if not rr or len(rr) < len(r): piece.append(r); continue
            # spread the run's reading over its kanji; the page joins them back into one reading
            n, L = len(r), len(rr); cut = [round(L * i / n) for i in range(n + 1)]
            piece.append(''.join(r[i] + '{' + rr[cut[i]:cut[i + 1]] + '}' for i in range(n)))
        out.append(''.join(piece))
    return ''.join(out)

def form_of(ms, k):
    """The word as written in the sentence, with the endings that belong to it (食べて, 勉強した)."""
    j, s = k, ms[k].surface()
    if j + 1 < len(ms) and ms[j + 1].dictionary_form() == 'する' and ms[k].part_of_speech()[0] == '名詞':
        j += 1; s += ms[j].surface()
    while j + 1 < len(ms) and len(s) < 12:
        n = ms[j + 1]; p = n.part_of_speech()
        if (p[0] == '助詞' and n.surface() in ('て', 'で')) or (p[0] == '助動詞' and n.dictionary_form() not in ('です', 'だ')):
            j += 1; s += n.surface()
        else: break
    return s

# ---- particles after a noun: which particle, in which use, and the verb (or adjective) it goes with: 写真を撮る, 頭が痛い, 駅に着く
PARTICLES = {'o', 'ga-subject', 'ni-time', 'ni-destination', 'ni-location', 'ni-indirect-object', 'de-place', 'de-means',
             'to-with', 'kara-from', 'made', 'e', 'yori'}
MOTION = set('行く 来る 帰る 入る 着く 戻る 出かける 向かう 乗る 上る 登る 移る 通う 出る 集まる 近づく 引っ越す 届く 寄る 降りる 落ちる 参る いらっしゃる'.split())
EXIST = set('ある いる 住む 泊まる 勤める 残る 並ぶ おる いらっしゃる 存在する 位置する 滞在する'.split())
GIVE = set('あげる くれる もらう やる 言う 話す 聞く 教える 送る 見せる 貸す 借りる 会う 頼む 渡す 答える 伝える 習う 返す 売る 尋ねる 訊く '
           '質問する 電話する 紹介する 相談する 連絡する 説明する 報告する 手紙 差し上げる いただく くださる 申し上げる 謝る 感謝する'.split())
MEANS_V = set('書く 作る 切る 払う 話す 言う 撮る 洗う 調べる 運ぶ 送る 描く 拭く 包む 食べる 飲む 見る 聞く 読む 打つ 測る 計る 結ぶ 直す 開ける 呼ぶ 決める'.split())
WITH_V = set('話す 会う 遊ぶ 行く 来る 働く 住む 食べる 飲む 別れる 戦う 踊る 帰る 結婚する 喧嘩する 相談する 旅行する 勉強する 一緒 話し合う 約束する 付き合う 比べる 違う 同じ 似る'.split())
PLACE_END = re.compile(r'(場|館|室|店|所|屋|校|園|港|駅|国|町|市|村|県|区|家|庭|院|社|堂|局|署|階|部屋|内|外|中|前|後ろ|上|下|側|横|隣|近く|会場|現場|地|界|空|海|山|川|道|通り|東京|日本|大学|学校|会社|教室|病院|公園|図書館|銀行|郵便局|食堂|台所)$')
def collocate(ms, i, adjectives=False):
    """The verb (or, after が and より, adjective) that the particle at token i leads to: only adverbs may come in between,
    so 先生を見送りに行く gives nothing rather than 先生を行く. A noun + する counts as one verb (日本語を勉強する)."""
    for j in range(i + 1, min(len(ms), i + 5)):
        m = ms[j]; p = m.part_of_speech()
        if p[0] == '動詞' or (adjectives and p[0] in ('形容詞', '形状詞')):
            if p[0] == '動詞' and p[1] == '非自立可能' and j > i + 1: return None, None
            return m.dictionary_form(), j
        if p[0] == '副詞' or (p[0] == '名詞' and p[2] == '副詞可能' and j + 1 < len(ms) and ms[j + 1].part_of_speech()[0] != '助詞'): continue
        if p[0] == '名詞' and j + 1 < len(ms) and ms[j + 1].dictionary_form() in ('する', '為る') and ms[j + 1].part_of_speech()[0] == '動詞':
            return m.surface() + 'する', j + 1
        return None, None
    return None, None
CASE_P = ('を', 'が', 'に', 'で', 'へ', 'と', 'から', 'より')
pv = collections.Counter()          # (case particle, verb) -> times seen right before that verb, over all nouns
pv_total = collections.Counter()    # verb -> times seen after a noun and a case particle
noun_pv = collections.defaultdict(set)   # word -> {(particle, verb)} it was seen with
def particle_point(ms, k, nxt, eid=None):
    w, s, p = ms[k], nxt.surface(), nxt.part_of_speech()
    lem, j = collocate(ms, k + 1, adjectives=s in ('が', 'より'))
    if not lem: return None
    if s in CASE_P and p[1] == '格助詞':
        pv[(s, lem)] += 1; pv_total[lem] += 1
        if eid is not None: noun_pv[eid].add((s, lem))
    gid = None
    if s == 'を' and p[1] == '格助詞': gid = 'o'
    elif s == 'が' and p[1] == '格助詞': gid = 'ga-subject'
    elif s == 'に' and p[1] == '格助詞':
        if w.part_of_speech()[2] == '副詞可能' or re.search(r'[時日月年曜]$', w.surface()): gid = 'ni-time'
        elif lem in EXIST: gid = 'ni-location'
        elif lem in MOTION: gid = 'ni-destination'
        elif lem in GIVE: gid = 'ni-indirect-object'
    elif s == 'で' and p[1] == '格助詞':
        place = bool(PLACE_END.search(w.surface()))
        if place and lem not in ('ある', 'いる', 'なる'): gid = 'de-place'
        elif not place and (lem in MOTION or lem in MEANS_V): gid = 'de-means'
    elif s == 'と' and p[1] == '格助詞' and lem in WITH_V: gid = 'to-with'
    elif s == 'から' and p[1] == '格助詞': gid = 'kara-from'
    elif s == 'まで' and p[0] == '助詞': gid = 'made'
    elif s == 'へ' and p[1] == '格助詞': gid = 'e'
    elif s == 'より' and p[1] == '格助詞': gid = 'yori'
    if not gid or gid not in G: return None
    return (gid, nxt.begin(), ms[j].end(), lem, s, j - k - 2)     # grammar span runs from the particle to the verb; gap = words in between

# ---- grammar an adverb (or a time word used as one) sets up later in its sentence: 決して〜ない, たぶん〜でしょう, ぜひ〜てください
NEG = r'(ない|ません|なかった|ず(?=[、。にとも])|ぬ)'
FRAMES = [('naide-kudasai', r'ないで(ください|下さい)'), ('te-kudasai', r'[てで](ください|下さい)'), ('nakereba-naranai-nakute-wa-ikenai', r'な(ければ|くては|くちゃ)'),
          ('nai', NEG), ('deshou', r'でしょう'), ('darou', r'だろう'), ('kamo-shirenai', r'かも(しれ|知れ)'), ('ni-chigai-nai', r'に(違|ちが)いな'),
          ('hazu-da', r'はず'), ('you-da', r'よう(だ|です|な|に)'), ('mitai', r'みたい'), ('rashii', r'らしい'), ('tai', r'(たい|たく|たかっ)'),
          ('te-hoshii', r'[てで](ほしい|欲しい)'), ('tara', r'[たで]ら'), ('ba', r'[えけげせてねべめれ]ば'), ('te-mo-de-mo', r'[てで]も'),
          ('to-omou', r'と(思|おも)'), ('mashou', r'ましょう'), ('te-iru', r'[てで](い|お)(る|ます|た|ない)'), ('tsumori', r'つもり'), ('yotei', r'予定')]
FRAMES = [(g, re.compile(rx)) for g, rx in FRAMES if g in G]
OWN_FRAMES = {   # adverbs with a grammar point of their own
    'まだ': [('mada-te-inai', r'[てで]い?(ない|なかった|ません)')], '未だ': [('mada-te-inai', r'[てで]い?(ない|なかった|ません)')],
    'もう': [('mou-ta', r'(た|だ|ました)(よ|ね|か)?$')], 'あまり': [('amari-nai', NEG)], '余り': [('amari-nai', NEG)],
    '全然': [('zenzen-nai', NEG)], 'ぜんぜん': [('zenzen-nai', NEG)], 'なかなか': [('nakanaka-nai', NEG)], '中々': [('nakanaka-nai', NEG)],
    'まるで': [('marude-you-da', r'(よう|みたい)')], 'たとえ': [('tatoe-te-mo', r'[てで]も')], '例え': [('tatoe-te-mo', r'[てで]も')]}
OWN_FRAMES = {w: [(g, re.compile(rx)) for g, rx in fr if g in G] for w, fr in OWN_FRAMES.items()}
def frames_after(sentence, ms, k):
    """Frames found between the word and the end of its sentence; a match must start where a word starts (少ない is not ない)."""
    end = ms[k].end()
    stop = re.search(r'[。！？!?]', sentence[end:])
    rest_end = end + (stop.start() if stop else len(sentence) - end)
    rest = sentence[end:rest_end]
    starts = {m.begin() for m in ms}
    out, seen = [], set()
    own = OWN_FRAMES.get(ms[k].surface()) or OWN_FRAMES.get(ms[k].dictionary_form()) or []
    for gid, rx in own + FRAMES:
        if gid in seen: continue
        for m in rx.finditer(rest):
            gs = end + m.start()
            if gs not in starts: continue
            ge = end + m.end()
            j = next((i for i, t in enumerate(ms) if t.begin() < ge <= t.end()), None)
            out.append((gid, gs, ms[j].end() if j is not None else ge, 'frame')); seen.add(gid)
            if own and gid == own[0][0]: seen.add('nai'); seen.add('te-iru'); seen.add('you-da'); seen.add('mitai'); seen.add('te-mo-de-mo')
            break
    return out

def analyse_at(sentence, ms, k, word_cls, eid=None):
    """Grammar right after token k: [(grammar id, start, end)], and where the word ends."""
    w = ms[k]
    verbish = word_cls.startswith('v') or word_cls == 'vs'
    if word_cls == 'vs' and k + 1 < len(ms) and ms[k + 1].dictionary_form() == 'する':
        k += 1; w = ms[k]; kind = V
    elif w.part_of_speech()[0] == '動詞' and verbish: kind = V
    elif w.part_of_speech()[0] == '形容詞' and word_cls == 'adj-i': kind = A
    elif w.part_of_speech()[0] == '形状詞' and word_cls == 'adj-na': kind = 'D'
    elif w.part_of_speech()[0] in ('名詞', '形状詞', '副詞', '代名詞') and not word_cls.startswith('v') and word_cls != 'adj-i': kind = 'N'
    else: return None
    p0 = w.part_of_speech()
    nx = ms[k + 1] if k + 1 < len(ms) else None
    if p0[0] == '副詞' or (p0[0] == '名詞' and p0[2] == '副詞可能' and (nx is None or nx.part_of_speech()[0] not in ('助詞', '助動詞'))):
        return w.end(), frames_after(sentence, ms, k), True
    end, cf = w.end(), w.part_of_speech()[5]
    nxt = ms[k + 1] if k + 1 < len(ms) else None
    conn = None
    if kind in ('N', 'D'): conn = 'noun'
    elif kind == A:
        if cf.startswith('連用形-一般'): conn = 'ku'
        elif cf.startswith('語幹'): conn = 'astem'
        elif cf.startswith('仮定形'): conn = 'ba'
        elif cf.startswith('連用形-促音便') and nxt and nxt.dictionary_form() == 'た': conn, end = 'ta', end + 1
        elif cf.startswith(('終止形', '連体形')): conn = 'dict'
    else:
        if cf.startswith('連用形'):
            if nxt and nxt.surface() in ('て', 'で') and nxt.part_of_speech()[0] == '助詞': conn, end = 'te', end + 1
            elif nxt and nxt.dictionary_form() == 'た' and nxt.part_of_speech()[0] == '助動詞': conn, end = 'ta', end + 1
            else: conn = 'stem'
        elif cf.startswith(('終止形', '連体形')): conn = 'dict'
        elif cf.startswith('未然形'): conn = 'nai'
        elif cf.startswith('仮定形'): conn = 'ba'
        elif cf.startswith('意志推量形'): conn = 'vol'
    if not conn: return None
    word_end, rest, found = w.end(), sentence[end:], []
    for gid, kinds, rx in RULES[conn]:
        if kind not in kinds: continue
        m = rx.match(rest)
        if m and (m.end() > 0 or gid == 'ou-you'):
            ge = end + m.end()
            if m.end() > 0:
                j = next((i for i, t in enumerate(ms) if t.begin() < ge <= t.end()), None)
                if j is not None:
                    ge = ms[j].end()
                    while j + 1 < len(ms) and ms[j + 1].part_of_speech()[0] == '助動詞' and ms[j + 1].dictionary_form() not in ('です', 'だ'):
                        j += 1; ge = ms[j].end()
            found.append((gid, end, ge))
            break
    if not found and kind == 'N' and w.part_of_speech()[0] in ('名詞', '代名詞') and nxt is not None and nxt.part_of_speech()[0] == '助詞':
        p = particle_point(ms, k, nxt, eid)     # no grammar pattern: the particle and the verb it leads to
        if p: found.append(p)
    return word_end, found

BAD = re.compile(r'[A-Za-zＡ-Ｚａ-ｚ（）()\[\]【】＜＞<>{}｛｝♪＊*#＃/／=＝|｜~～…“”"]')
def difficulty(ents, eid):
    """How much harder than the word's own level the other words of the sentence are."""
    lv, pen = LV[eid], 0
    for o in ents:
        if o is None or o == eid: continue
        if LV[o] < lv: pen += lv - LV[o]
    return pen

# ------------------------------------------------------------------ the existing Tatoeba examples
ex_dir = os.path.join(out_dir, 'ex')
EX = {}
for i in range(SHARDS):
    p = os.path.join(ex_dir, '%02d.json' % i)
    if os.path.exists(p):
        for k, v in json.load(open(p, encoding='utf-8')).items():
            EX[int(k)] = [r[:6] + ['t'] if len(r) < 7 else r for r in v]

# ------------------------------------------------------------------ counting
counts = collections.defaultdict(collections.Counter)
total = collections.Counter()
best = {}                                   # (word, grammar) -> (score, row)
side = collections.defaultdict(list)                  # word -> grammar found elsewhere in its sentences (for practice only)
coll = collections.defaultdict(collections.Counter)   # (word, particle point) -> verbs it goes with
frame_n = collections.defaultdict(collections.Counter)  # adverb -> frames after it
frame_total, frame_global, frame_sentences = collections.Counter(), collections.Counter(), [0]
coll_best, coll_n = {}, collections.Counter()         # (word, point, verb) -> best sentence; how many verbs have one
surf = collections.defaultdict(collections.Counter)
global_n = collections.Counter(); global_total = 0
cands = collections.defaultdict(list)       # word -> [(score, row)] extra example sentences
seen_sent = collections.defaultdict(set)

def record(eid, sentence, ms, k, en, sid, src, title, base_score):
    """Count the grammar after token k and keep the sentence as a grammar or word example when it is a good one."""
    global global_total
    cls = info[eid][3]
    r = analyse_at(sentence, ms, k, cls, eid)
    n = len(sentence)
    ws = ms[k].begin()
    if r:
        word_end, found = r[0], r[1]
        total[eid] += 1; global_total += 1
        if len(r) > 2: frame_total[eid] += 1; frame_sentences[0] += 1
        for f in found:
            gid, gs, ge = f[:3]
            counts[eid][gid] += 1; global_n[gid] += 1
            key = (eid, gid)
            if len(f) == 4 and f[3] == 'frame':          # an adverb frame: judged against other adverbs, not against all words
                counts[eid][gid] -= 1; global_n[gid] -= 1
                frame_n[eid][gid] += 1; frame_global[gid] += 1
                if key not in best or base_score < best[key][0]:
                    furi = READ.get(sid, sentence) if src == 't' else furigana(ms)
                    best[key] = (base_score, [furi, en, sid, ws, word_end, gs, ge, phrases(ms), src, title])
                continue
            if len(f) > 3:                              # a particle: count the verb it goes with, keep a light example per verb
                lem, part, gap = f[3], f[4], f[5]
                surf[gid][part] += 1
                coll[key][lem] += 1
                ck, sc = (eid, gid, lem), base_score + 6 * gap
                if (ck in coll_best and sc < coll_best[ck][0]) or (ck not in coll_best and coll_n[key] < 10):
                    if ck not in coll_best: coll_n[key] += 1
                    coll_best[ck] = (sc, sentence, en, sid, src, title, ws, word_end, gs, ge)
                continue
            surf[gid][sentence[gs:ge] if ge > gs else '（意志形）'] += 1
            if key not in best or base_score < best[key][0]:
                furi = READ.get(sid, sentence) if src == 't' else furigana(ms)
                best[key] = (base_score, [furi, en, sid, ws, word_end, gs, ge, phrases(ms), src, title])
    if (len(side[eid]) < 2 or (en and not all(r[1][1] for r in side[eid]))) and n <= 40:
        # a grammar point elsewhere in a sentence with this word: used only for a practice question when the word has none of its own
        for j, m in enumerate(ms):
            if j == k or m.part_of_speech()[0] not in ('動詞', '形容詞') or m.part_of_speech()[1] == '非自立可能': continue
            rr = analyse_at(sentence, ms, j, 'v5r' if m.part_of_speech()[0] == '動詞' else 'adj-i')
            hit = next((f for f in (rr[1] if rr else []) if len(f) == 3 and f[0] not in BASIC and f[2] > f[1]), None)
            if hit:
                furi = READ.get(sid, sentence) if src == 't' else furigana(ms)
                row = [hit[0], [furi, en, sid, ws, ms[k].end(), hit[1], hit[2], phrases(ms), src, title]]
                if len(side[eid]) >= 2: side[eid] = [r for r in side[eid] if r[1][1]] + [row]   # a translated sentence replaces one without
                else: side[eid].append(row)
                side[eid] = side[eid][:2]
                break
    have = len(EX.get(eid, ()))
    if src != 't' and have < PER_WORD_EXAMPLES and sentence not in seen_sent[eid]:
        lst = cands[eid]
        if len(lst) < 12 or base_score < max(s for s, _ in lst):
            seen_sent[eid].add(sentence)
            row = [furigana(ms), en, sid, title, form_of(ms, k), phrases(ms), src]
            lst.append((base_score, row)); lst.sort(key=lambda x: x[0]); del lst[12:]

# Tatoeba
for eid, lst in occ.items():
    for sid, mid, form in lst:
        if sid not in J: continue
        ja = J[sid][0]
        at = ja.find(form)
        if at < 0: continue
        ms = list(tok.tokenize(ja, SplitMode.C))
        k = next((i for i, m in enumerate(ms) if m.begin() == at), None)
        if k is None: continue
        en = EN.get(mid, ('', ''))[0]
        n = len(ja)
        good = (8 <= n <= 40) and en and not BAD.search(ja)
        record(eid, ja, ms, k, en, sid, 't', '', (0 if good else 100) + abs(n - 20) + (0 if sid in READ else 30))
print('Tatoeba done: words', len(occ), 'sentences', global_total, file=sys.stderr, flush=True)

def complete(ms):
    """A whole sentence, not a fragment: it has a predicate and does not stop on a case particle or a conjunction."""
    toks = [m for m in ms if m.part_of_speech()[0] not in ('補助記号', '空白')]
    if len(toks) < 3: return False
    p = toks[-1].part_of_speech()
    if (p[0] == '助詞' and p[1] != '終助詞') or p[0] in ('接頭辞', '連体詞', '接続詞'): return False
    return any(m.part_of_speech()[0] in ('動詞', '形容詞', '助動詞') for m in toks)
FRAGMENT_EN = re.compile(r"^(and|or|but|so|that|which|who|who's|whom|whose|where|when|while|because|than|to|of|for|with|over|into|from|at|in|on|as|if|then|by|about|like)\b", re.I)

def scan(sentence, en, sid, src, title, base):
    ms = list(tok.tokenize(sentence, SplitMode.C))
    if not complete(ms): return False
    if src == 'j' and (FRAGMENT_EN.match(en) or not (0.7 <= len(en) / max(1, len(sentence)) <= 6)): return False
    ents = [entry_for(m) for m in ms]
    hit = False
    for k, eid in enumerate(ents):
        if eid is None or total[eid] >= PER_WORD_SENTENCES: continue
        if len(EX.get(eid, ())) >= PER_WORD_EXAMPLES and total[eid] >= 60: continue
        score = base + abs(len(sentence) - 20) + 4 * difficulty(ents, eid)
        record(eid, sentence, ms, k, en, sid, src, title, score)
        hit = True
    return hit

# JESC: everyday spoken Japanese with English
import pyarrow.parquet as pq
t = pq.read_table(jesc_path)
pairs = t.column('translation').to_pylist()
nj = 0
for i, p in enumerate(pairs):
    ja, en = (p.get('ja') or '').strip(), (p.get('en') or '').strip()
    if not (5 <= len(ja) <= 40) or BAD.search(ja) or not (3 <= len(en) <= 120) or '{' in ja: continue
    en = en[0].upper() + en[1:]
    scan(ja, en, 'j%d' % i, 'j', '', 5); nj += 1
print('JESC done: sentences', nj, file=sys.stderr, flush=True)

# Wikipedia: written Japanese, no translation
nw = 0
for path in [p for p in wiki_paths.split(',') if p]:
    pf = pq.ParquetFile(path)
    for batch in pf.iter_batches(batch_size=500, columns=['id', 'title', 'text']):
        for aid, title, text in zip(batch.column('id').to_pylist(), batch.column('title').to_pylist(), batch.column('text').to_pylist()):
            for para in text.split('\n'):
                for s in para.split('。'):
                    s = s.strip()
                    if not (10 <= len(s) <= 46) or BAD.search(s) or re.search(r'[0-9０-９]{3,}', s) or s.count('「') != s.count('」'): continue
                    if s.count('・') >= 2 or re.search(r' - |→|%|％|：|:|、、', s): continue
                    scan(s + '。', '', 'w' + str(aid), 'w', title, 15); nw += 1
            if nw >= WIKI_SENTENCES: break
        if nw >= WIKI_SENTENCES: break
    if nw >= WIKI_SENTENCES: break
print('Wikipedia done: sentences', nw, file=sys.stderr, flush=True)

# ------------------------------------------------------------------ examples: top up, and make one where no corpus has the word
STEM = {'u': 'い', 'k': 'き', 'g': 'ぎ', 's': 'し', 't': 'ち', 'n': 'に', 'b': 'び', 'm': 'み', 'r': 'り'}
def masu(w, cls):
    if cls == 'v1': return w[:-1] + 'ます'
    if cls.startswith('v5') and len(cls) == 3: return w[:-1] + STEM.get(cls[2], 'い') + 'ます'
    if w.endswith('来る') or w.endswith('くる'): return w[:-2] + ('来' if w.endswith('来る') else 'き') + 'ます'
    if w.endswith('する'): return w[:-2] + 'します'
    if w.endswith('行く') or w.endswith('いく'): return w[:-1] + 'きます'
    return None
def made_sentence(e):
    kj, kn, w, cls, pos = info[e]
    if cls.startswith('v') and cls != 'vs':
        m = masu(w, cls)
        return 'きのう、' + m[:-2] + 'ました。' if m else None
    if cls == 'vs': return '来週、' + w + 'する予定です。'
    if cls == 'adj-i': return 'それはとても' + w + 'です。'
    if cls == 'adj-na': return 'それはとても' + w + 'です。'
    if pos in ('noun', 'noun, suru verb', 'pronoun', 'number', 'counter'): return w + 'について調べました。'
    return '「' + w + '」という言葉を習いました。'

added = made = 0
for e in E:
    eid = e[6]
    rows = EX.get(eid, [])
    if len(rows) < PER_WORD_EXAMPLES:
        for score, row in cands.get(eid, []):
            if len(rows) >= PER_WORD_EXAMPLES: break
            rows.append(row); added += 1
    if not rows:
        s = made_sentence(eid)
        if s:
            ms = list(tok.tokenize(s, SplitMode.C))
            w = info[eid][2]
            at = s.find(w)
            form = w
            if at < 0 and info[eid][3].startswith('v'):
                form = masu(w, info[eid][3])[:-2] + 'ました'; at = s.find(form)
            rows = [[furigana(ms), '', 'm', '', form, phrases(ms), 'm']]; made += 1
    if rows: EX[eid] = rows

shards = [dict() for _ in range(SHARDS)]
for eid, rows in EX.items(): shards[eid % SHARDS][str(eid)] = rows
size = 0
for i, sh in enumerate(shards):
    p = os.path.join(ex_dir, '%02d.json' % i)
    json.dump(sh, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':')); size += os.path.getsize(p)
print('examples: words', len(EX), 'of', len(E), '| added from JESC and Wikipedia', added, '| made', made, '| bytes', size, file=sys.stderr)
srcs = collections.Counter(r[6] for rows in EX.values() for r in rows)
print('example sources', dict(srcs), file=sys.stderr)

# ------------------------------------------------------------------ grammar per word: only patterns this word is really used with
for gid, c in surf.items():
    G[gid][4] = c.most_common(1)[0][0]
for gid in PARTICLES: CONN_OF[gid].add("noun")
for gid in G: G[gid].append(sorted(CONN_OF.get(gid, ())))
def particle_row(eid, g):
    """The example for a particle point: a sentence with the verb this word most often takes with it, and that verb."""
    key = (eid, g)
    for lem, cn in coll[key].most_common():
        t = coll_best.get((eid, g, lem))
        if not t: continue
        sc, sentence, en, sid, src, title, ws, we, gs, ge = t
        ms = list(tok.tokenize(sentence, SplitMode.C))
        furi = READ.get(sid, sentence) if src == 't' else furigana(ms)
        part = sentence[gs:gs + 2] if sentence[gs:gs + 2] in ('から', 'より', 'まで') else sentence[gs]
        # wrong choices for a particle blank: case particles almost never seen before this verb, and never with this word
        wrong = [q for q in CASE_P if q != part and (q, lem) not in noun_pv[eid] and pv_total[lem] >= 30 and pv[(q, lem)] / pv_total[lem] < 0.01]
        return [furi, en, sid, ws, we, gs, ge, phrases(ms), src, title], lem, cn, wrong
    return None
shards = [dict() for _ in range(SHARDS)]
nwords = 0
for eid in set(counts) | set(frame_n):
    c = counts[eid]
    rate = {g: global_n[g] / max(1, global_total) for g in c}
    floor = 1 if total[eid] <= 5 else max(2, math.ceil(total[eid] * 0.03))
    ranked = sorted(((g, n) for g, n in c.items() if g not in BASIC and n > 0), key=lambda kv: -(kv[1] / (max(rate[kv[0]], 1e-9) ** 0.15)))
    pfloor = 1 if total[eid] <= 5 else max(2, math.ceil(total[eid] * 0.015))      # particle + verb pairs are spread over many verbs
    keep = [(g, n) for g, n in ranked if n >= (pfloor if g in PARTICLES else floor)][:PER_WORD_POINTS]
    if frame_total[eid] >= 3:                    # adverbs: frames much more common after this word than after adverbs in general
        ft = frame_total[eid]
        fk = [(g, n) for g, n in frame_n[eid].most_common() if n >= 2 and n / ft >= 0.15 and n / ft >= 2 * frame_global[g] / max(1, frame_sentences[0])]
        keep = fk[:PER_WORD_POINTS] + keep[:max(0, PER_WORD_POINTS - len(fk))]
    if not keep: continue
    rows = []
    for g, n in keep:
        if g in PARTICLES:
            row = particle_row(eid, g)
            if row: rows.append([g, n, total[eid], row[0], row[1], row[2], row[3]])
        elif (eid, g) in best: rows.append([g, n, total[eid], best[(eid, g)][1]])
    if not rows: continue
    shards[eid % SHARDS][str(eid)] = rows; nwords += 1
nside = 0
for eid, lst in side.items():                 # grammar elsewhere in the word's sentences: rows with count 0, for practice only
    if not lst: continue
    have = shards[eid % SHARDS].get(str(eid))
    if have: have.append([lst[0][0], 0, total[eid], lst[0][1]])
    else: shards[eid % SHARDS][str(eid)] = [[g, 0, total[eid], row] for g, row in lst]; nside += 1
print('words with practice-only grammar rows', nside, file=sys.stderr)
os.makedirs(os.path.join(out_dir, 'gr'), exist_ok=True)
size = 0
for i, sh in enumerate(shards):
    p = os.path.join(out_dir, 'gr', '%02d.json' % i)
    json.dump(sh, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':')); size += os.path.getsize(p)
json.dump({'source': 'Grammar points, levels and English meanings: OpenJLPT (CC BY-SA 4.0); usage counted in Tatoeba (CC BY 2.0 FR), '
           'JESC subtitles and Japanese Wikipedia (CC BY-SA)',
           'fields': ['pattern', 'level', 'meaning', 'formation', 'surface', 'attaches'], 'points': G,
           'particles': sorted(PARTICLES)},
          open(os.path.join(out_dir, 'grammar.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('words with grammar', nwords, '| sentences analysed', global_total, '| shard bytes', size, file=sys.stderr)
