# Implementation Note

## Current architecture

- The repository initially contained only `meal_app_mockup.html`; there was no framework, package manager, database, auth, design system, test runner, or build configuration to preserve.
- The mockup is treated as a visual comparison reference only. The product decisions in the Exec Plan are the source of truth.

## Selected implementation approach

- A dependency-free responsive single-page PWA using semantic HTML, CSS, and browser JavaScript.
- Hash routes cover recipes, recipe create/edit/detail/cooking, meal plan, shopping, and the "その他" settings areas.
- Desktop uses a persistent sidebar; mobile uses bottom navigation.
- Dark is the default theme, with Light and System options persisted locally.
- Dense list is the default recipe view; card view is persisted as an alternative.

## Sync and backup architecture

- `localStorage` remains the primary store. Google Drive is a manually triggered sync snapshot / backup store.
- Snapshot root is versioned with `schemaVersion`, `syncVersion`, `updatedAt`, and `sourceDeviceId`; application settings are included under `data.settings` with a settings timestamp.
- Major records are normalized with `id`, `createdAt`, `updatedAt`, and `deletedAt` tombstones. Merge is record-level last-write-wins, including nested shopping-list items.
- Data Management provides local JSON export/import/share, a local pre-operation snapshot, and Google Drive Pull → Merge → Validate → Local save → Cloud upload.
- Drive uses the browser OAuth token model and the constrained `drive.file` scope. Tokens are memory-only; no client secret or refresh token is shipped to the static site or stored in localStorage.
- The Drive layout is `Recipe App/recipe-app-sync.json` and `Recipe App/backups/*.json`; backup retention is user-configurable from 1 to 10 files, with confirmation before old files are deleted.
- `app-config.js` contains only the public Web OAuth Client ID placeholder. It must be filled for a deployment, while private data JSON and secrets stay outside Git.

## DB strategy

- MVP persistence uses a versioned `localStorage` repository (`meal-app-v1`) so the app runs without a server or paid service.
- The state is shaped around the Exec Plan entities: recipes, ingredient master/aliases, recipe ingredients/steps, tags, meal plans, shopping lists/items, pantry items, cooking history, and import sources.
- All UI code accesses persistence through `loadState()` / `saveState()`, leaving a clear seam for a future PostgreSQL/ORM repository without changing core calculations.
- No database provider or authentication method was introduced.

The optional Drive adapter is intentionally static-site compatible: it does not introduce a backend, database, service-account key, or refresh-token store.

## UI component strategy

- Reusable render helpers in `app.js` produce navigation, filters, list/card rows, forms, modal dialogs, shopping rows, and cooking controls.
- `styles.css` contains the responsive layout, focus states, touch targets, dialogs, and cooking-mode presentation.

## Commands used for validation

- `node --check app.js`
- `python -m http.server 4173`
- Browser smoke checks for desktop and mobile routes, CRUD, scaling, meal plan, shopping aggregation/pantry exclusion, cooking history, theme persistence, and import review.
