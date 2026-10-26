const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(
  '  registerServiceWorker();',
  '  globalThis.appTest = { get state() { return state; }, get ui() { return ui; }, render, draftFromImportInput, importIngredientLine };\n  registerServiceWorker();'
);
const plain = value => JSON.parse(JSON.stringify(value));
const recipe = {
  generator: 'chatgpt', title: 'テスト用の炒め物', servings: 1,
  description: '分量は元会話の全量。人数未記載',
  sourceUrl: 'https://chatgpt.com/c/test-conversation',
  ingredients: [
    { name: '牛肉', quantity: null, unit: 'g', originalText: '牛肉 150〜200g', note: '元会話の範囲を保持', optional: false },
    { name: 'しめじ', quantity: 0.5, unit: 'パック', note: '石づきを除く', optional: true },
    { name: 'にんにく', quantity: 1, unit: '片' },
    { name: 'テスト専用香辛料', quantity: null, unit: '少々', note: '補足1行目\n補足2行目' }
  ],
  steps: ['材料を切る。', '炒める。']
};
const link = value => '#/recipes/import?recipe=' + encodeURIComponent(JSON.stringify(value));

function boot(hash = '#/recipes/import', saved = new Map()) {
  const nodes = new Map();
  const events = {};
  const location = new URL('https://example.test/meal-note/' + hash);
  const storage = { writes: 0, fail: false, saved };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    console, URL, URLSearchParams, location, navigator: {},
    setTimeout() { return 1; }, clearTimeout() {},
    localStorage: {
      getItem(key) { return saved.get(key) || null; },
      setItem(key, value) { if (storage.fail) throw new Error('Storage full'); storage.writes++; saved.set(key, String(value)); }
    },
    document: {
      getElementById: node, querySelectorAll() { return []; },
      documentElement: { dataset: {} }, body: node('body'),
      addEventListener(type, listener) { (events[type] ||= []).push(listener); }
    },
    window: {
      addEventListener() {},
      matchMedia() { return { matches: false, addEventListener() {} }; },
      history: { replaceState(_state, _title, url) { location.href = new URL(url, location.href).href; } }
    },
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } }
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  return { app: context.appTest, storage, node, location,
    open(value) { location.hash = value; context.appTest.render(); },
    click(action) {
      const target = { dataset: { action }, closest() { return this; } };
      events.click.forEach(listener => listener({ target }));
    },
    submitReview(overrides = {}) {
      const draft = context.appTest.ui.importDraft;
      const values = draft ? {
        title: draft.title, description: draft.description, category: draft.category,
        originalServings: draft.originalServings, prepTimeMinutes: draft.prepTimeMinutes,
        cookTimeMinutes: draft.cookTimeMinutes, tags: draft.tags.join(','),
        ingredients: draft.ingredients.map(context.appTest.importIngredientLine).join('\n'),
        steps: draft.steps.map(step => step.instruction).join('\n'), ...overrides
      } : {};
      events.submit.forEach(listener => listener({ target: { dataset: { form: 'import-review' }, values }, preventDefault() {} }));
    }
  };
}

test('a chat link opens escaped review without saving, including on repeated opens', () => {
  const env = boot();
  const count = env.app.state.recipes.length;
  const stateBefore = plain(env.app.state);
  const writes = env.storage.writes;
  env.open(link({ ...recipe, title: '<img src=x onerror=alert(1)>' }));
  assert.equal(env.app.state.recipes.length, count);
  assert.equal(env.storage.writes, writes);
  assert.deepEqual(plain(env.app.state), stateBefore);
  assert.equal(env.location.hash, '#/recipes/import');
  assert.match(env.node('view').innerHTML, /ChatGPT整形JSON/);
  assert.match(env.node('view').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  env.open(link(recipe));
  env.click('clear-import');
  assert.equal(env.app.ui.importDraft, null);
  assert.deepEqual(plain(env.app.state), stateBefore);
  env.open(link(recipe));
  env.open(link(recipe));
  assert.equal(env.app.state.recipes.length, count);
  assert.equal(env.storage.writes, writes);
  assert.deepEqual(plain(env.app.state), stateBefore);
});

test('confirm saves once and preserves structured ingredients and source after reload', () => {
  const env = boot(link(recipe));
  const before = env.app.state.recipes.length;
  const draftIngredients = plain(env.app.ui.importDraft.ingredients);
  env.submitReview();
  assert.equal(env.app.state.recipes.length, before + 1);
  assert.deepEqual(plain(env.app.state.recipes[0].ingredients), draftIngredients);
  assert.equal(env.app.state.recipes[0].ingredients[0].originalText, '牛肉 150〜200g');
  assert.equal(env.app.state.recipes[0].ingredients[1].quantity, 0.5);
  assert.equal(env.app.state.recipes[0].ingredients[1].unit, 'パック');
  assert.equal(env.app.state.recipes[0].ingredients[1].note, '石づきを除く');
  assert.equal(env.app.state.recipes[0].ingredients[1].optional, true);
  assert.equal(env.app.state.importSources.at(-1).importMethod, 'chatgpt_json');
  env.submitReview();
  assert.equal(env.app.state.recipes.length, before + 1);
  const reloaded = boot('#/recipes/import', env.storage.saved);
  assert.equal(reloaded.app.state.recipes[0].sourceType, 'ai_json');
  assert.equal(reloaded.app.state.recipes[0].aiGenerator, 'chatgpt');
  assert.deepEqual(plain(reloaded.app.state.recipes[0].ingredients), draftIngredients);
});

test('storage failure retains review, rolls back all state, and reports failure', () => {
  const env = boot();
  const before = plain(env.app.state);
  const storedBefore = env.storage.saved.get('meal-app-v1');
  env.open(link(recipe));
  assert.deepEqual(plain(env.app.state), before);
  env.storage.fail = true;
  env.submitReview();
  assert.deepEqual(plain(env.app.state), before);
  assert.equal(env.storage.saved.get('meal-app-v1'), storedBefore);
  assert.equal(env.location.hash, '#/recipes/import');
  assert.ok(env.app.ui.importDraft);
  assert.match(env.node('toast').textContent, /書き込めませんでした/);
  env.storage.fail = false;
  env.submitReview();
  assert.equal(env.app.state.recipes.length, before.recipes.length + 1);
});

test('invalid, empty, duplicate, oversized and malformed link inputs show errors without saving', () => {
  const invalid = [
    '#/recipes/import?recipe=', '#/recipes/import?recipe=%E0%A4%A',
    '#/recipes/import?recipe=%7B', '#/recipes/import?recipe=%7B%7D&recipe=%7B%7D',
    link(null), link([]), link({ ...recipe, title: [] }),
    link({ ...recipe, ingredients: [{ name: '塩', quantity: '適量' }] }),
    link({ ...recipe, ingredients: [{ name: '塩', optional: 'false' }] }),
    link({ ...recipe, steps: [{}] }), link({ ...recipe, servings: -1 }),
    link({ ...recipe, sourceUrl: 'javascript:alert(1)' }),
    link({ ...recipe, url: 'javascript:alert(1)' }),
    link({ ...recipe, image: 'javascript:alert(1)' }),
    link({ ...recipe, image: { url: 'https://example.test/image.png' } }),
    link({ ...recipe, description: '長'.repeat(20001) }),
    '#/recipes/import?recipe=' + 'x'.repeat(180001)
  ];
  const env = boot();
  const count = env.app.state.recipes.length;
  const writes = env.storage.writes;
  for (const hash of invalid) {
    env.open(hash);
    assert.equal(env.app.ui.importDraft, null, hash.slice(0, 90));
    assert.ok(env.app.ui.importError, hash.slice(0, 90));
    assert.match(env.node('view').innerHTML, /notice error/);
    assert.equal(env.app.state.recipes.length, count);
    assert.equal(env.storage.writes, writes);
  }
});

test('existing pasted Gemini JSON and Recipe JSON-LD remain supported', () => {
  const env = boot();
  const stateBefore = plain(env.app.state);
  const gemini = env.app.draftFromImportInput('```json\n' + JSON.stringify({ ...recipe, generator: 'gemini' }) + '\n```', '');
  assert.equal(gemini.aiGenerator, 'gemini');
  assert.equal(gemini.ingredients[1].note, '石づきを除く');
  const jsonLd = env.app.draftFromImportInput(JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Recipe', name: '既存形式', recipeYield: '2人分',
    recipeIngredient: ['卵 2個'], recipeInstructions: [{ '@type': 'HowToStep', text: '焼く。' }]
  }), 'https://example.test/recipe');
  assert.equal(jsonLd.sourceType, 'json_ld');
  assert.equal(jsonLd.originalServings, 2);
  assert.equal(jsonLd.steps[0].instruction, '焼く。');
  assert.deepEqual(plain(env.app.state), stateBefore);
});

test('dessert, other and custom categories remain selected and survive save', () => {
  for (const category of ['デザート', 'その他', '朝食セット']) {
    const env = boot(link({ ...recipe, category }));
    assert.equal(env.app.ui.importDraft.category, category);
    assert.ok(env.node('view').innerHTML.includes('<option value="' + category + '" selected>'));
    env.submitReview();
    assert.equal(env.app.state.recipes[0].category, category);
  }
});
