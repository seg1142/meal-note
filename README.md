# Meal Note

献立・レシピ・買い物・調理履歴をひとつにつなぐ、個人利用向けのレスポンシブ PWA です。

## Implementation Summary

### Architecture

- 依存パッケージなしの single-page web app
- Hash route: /recipes, /recipes/new, /recipes/:id, /recipes/:id/edit, /recipes/:id/cook, /recipes/import, /meal-plan, /shopping, /more, /more/tags, /more/pantry, /more/settings, /more/data
- Desktop: 左サイドバー / Mobile: 下部ナビゲーション
- Dark default + Light / System
- localStorage に保存する versioned repository (meal-app-v1)
- AI・認証・外部有料サービスには依存しない

### Database Schema Mapping

Exec Plan のエンティティを、ブラウザ内 state の配列として保持しています。

| Exec Plan | MVP state |
| --- | --- |
| recipes | state.recipes |
| ingredients, ingredient_aliases | state.ingredientMaster |
| recipe_ingredients, recipe_steps | recipe.ingredients, recipe.steps |
| tags, recipe_tags | state.tags, recipe.tags |
| meal_plans | state.mealPlans |
| shopping_lists, shopping_list_items | state.shoppingLists[].items |
| pantry_items | state.pantryItems |
| cooking_history | state.cookingHistory |
| import_sources | state.importSources / recipe source fields |

originalText を材料ごとに保持し、数値数量だけを献立人数に応じて表示上スケールします。異なる単位は自動統合しません。

### Implemented Features

- 指定URLとMarkdown本文から作成した19件の初期レシピ seed
- 詳細画面のレシピサムネイル（YouTubeは自動設定、手動登録は画像URLを任意指定）
- Dense List default / Card toggle / search / category / tag / favorite / time filter / sorting
- Search and filter controls collapsed by default and expandable on demand
- Manual recipe create/edit/delete
- Serving scaling without writing scaled values back
- Weekly meal plan with breakfast/lunch/dinner/other and multiple recipes per slot
- Meal plan → categorized shopping list generation
- Adding or removing a meal automatically refreshes the shopping list for that week
- Same ingredient + same unit aggregation
- Pantry exclusion with restoreable excluded items
- Shopping check/uncheck, edit, manual add, exclude, delete, category/recipe view
- Full-screen-style Cooking Mode with ingredient check, step progress, Wake Lock fallback
- Cooking history with rating and note
- URL-first recipe import: public Recipe JSON-LD pages can be imported with ingredients, steps, times, and thumbnail; review remains available when needed
- Gemini-assisted import bridge: copy a structured prompt for a YouTube URL, paste Gemini's JSON response, and import ingredients / steps / metadata without an API key in Meal Note
- ChatGPT / Gemini recipe JSON and chat save links: open a recipe review from a chat, then explicitly save to the current browser
- Web App Manifest and application-shell service worker
- PWA icon uses the supplied `app-icon-192.png` / `app-icon-512.png` assets
- Data Management: local JSON export/import/share and an automatic local snapshot before restore/sync
- Optional private PC server: Tailscale HTTPS, automatic device synchronization, offline changes, and local disk backups
- Google Drive sync adapter (optional / deferred): `drive.file` scope, `Recipe App/recipe-app-sync.json`, `backups/`, record-level LWW merge, and no token/secret persistence
- Keyboard focus, labels, responsive touch targets

### Deferred / Known Limitations

- localStorage は単一ブラウザ・単一ユーザー向けです。PostgreSQL/ORM へ差し替える repository boundary は用意していますが、DB provider は未固定です。
- URL import はブラウザの CORS 制約を受けます。公開Recipe JSON-LDを持つレシピサイトはURLだけで自動登録できます。サイト側がCORSを許可していない場合は、JSON-LD / HTMLの貼り付け、またはURL情報の仮登録で続行できます。YouTubeはoEmbedでタイトル・サムネイルを自動取得できますが、動画音声から材料・工程を抽出する部分は、Meal Note内ではAPIを使わず、コピーしたプロンプトをGeminiへ貼り付け、その整形JSONをMeal Noteへ戻す方式にしています。
- サムネイルは取得できた外部URLを参照して詳細画面に表示します。画像ファイル自体のローカル保存・ミラーリングはまだ行わず、画像なしでも表示できるようにしています。
- Google Drive連携は将来機能として保持しています。現行運用ではGoogle Cloud設定やOAuth Client IDを不要とし、JSON Export / Import / Shareを主なバックアップ手段にします。再有効化する場合はGoogle CloudでWeb OAuth Client IDを作成し、`app-config.js` の `googleClientId` に設定します。Client Secretは作成してもリポジトリへ置かず、ブラウザへ配布しません。
- Drive同期は手動実行です。リアルタイム同期、バックグラウンド同期、複数ユーザー、CRDT、AI機能は対象外です。

## How to Run

Node.js がある環境で、プロジェクトフォルダから静的サーバーを起動します。

~~~powershell
node -e "const http=require('http'),fs=require('fs'),path=require('path');http.createServer((req,res)=>{const safe=decodeURIComponent(req.url.split('?')[0]);const file=path.join(process.cwd(),safe==='/'?'index.html':safe.slice(1));fs.readFile(file,(err,data)=>{if(err){res.statusCode=404;res.end('Not found');return;}const ext=path.extname(file);const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};res.setHeader('Content-Type',types[ext]||'text/plain');res.end(data);});}).listen(4173)"
~~~

Then open http://127.0.0.1:4173/.

No environment variables or database migration commands are required for the MVP. The service worker is enabled on localhost / 127.0.0.1 and HTTPS; it is intentionally not registered when opened via file://.

### Save a recipe from ChatGPT

`skills/save-recipe` contains the reusable 「レシピ保存」 skill. In ChatGPT's Skills screen, upload a ZIP containing that folder, then enable/install it. Codex can also load it from a supported personal skill directory. Availability and installation are separate for ChatGPT workspace skills and local Codex skills.

Ask 「このレシピ保存して」 after discussing a recipe. The skill uses the selected dish and later adjustments in the conversation, then produces a link to `#/recipes/import?recipe=<URL-encoded recipe JSON>`. Opening the link displays a review. Select 「確認して保存」 to register the recipe in the browser that opened the link. Recipe links do not automatically save, and creating a link does not mean registration has completed.

The app preserves structured quantities, original ingredient text, notes, optional ingredients, source conversation URL, and the ChatGPT/Gemini origin. Links accept one recipe with up to 100 ingredients and 100 steps, and a JSON body of up to 20,000 characters. Long links can instead use the existing JSON paste input.

The skill's standard-library Python helper builds links without contacting a server:

~~~text
python skills/save-recipe/scripts/build_save_link.py recipe.json
python skills/save-recipe/scripts/build_save_link.py recipe.json --app-url http://127.0.0.1:4173/
~~~

The public GitHub Pages version stores data in each browser. For PC/phone synchronization, use the private PC version below on both devices. The link helper prefers the private origin in `data/local-sync/service-config.json` when that local configuration exists. The installed ChatGPT skill can use the same private URL in its instructions; keep that personal address out of public source.

Recipe test data, generated links, skill ZIPs, and screenshots belong under the ignored `data/` or `exports/` directories and must not be included in the public deployment.

### PC and phone synchronization through Tailscale

The optional Node.js server serves the app and `/api/sync` from one origin. `Tailscale Serve` provides HTTPS on port 8443 and forwards to `127.0.0.1:4319`; existing services on port 443 remain available. Both devices must use the new private URL, with Tailscale connected. Google Cloud configuration is unnecessary.

On Windows, with Node.js and Tailscale installed and connected, run:

~~~powershell
.\scripts\install-local-sync.ps1
~~~

The installer prints the private URL and registers `MealNoteLocalSync` to start at Windows sign-in, with automatic retry after failures. It writes machine-specific configuration under the ignored `data/local-sync/` directory. The server is bound to loopback and is shared only inside the tailnet through Serve. It exposes only the app shell and sync API; source scripts, settings files, data files, and backups are not static downloads. API writes require the expected same-origin JSON request.

For manual operation:

~~~text
node server/local-sync.cjs --port 4319 --public-origin https://YOUR-PC.YOUR-TAILNET.ts.net:8443 --data-dir data/local-sync
~~~

Before first use, export the existing browser data from 「その他 → データ管理」 and retain that backup. Initialize an empty server by sending `{ "snapshot": <the exported JSON> }` to `POST /api/sync`, using `Content-Type: application/json` and an allowed `Origin` such as `http://127.0.0.1:4319`. The server rejects invalid snapshots. New devices first load the server data, so their built-in samples cannot replace existing PC recipes.

Changes save to the browser first, then sync after a short delay. The app also syncs at launch, reconnection, return to the screen, and every 15 seconds while visible. 「その他 → データ管理」 shows pending changes, the last sync, and 「今すぐ同期」. API responses are never cached by the service worker. JSON imports in the sync version merge records instead of replacing pending changes.

The server serializes concurrent writes, merges records by ID and update time, retains deletion markers, and merges shopping-list items individually. Different records survive concurrent edits; for simultaneous edits of the same recipe, the later update wins. Changes made while a response is pending remain queued. First loading requires access to the PC; after the shell and data are cached, offline viewing/editing is available and changes are sent on reconnection. Mobile background execution is not required; open or return to the app to synchronize.

The PC must be running and reachable to exchange updates. Sleep or shutdown stops synchronization; this setup does not change power settings. The canonical snapshot is `data/local-sync/state.json`, with up to 20 previous revisions under `data/local-sync/backups/`. Keep these private and include them in normal PC backups. Corrupt data stops the server instead of silently resetting it.

To stop this optional service, stop/disable the `MealNoteLocalSync` scheduled task and remove only its Serve endpoint with `tailscale serve --https=8443 off`. Do not use a global Serve reset, because other services may share Tailscale.

### Google Drive setup (optional / deferred)

1. Google Cloudで新規プロジェクトを作成し、Google Drive APIを有効化します。
2. OAuth同意画面を個人利用向けに設定し、Webアプリ用のOAuth Client IDを作成します。
3. GitHub Pagesの公開URLを承認済みJavaScript生成元に追加し、`app-config.js` の `googleClientId` にClient IDを設定します。
4. アプリの「その他 → データ管理」から接続します。同期対象にはレシピ、献立、買い物、調理履歴、個人的なメモ、設定が含まれます。

`app-config.js` は公開ブラウザ設定です。Client Secret、アクセストークン、リフレッシュトークン、個人データJSONはコミットしません。`.gitignore` でもバックアップ・エクスポート・DBファイルを除外しています。

### GitHub Pages

`.github/workflows/pages.yml` を同梱しています。Publicリポジトリへpush後、GitHubの Settings → Pages で Source を GitHub Actions にすると、`master` / `main` へのpushで静的サイトを公開できます。Google OAuthは現行運用では設定せず、`app-config.js` のClient IDは空欄のまま公開します。

## Validation Results

- node --check app.js — pass
- Browser smoke test — pass: initial seed, recipe detail, serving scaling, recipe create, week plan, shopping generation, pantry exclusion/restore, cooking history, JSON-LD review/save, light theme persistence
- Desktop screenshot check — pass
- Mobile 390×844 screenshot check — pass; no visible horizontal overflow
- Browser console warning/error check — no errors observed
- Data management screen — pass: JSON export/import/share, local snapshot, Google Drive optional/deferred表示
- Mobile 390×844 data management / recipe filter disclosure — pass; no visible horizontal overflow

## Representative Screens

- #/recipes: dense recipe list, filters, view toggle
- #/recipes/:id: scaling detail, meal-plan action, cooking-history
- #/meal-plan: weekly primary view
- #/shopping: category / recipe shopping views
- #/recipes/:id/cook: cooking mode
- #/recipes/import: JSON-LD review flow
- #/more/data: local JSON and Google Drive data management

## Future Extension Notes

The persistence calls are centralized in loadState() / saveState(), and ingredient normalization, shopping aggregation, and import parsing are independent helpers. A future API/ORM adapter can replace the repository without making AI a core dependency.
