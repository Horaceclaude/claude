"""Find which grammar patterns each word is used with, from every Tatoeba sentence that contains it.

Inputs
  data/dict.json              the site's word list
  GRAMMAR_DIR                 data/csv of https://github.com/evanclan/OpenJLPT (grammar-n1.csv .. grammar-n5.csv, CC BY-SA 4.0)
  TATOEBA_DIR                 jpn_indices.csv, jpn_sentences_detailed.tsv.bz2, eng_sentences_detailed.tsv.bz2,
                              jpn_transcriptions.tsv.bz2 (https://downloads.tatoeba.org/exports/, CC BY 2.0 FR)
Needs: pip install sudachipy sudachidict_core

Usage: python3 tools/build_grammar.py data/dict.json GRAMMAR_DIR TATOEBA_DIR data

Writes
  data/grammar.json   grammar points: id -> [pattern, level, meaning, formation, most common surface, how it attaches]
  data/gr/00..63.json per word (JMdict id): [[grammar id, sentences with it, sentences looked at,
                      [sentence with readings in braces, English, Tatoeba id, word start, word end,
                       grammar start, grammar end, phrase boundaries]], ...]
"""
import sys, os, re, csv, bz2, json, collections, math
from sudachipy import Dictionary, SplitMode

dict_path, grammar_dir, tdir, out_dir = sys.argv[1:5]
SHARDS, PER_WORD_SENTENCES, PER_WORD_POINTS = 64, 400, 5

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
V, A, N, VA = 'V', 'A', 'N', 'VA'
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
]
BASIC = {'masu', 'nai', 'te', 'ta', 'desu', 'ku-nai-katta-ku-nakatta'}
RULES = collections.defaultdict(list)
CONN_OF = collections.defaultdict(set)
for gid, conn, kind, rx in R:
    CONN_OF[gid].add(conn)
    if gid not in G: print('unknown grammar id', gid, file=sys.stderr); continue
    RULES[conn].append((gid, kind, re.compile(rx)))

# ------------------------------------------------------------------ words and sentences
E = json.load(open(dict_path, encoding='utf-8'))['entries']
def hira(s): return ''.join(chr(ord(ch) - 0x60) if 'ァ' <= ch <= 'ヶ' else ch for ch in s)
by_text, info = collections.defaultdict(list), {}
for e in E:
    kj = e[0].split('|') if e[0] else []; kn = e[1].split('|')
    primary = kn[0] if (e[4] or not kj) else kj[0]
    info[e[6]] = (kj, kn, primary, e[8])
    for t in kj + kn: by_text[t].append(e[6])
TOKEN = re.compile(r'^(?P<head>[^\(\[\{~|]+)(?:\|\d+)?(?:\((?P<read>[^)]+)\))?(?:\[(?P<sense>\d+)\])?(?:\{(?P<form>[^}]+)\})?(?P<good>~)?$')
occ = collections.defaultdict(list)          # entry id -> [(sentence id, english id, form)]
need_j, need_e = set(), set()
with open(os.path.join(tdir, 'jpn_indices.csv'), encoding='utf-8') as f:
    for line in f:
        p = line.rstrip('\n').split('\t')
        if len(p) < 3: continue
        try: sid, mid = int(p[0]), int(p[1])
        except ValueError: continue
        for tok in p[2].split(' '):
            m = TOKEN.match(tok)
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

# ------------------------------------------------------------------ analyse
tok = Dictionary().create()
CONTENT = {'名詞', '動詞', '形容詞', '副詞', '連体詞', '接続詞', '感動詞', '代名詞', '形状詞', '接頭辞'}
def phrases(ms):
    """Phrase (文節) boundaries: a content word starts a phrase; particles, endings and helper verbs join the one before."""
    cuts, prev = [0], None
    for m in ms:
        pos = m.part_of_speech()
        starts = pos[0] in CONTENT and not (prev is not None and (prev[0] == '接頭辞' or (pos[0] == '名詞' and prev[0] == '名詞')
                                                              or (pos[0] == '動詞' and pos[1] == '非自立可能' and prev[0] in ('助詞', '助動詞'))
                                                              or (pos[0] == '動詞' and prev[0] == '動詞' and prev[5].startswith('連用形'))   # 食べ終わる
                                                              or (pos[0] == '動詞' and m.dictionary_form() in ('する', 'できる') and prev[0] == '名詞')  # 勉強する
                                                              or (pos[0] == '形容詞' and pos[1] == '非自立可能')))
        if starts and m.begin() > 0 and m.begin() != cuts[-1]: cuts.append(m.begin())
        prev = pos
    return cuts

def analyse(sentence, form, word_cls):
    at = sentence.find(form)
    if at < 0: return None
    ms = list(tok.tokenize(sentence, SplitMode.C))
    k = next((i for i, m in enumerate(ms) if m.begin() == at), None)
    if k is None: return None
    w = ms[k]
    verbish = word_cls.startswith('v') or word_cls == 'vs'
    if word_cls == 'vs' and k + 1 < len(ms) and ms[k + 1].dictionary_form() == 'する':
        k += 1; w = ms[k]; kind = V
    elif w.part_of_speech()[0] == '動詞' and verbish: kind = V
    elif w.part_of_speech()[0] == '形容詞' and word_cls == 'adj-i': kind = A
    elif w.part_of_speech()[0] in ('名詞', '形状詞', '副詞', '代名詞') and not word_cls.startswith('v') and word_cls != 'adj-i': kind = N
    else: return None
    end, cf = w.end(), w.part_of_speech()[5]
    nxt = ms[k + 1] if k + 1 < len(ms) else None
    conn = None
    if kind == N: conn = 'noun'
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
    word_end = w.end()
    rest = sentence[end:]
    found = []
    for gid, kinds, rx in RULES[conn]:
        if kind not in kinds: continue
        m = rx.match(rest)
        if m and (m.end() > 0 or gid == 'ou-you'):
            ge = end + m.end()
            if m.end() > 0:                                  # finish the word the match stops in (ことがあ -> ことがある), plus helper endings
                j = next((i for i, t in enumerate(ms) if t.begin() < ge <= t.end()), None)
                if j is not None:
                    ge = ms[j].end()
                    while j + 1 < len(ms) and ms[j + 1].part_of_speech()[0] == '助動詞' and ms[j + 1].dictionary_form() not in ('です', 'だ'):
                        j += 1; ge = ms[j].end()
            found.append((gid, end, ge))
            break                                            # one pattern per word occurrence: the most specific listed first
    return at, word_end, ms, found

counts = collections.defaultdict(collections.Counter)
total = collections.Counter()
best = {}
surf = collections.defaultdict(collections.Counter)
global_n = collections.Counter(); global_total = 0
for eid, lst in occ.items():
    cls = info[eid][3]
    if not cls: continue
    for sid, mid, form in lst:
        if sid not in J: continue
        ja = J[sid][0]
        r = analyse(ja, form, cls)
        if not r: continue
        at, word_end, ms, found = r
        total[eid] += 1; global_total += 1
        for gid, gs, ge in found:
            counts[eid][gid] += 1; global_n[gid] += 1
            surf[gid][ja[gs:ge] if ge > gs else '（意志形）'] += 1
            en = EN.get(mid, ('', ''))[0]
            n = len(ja)
            good = (8 <= n <= 40) and en and not re.search(r'[A-Za-zＡ-Ｚａ-ｚ「」『』（）()・…♪]', ja)
            score = (0 if good else 100) + abs(n - 20) + (0 if sid in READ else 30)
            key = (eid, gid)
            if key not in best or score < best[key][0]:
                best[key] = (score, sid, mid, at, word_end, gs, ge, phrases(ms))

for gid, c in surf.items():
    G[gid][4] = c.most_common(1)[0][0]
for gid in G: G[gid].append(sorted(CONN_OF.get(gid, ())))      # how the pattern attaches (stem, te, ta, dict, nai, noun ...)
shards = [dict() for _ in range(SHARDS)]
nwords = 0
for eid, c in counts.items():
    rate = {g: global_n[g] / max(1, global_total) for g in c}
    floor = 1 if total[eid] < 10 else max(2, math.ceil(total[eid] * 0.02))      # a pattern seen once in many sentences is noise
    ranked = sorted(c.items(), key=lambda kv: -(kv[1] / (rate[kv[0]] ** 0.15) * (0.02 if kv[0] in BASIC else 1)))
    keep = [(g, n) for g, n in ranked if g not in BASIC and n >= floor][:PER_WORD_POINTS]
    if len(keep) < 2: keep += [(g, n) for g, n in ranked if g in BASIC][:2 - len(keep)]
    if not keep: continue
    rows = []
    for g, n in keep:
        _, sid, mid, ws, we, gs, ge, cuts = best[(eid, g)]
        rows.append([g, n, total[eid], [READ.get(sid, J[sid][0]), EN.get(mid, ('', ''))[0], sid, ws, we, gs, ge, cuts]])
    shards[eid % SHARDS][str(eid)] = rows; nwords += 1

os.makedirs(os.path.join(out_dir, 'gr'), exist_ok=True)
size = 0
for i, sh in enumerate(shards):
    p = os.path.join(out_dir, 'gr', '%02d.json' % i)
    json.dump(sh, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':')); size += os.path.getsize(p)
# Typical grammar for each kind of word and level, for words with too few sentences of their own.
KIND = lambda cls: 'verb' if cls.startswith('v') and cls != 'vs' else {'vs': 'suru', 'adj-i': 'i-adj', 'adj-na': 'na-adj'}.get(cls, 'noun')
lvl = {e[6]: e[7] for e in E}
pool = collections.defaultdict(collections.Counter)
for eid, c in counts.items():
    k = KIND(info[eid][3])
    for g, n in c.items():
        if g in BASIC: continue
        for L in (1, 2, 3, 4, 5):
            if L <= G[g][1] <= L + 1: pool[(k, L)][g] += n  # patterns at the word's level or one level easier
defaults = {'%s-%d' % key: [g for g, _ in c.most_common(4)] for key, c in pool.items()}
json.dump({'source': 'Grammar points, levels and meanings: OpenJLPT (CC BY-SA 4.0); usage counted in Tatoeba sentences (CC BY 2.0 FR)',
           'fields': ['pattern', 'level', 'meaning', 'formation', 'surface', 'attaches'], 'points': G, 'defaults': defaults},
          open(os.path.join(out_dir, 'grammar.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
used = collections.Counter(g for c in counts.values() for g in c)
print('words with grammar', nwords, '| sentences analysed', global_total, '| patterns seen', len(used), 'of', len(G), '| shard bytes', size, file=sys.stderr)
print('most common:', [(g, n) for g, n in global_n.most_common(15)], file=sys.stderr)
