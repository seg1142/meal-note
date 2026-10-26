---
name: save-recipe
description: 「レシピ保存して」「この料理を料理アプリに登録して」と頼まれたとき、会話のレシピをMeal Noteに取り込める保存リンクとJSONに変換する。レシピを教えるだけの依頼や、料理以外のレシピには使わない。
---

# レシピをMeal Noteに保存する

会話から選ばれた料理を、個人用料理アプリ Meal Note の取り込み画面へ渡す。

## 対象を決める

- 現在の会話で指定された料理を使う。材料の追加・代替、分量変更、工程の訂正など、後のやり取りを反映して一つの完成版にする。
- 複数の料理があり対象が曖昧なときだけ、料理名を短く並べて選んでもらう。複数指定なら1品ずつ別のリンクにする。
- 別のチャットを指定された場合は、利用できる履歴ツールでそのチャットだけを読む。内容を取得できなければ、そのレシピ本文を求める。会話やログ全体を外部へ送らない。

## 取り込み用JSONを作る

料理名・材料・作り方は会話に忠実にする。推測で人数、時間、栄養、材料量を補わない。1リンクに次の形式の1レシピを入れる。配列やアプリ全体のバックアップは渡さない。

```json
{
  "generator": "chatgpt",
  "title": "料理名",
  "description": "会話で決まった調整や補足",
  "servings": 2,
  "prepTimeMinutes": null,
  "cookTimeMinutes": null,
  "sourceUrl": "",
  "category": "副菜",
  "tags": ["ChatGPT"],
  "ingredients": [
    {"name": "もやし", "quantity": 1, "unit": "袋", "note": "", "optional": false, "originalText": "もやし 1袋"},
    {"name": "塩", "quantity": null, "unit": "", "note": "適量", "optional": false, "originalText": "塩 適量"}
  ],
  "steps": ["工程を1つずつ文字列で記載する"]
}
```

- `title`は空でない文字列。材料・工程はそれぞれ1〜100件。
- `quantity`は数値か`null`。単一の分数1/2は0.5にできるが、範囲は数値化しない。
- 人数未記載なら元会話の全量を基準の1とし、descriptionに「分量は元会話の全量。人数未記載」と明記。1〜2人分など範囲なら基準1として元の人数表現もdescriptionに残す。
- 時間は元会話に合計が明記されている場合だけ数値化。工程ごとの加熱時間を全体の調理時間と扱わない。
- `category`は内容に合う「主菜」「副菜」「主食」「汁物」「おつまみ」「デザート」「その他」。
- JSON本文は最大20,000文字。長いときは無関係な会話を除き、それでも超える場合は料理を分ける。

数量が「150〜200g」「適量」の場合は、無理に数値化せず `quantity: null` と `originalText` に原文を残す。任意材料、切り方、代替調味料、会話で決まった変更点も保持する。会話にない外部画像やURLは追加しない。

会話URLが取得できるときだけ `sourceUrl` に残す。URLがなければ空文字にする。`generator` は `chatgpt` にする。

## 保存の動線

利用者が指定したMeal NoteのURLを優先する。PC・スマホ同期を利用している場合は、Tailscale内のPC同期版URLを保存先にする。同梱ヘルパーは、このプロジェクトの `data/local-sync/service-config.json` があれば `publicOrigin` を通常の保存先として読み込む。個人のTailscaleアドレスを公開リポジトリへ書き込まない。同期設定がない場合の標準URLは `https://seg1142.github.io/meal-note/`。

コード実行が使える場合は、UTF-8のJSONファイルを作り、同梱ヘルパーが利用できればURLエンコードする。

```text
python scripts/build_save_link.py recipe.json
python scripts/build_save_link.py recipe.json --app-url http://127.0.0.1:4173/
```

出力の `url` を `[料理名をMeal Noteに保存](URL)` のMarkdownリンクにする。これは登録前の確認画面を開くリンク。リンク作成時は「開いて『確認して保存』を押すと登録できます」と伝える。保存完了とは言わない。

ヘルパーが添付されていない環境では、コード実行で次の同じ形式のリンクを生成してよい。`recipe`は上の形式の完成したオブジェクトとする。レシピと無関係な会話を送らず、短縮URLサービスも使わない。

```python
import json
from urllib.parse import quote
body = json.dumps(recipe, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
assert len(body.encode("utf-16-le")) // 2 <= 20000
url = "https://seg1142.github.io/meal-note/#/recipes/import?recipe=" + quote(body, safe="~()*!.'-_")
assert len(url) <= 12000  # 超える場合はJSON貼り付けに切り替える
print(url)
```

コードを実行できない場合は、JSONをコードブロックで渡し、[Meal Noteの取り込み画面](https://seg1142.github.io/meal-note/#/recipes/import)に貼り付けてもらう。長いリンクで `url: null` が返った場合も同じ動線を使う。壊れたエンコードを手作業で作らない。

既存の利用ブラウザを操作でき、利用者がそのブラウザへの保存を指定している場合は、保存リンクを開き、レビュー内容を確かめて保存してよい。成功表示と保存後の詳細を確認できた場合だけ「保存しました」と伝える。リンクを開いただけ、JSONを作っただけの場合は未保存。

PC同期版は端末のlocalStorageに保存した後、Tailscale経由でPCへ同期する。PCとTailscaleが接続中なら、同じ同期版を使うスマホでも見られる。オフライン時は未送信のまま保持し、再接続後に同期する。公開GitHub Pages版はブラウザごとの保存で同期しないため、PC同期利用中は保存先を混同しない。すでに同じ料理があれば、利用者から指定がない限り重複登録しない。
