(function () {
  'use strict';

  var STORAGE_KEY = 'meal-app-v1';
  var LOCAL_BACKUP_KEY = 'meal-app-local-backup-v1';
  var SYNC_SCHEMA_VERSION = 1;
  var DEFAULT_SETTINGS = { theme: 'dark', recipeView: 'list', shoppingView: 'category', excludePantry: true, backupRetention: 5 };
  var WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];
  var SLOTS = [
    { key: 'breakfast', label: '朝' },
    { key: 'lunch', label: '昼' },
    { key: 'dinner', label: '夜' },
    { key: 'other', label: 'その他' }
  ];
  var SHOPPING_CATEGORIES = ['野菜', '肉・魚', '冷蔵', '調味料', '乾物', '飲料', 'その他'];
  var PALETTE = ['#bc7652', '#668d68', '#c49745', '#6d83a5', '#a36a83', '#7d9561', '#b47e51', '#657e79'];
  var view = document.getElementById('view');
  var modal = document.getElementById('modal');
  var toast = document.getElementById('toast');
  var toastTimer = null;
  var wakeLock = null;
  var state = loadState();
  var driveRuntime = {
    accessToken: '',
    tokenClient: null,
    expiresAt: 0,
    connected: false
  };
  var ui = {
    search: '',
    category: 'すべて',
    tag: 'すべて',
    favoriteOnly: false,
    maxTime: '',
    sort: 'recent',
    formDraft: {},
    weekOffset: 0,
    selectionMode: false,
    selectedRecipes: {},
    shoppingView: state.settings.shoppingView || 'category',
    importDraft: null,
    importError: '',
    cookSessions: {},
    pendingImport: null,
    dataError: ''
  };

  function nowISO() {
    return new Date().toISOString();
  }

  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalize(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  }

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(value) {
    return escapeHTML(value);
  }

  function formatQuantity(value) {
    if (value == null || value === '') return '';
    var rounded = Math.round(Number(value) * 100) / 100;
    return String(rounded).replace('.0', '');
  }

  function formatDate(iso, includeWeekday) {
    if (!iso) return '—';
    var date = new Date(iso + 'T00:00:00');
    var label = (date.getMonth() + 1) + '/' + date.getDate();
    return includeWeekday ? WEEKDAYS[(date.getDay() + 6) % 7] + ' ' + label : label;
  }

  function isoDate(date) {
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function dateFromISO(value) {
    return new Date(value + 'T00:00:00');
  }

  function addDays(date, amount) {
    var result = new Date(date);
    result.setDate(result.getDate() + amount);
    return result;
  }

  function mondayOf(date) {
    var result = new Date(date);
    var day = result.getDay();
    var distance = day === 0 ? -6 : 1 - day;
    result.setDate(result.getDate() + distance);
    result.setHours(0, 0, 0, 0);
    return result;
  }

  function weekStart(offset) {
    return addDays(mondayOf(new Date()), (offset || 0) * 7);
  }

  function totalTime(recipe) {
    return Number(recipe.prepTimeMinutes || 0) + Number(recipe.cookTimeMinutes || 0);
  }

  function timeLabel(recipe) {
    var total = totalTime(recipe);
    return total ? total + '分' : '時間未設定';
  }

  function ingredientIdFor(name) {
    var key = normalize(name);
    var found = state.ingredientMaster.find(function (item) {
      return normalize(item.canonicalName) === key || (item.aliases || []).some(function (alias) { return normalize(alias) === key; });
    });
    return found ? found.id : 'custom-' + key;
  }

  function ensureIngredientMaster(name, category, unit) {
    var id = ingredientIdFor(name);
    if (!state.ingredientMaster.some(function (item) { return item.id === id; })) {
      state.ingredientMaster.push({
        id: id,
        canonicalName: name,
        category: category || 'その他',
        defaultUnit: unit || '',
        createdAt: nowISO(),
        updatedAt: nowISO(),
        deletedAt: null
      });
    }
    return id;
  }

  function defaultIngredient(name, quantity, unit, note, optional) {
    return {
      id: uid('ri'),
      ingredientId: 'custom-' + normalize(name),
      displayName: name,
      quantity: quantity == null ? null : Number(quantity),
      unit: unit || '',
      originalText: quantity == null ? name : formatQuantity(quantity) + (unit ? ' ' + unit : '') + ' ' + name,
      optional: Boolean(optional),
      note: note || ''
    };
  }

  function seedRecipe(id, title, category, tags, servings, prep, cook, ingredients, steps, favorite, color, description) {
    return {
      id: id,
      title: title,
      description: description || '',
      originalServings: servings,
      prepTimeMinutes: prep,
      cookTimeMinutes: cook,
      sourceType: 'manual',
      sourceUrl: '',
      favorite: Boolean(favorite),
      category: category,
      tags: tags,
      ingredients: ingredients,
      steps: steps.map(function (instruction, index) { return { id: uid('step'), stepNumber: index + 1, instruction: instruction, timerSeconds: null }; }),
      createdAt: nowISO(),
      updatedAt: nowISO(),
      color: color
    };
  }

  function createSeedState() {
    var master = [
      ['豚こま肉', '肉・魚', 'g', ['豚肉']],
      ['豚バラ肉', '肉・魚', 'g', ['豚肉']],
      ['鶏むね肉', '肉・魚', 'g', ['鶏肉']],
      ['合いびき肉', '肉・魚', 'g', ['ひき肉']],
      ['キャベツ', '野菜', 'g', []],
      ['玉ねぎ', '野菜', '個', ['たまねぎ']],
      ['ピーマン', '野菜', '個', []],
      ['にんじん', '野菜', '本', []],
      ['じゃがいも', '野菜', '個', []],
      ['卵', '冷蔵', '個', ['たまご']],
      ['豆腐', '冷蔵', '丁', []],
      ['牛乳', '冷蔵', 'ml', []],
      ['味噌', '調味料', '大さじ', ['みそ']],
      ['醤油', '調味料', '大さじ', ['しょうゆ']],
      ['みりん', '調味料', '大さじ', []],
      ['酒', '調味料', '大さじ', []],
      ['砂糖', '調味料', '大さじ', []],
      ['酢', '調味料', '大さじ', []],
      ['ごま油', '調味料', '大さじ', []],
      ['サラダ油', '調味料', '大さじ', ['油']],
      ['中華麺', '乾物', '玉', []],
      ['ツナ缶', '乾物', '缶', []],
      ['ひじき', '乾物', 'g', []],
      ['油揚げ', '冷蔵', '枚', []],
      ['コンソメ', '調味料', '個', []],
      ['めんつゆ', '調味料', '大さじ', []],
      ['片栗粉', '乾物', '大さじ', []],
      ['生姜', '野菜', '', ['しょうが']],
      ['わかめ', '乾物', '', []]
    ].map(function (item) {
      return { id: normalize(item[0]).replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]/g, '-'), canonicalName: item[0], category: item[1], defaultUnit: item[2], aliases: item[3] };
    });
    var currentWeek = isoDate(mondayOf(new Date()));
    var recipes = [
      seedRecipe('recipe-yakibuta', '生姜焼き', '主菜', ['和食', '平日'], 2, 10, 10, [defaultIngredient('豚こま肉', 300, 'g'), defaultIngredient('玉ねぎ', 0.5, '個'), defaultIngredient('醤油', 1, '大さじ'), defaultIngredient('みりん', 1, '大さじ'), defaultIngredient('生姜', null, '', 'すりおろし')], ['玉ねぎを薄切りにし、豚肉は食べやすい大きさにする。', '調味料を混ぜ合わせ、フライパンで玉ねぎと豚肉を炒める。', '火が通ったらたれを加え、照りが出るまで煮からめる。'], true, PALETTE[0], '甘辛い定番の生姜焼き。ごはんが進む平日向けの一皿です。'),
      seedRecipe('recipe-hoikoro', '回鍋肉', '主菜', ['中華', '野菜たっぷり'], 2, 10, 12, [defaultIngredient('豚バラ肉', 250, 'g'), defaultIngredient('キャベツ', 0.25, '個'), defaultIngredient('ピーマン', 2, '個'), defaultIngredient('味噌', 1, '大さじ'), defaultIngredient('醤油', 1, '大さじ'), defaultIngredient('ごま油', 1, '大さじ')], ['キャベツとピーマンをひと口大に切る。', '豚肉を炒め、野菜を加えて強火でさっと火を通す。', '合わせ調味料を加え、全体を手早く炒め合わせる。'], false, PALETTE[1]),
      seedRecipe('recipe-teriyaki', '鶏むね肉の照り焼き', '主菜', ['和食', '作り置き'], 2, 10, 10, [defaultIngredient('鶏むね肉', 300, 'g'), defaultIngredient('醤油', 1, '大さじ'), defaultIngredient('みりん', 1, '大さじ'), defaultIngredient('酒', 1, '大さじ'), defaultIngredient('砂糖', 0.5, '大さじ'), defaultIngredient('片栗粉', 1, '大さじ')], ['鶏肉をそぎ切りにし、片栗粉を薄くまぶす。', '皮目から焼き、両面に焼き色をつける。', '調味料を加え、つやが出るまで煮詰める。'], false, PALETTE[2]),
      seedRecipe('recipe-rollcabbage', 'ロールキャベツ', '主菜', ['洋食', '週末'], 2, 20, 35, [defaultIngredient('キャベツ', 4, '枚'), defaultIngredient('合いびき肉', 200, 'g'), defaultIngredient('玉ねぎ', 0.5, '個'), defaultIngredient('卵', 1, '個'), defaultIngredient('コンソメ', 1, '個')], ['キャベツの葉をしんなりするまでゆでる。', '肉だねを混ぜ、キャベツで包んで巻き終わりを下にする。', '鍋に並べてコンソメで30分ほど煮込む。'], false, PALETTE[3]),
      seedRecipe('recipe-yakisoba', '豚キャベツ焼きそば', '主食', ['中華', '時短'], 2, 8, 7, [defaultIngredient('豚こま肉', 150, 'g'), defaultIngredient('キャベツ', 0.15, '個'), defaultIngredient('中華麺', 2, '玉'), defaultIngredient('醤油', 1, '大さじ'), defaultIngredient('ごま油', 1, '小さじ')], ['具材を食べやすく切り、豚肉から炒める。', 'キャベツと麺を加えてほぐしながら炒める。', '醤油とごま油で味を整える。'], false, PALETTE[4]),
      seedRecipe('recipe-mugenpepper', '無限ピーマン', '副菜', ['和食', '時短'], 2, 5, 5, [defaultIngredient('ピーマン', 4, '個'), defaultIngredient('ツナ缶', 1, '缶'), defaultIngredient('ごま油', 1, '小さじ'), defaultIngredient('醤油', 1, '小さじ')], ['ピーマンを細切りにする。', '耐熱容器に材料を入れ、電子レンジで3分加熱する。', 'よく混ぜて味をなじませる。'], false, PALETTE[5]),
      seedRecipe('recipe-ajitama', '味玉', '副菜', ['和食', '作り置き'], 4, 5, 8, [defaultIngredient('卵', 4, '個'), defaultIngredient('めんつゆ', 4, '大さじ')], ['卵を好みの固さにゆで、冷水で冷やして殻をむく。', '保存袋に卵とめんつゆを入れ、冷蔵庫で半日漬ける。'], false, PALETTE[6]),
      seedRecipe('recipe-hijiki', 'ひじきの煮物', '副菜', ['和食', '作り置き'], 4, 10, 15, [defaultIngredient('ひじき', 20, 'g'), defaultIngredient('にんじん', 0.5, '本'), defaultIngredient('油揚げ', 1, '枚'), defaultIngredient('醤油', 2, '大さじ'), defaultIngredient('みりん', 1, '大さじ')], ['ひじきを戻し、にんじんと油揚げを細切りにする。', '具材を炒め、だしと調味料を加える。', '汁気が少なくなるまで煮含める。'], false, PALETTE[7]),
      seedRecipe('recipe-misosoup', '豆腐とわかめの味噌汁', '汁物', ['和食', '定番'], 2, 5, 8, [defaultIngredient('豆腐', 0.5, '丁'), defaultIngredient('味噌', 2, '大さじ'), defaultIngredient('わかめ', null, '', '乾燥・適量')], ['鍋にだしを温め、豆腐を加える。', '火を弱めて味噌を溶き入れ、わかめを加える。'], false, PALETTE[2]),
      seedRecipe('recipe-potatosalad', 'ポテトサラダ', '副菜', ['洋食', '作り置き'], 3, 15, 12, [defaultIngredient('じゃがいも', 3, '個'), defaultIngredient('にんじん', 0.5, '本'), defaultIngredient('卵', 1, '個'), defaultIngredient('酢', 1, '小さじ')], ['じゃがいもとにんじんをゆで、卵もゆでる。', '熱いうちにじゃがいもをつぶし、酢を混ぜる。', '具材を合わせて味を整える。'], false, PALETTE[1])
    ];
    recipes.forEach(function (recipe) {
      recipe.ingredients.forEach(function (item) { item.ingredientId = ingredientIdFromMaster(master, item.displayName); });
    });
    return {
      version: 1,
      recipes: recipes,
      ingredientMaster: master,
      tags: [
        { id: 'tag-washoku', name: '和食', type: 'tag' },
        { id: 'tag-chuka', name: '中華', type: 'tag' },
        { id: 'tag-yoshoku', name: '洋食', type: 'tag' },
        { id: 'tag-short', name: '時短', type: 'tag' },
        { id: 'tag-prep', name: '作り置き', type: 'tag' },
        { id: 'tag-main', name: '主菜', type: 'category' },
        { id: 'tag-side', name: '副菜', type: 'category' }
      ],
      mealPlans: [
        { id: uid('meal'), date: currentWeek, mealSlot: 'dinner', recipeId: 'recipe-hoikoro', servings: 2, note: '' },
        { id: uid('meal'), date: isoDate(addDays(dateFromISO(currentWeek), 1)), mealSlot: 'dinner', recipeId: 'recipe-yakisoba', servings: 2, note: '' },
        { id: uid('meal'), date: isoDate(addDays(dateFromISO(currentWeek), 2)), mealSlot: 'dinner', recipeId: 'recipe-rollcabbage', servings: 2, note: '' },
        { id: uid('meal'), date: isoDate(addDays(dateFromISO(currentWeek), 4)), mealSlot: 'dinner', recipeId: 'recipe-teriyaki', servings: 2, note: '' },
        { id: uid('meal'), date: isoDate(addDays(dateFromISO(currentWeek), 6)), mealSlot: 'dinner', recipeId: 'recipe-yakibuta', servings: 2, note: '' },
        { id: uid('meal'), date: isoDate(addDays(dateFromISO(currentWeek), 6)), mealSlot: 'dinner', recipeId: 'recipe-misosoup', servings: 2, note: '' }
      ],
      shoppingLists: [],
      pantryItems: [
        { id: uid('pantry'), ingredientId: '醤油', alwaysAvailable: true },
        { id: uid('pantry'), ingredientId: '砂糖', alwaysAvailable: true },
        { id: uid('pantry'), ingredientId: 'ごま油', alwaysAvailable: true }
      ],
      cookingHistory: [],
      importSources: [],
      settings: Object.assign({}, DEFAULT_SETTINGS),
      sync: {
        schemaVersion: SYNC_SCHEMA_VERSION,
        deviceId: createDeviceId(),
        lastSyncAt: '',
        lastCloudUpdatedAt: '',
        lastLocalBackupAt: '',
        lastDriveBackupAt: '',
        lastError: '',
        driveFolderId: '',
        driveFileId: '',
        settingsUpdatedAt: ''
      }
    };
  }

  function createDeviceId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return uid('device');
  }

  function normalizeRecord(record, fallbackTime) {
    var item = record || {};
    var createdAt = item.createdAt || item.updatedAt || fallbackTime;
    item.createdAt = createdAt;
    item.updatedAt = item.updatedAt || createdAt || fallbackTime;
    if (!Object.prototype.hasOwnProperty.call(item, 'deletedAt')) item.deletedAt = null;
    return item;
  }

  function normalizeState(parsed) {
    var migratedAt = nowISO();
    parsed.settings = Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {});
    var retention = Number(parsed.settings.backupRetention || 5);
    parsed.settings.backupRetention = Number.isFinite(retention) ? Math.max(1, Math.min(10, retention)) : 5;
    parsed.ingredientMaster = Array.isArray(parsed.ingredientMaster) ? parsed.ingredientMaster : [];
    parsed.recipes = Array.isArray(parsed.recipes) ? parsed.recipes : [];
    parsed.mealPlans = Array.isArray(parsed.mealPlans) ? parsed.mealPlans : [];
    parsed.shoppingLists = Array.isArray(parsed.shoppingLists) ? parsed.shoppingLists : [];
    parsed.pantryItems = Array.isArray(parsed.pantryItems) ? parsed.pantryItems : [];
    parsed.cookingHistory = Array.isArray(parsed.cookingHistory) ? parsed.cookingHistory : [];
    parsed.importSources = Array.isArray(parsed.importSources) ? parsed.importSources : [];
    parsed.tags = Array.isArray(parsed.tags) ? parsed.tags : [];
    parsed.recipes.forEach(function (recipe) { normalizeRecord(recipe, migratedAt); });
    parsed.mealPlans.forEach(function (meal) { normalizeRecord(meal, migratedAt); });
    parsed.shoppingLists.forEach(function (list) {
      normalizeRecord(list, migratedAt);
      list.items = Array.isArray(list.items) ? list.items : [];
      list.items.forEach(function (item) { normalizeRecord(item, list.updatedAt || migratedAt); });
    });
    parsed.pantryItems.forEach(function (item) { normalizeRecord(item, migratedAt); });
    parsed.cookingHistory.forEach(function (item) { normalizeRecord(item, item.cookedAt || migratedAt); });
    parsed.importSources.forEach(function (item) { normalizeRecord(item, migratedAt); });
    parsed.tags.forEach(function (item) { normalizeRecord(item, migratedAt); });
    parsed.ingredientMaster.forEach(function (item) { normalizeRecord(item, migratedAt); });
    parsed.sync = Object.assign({
      schemaVersion: SYNC_SCHEMA_VERSION,
      deviceId: createDeviceId(),
      lastSyncAt: '',
      lastCloudUpdatedAt: '',
      lastLocalBackupAt: '',
      lastDriveBackupAt: '',
      lastError: '',
      driveFolderId: '',
      driveFileId: '',
      settingsUpdatedAt: ''
    }, parsed.sync || {});
    parsed.sync.schemaVersion = SYNC_SCHEMA_VERSION;
    parsed.sync.deviceId = parsed.sync.deviceId || createDeviceId();
    parsed.version = 2;
    return parsed;
  }

  function ingredientIdFromMaster(master, name) {
    var key = normalize(name);
    var found = master.find(function (item) { return normalize(item.canonicalName) === key || (item.aliases || []).some(function (alias) { return normalize(alias) === key; }); });
    return found ? found.id : 'custom-' + key;
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && (parsed.version === 1 || parsed.version === 2)) {
          return normalizeState(parsed);
        }
      }
    } catch (error) {
      console.warn('Meal Note storage could not be read.', error);
    }
    var seed = normalizeState(createSeedState());
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(seed)); } catch (error) { /* private browsing may block storage */ }
    return seed;
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      document.getElementById('storageStatus').textContent = 'ローカル保存済み';
    } catch (error) {
      document.getElementById('storageStatus').textContent = '保存領域を確認';
      showToast('ブラウザの保存領域に書き込めませんでした。');
    }
  }

  function syncDataFrom(source) {
    var data = source || state;
    return {
      recipes: clone(data.recipes || []),
      ingredientMaster: clone(data.ingredientMaster || []),
      tags: clone(data.tags || []),
      mealPlans: clone(data.mealPlans || []),
      shoppingLists: clone(data.shoppingLists || []),
      pantryItems: clone(data.pantryItems || []),
      cookingHistory: clone(data.cookingHistory || []),
        importSources: clone(data.importSources || []),
        settings: clone(data.settings || {}),
        settingsUpdatedAt: data.sync && data.sync.settingsUpdatedAt ? data.sync.settingsUpdatedAt : ''
    };
  }

  function buildSyncSnapshot(source) {
    var data = source || state;
    return {
      schemaVersion: SYNC_SCHEMA_VERSION,
      syncVersion: 1,
      exportedAt: nowISO(),
      updatedAt: nowISO(),
      sourceDeviceId: data.sync && data.sync.deviceId ? data.sync.deviceId : state.sync.deviceId,
      data: syncDataFrom(data)
    };
  }

  function touchSettings() {
    state.sync.settingsUpdatedAt = nowISO();
  }

  function validateSyncSnapshot(payload) {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'JSONの形式がオブジェクトではありません。' };
    if (Number(payload.schemaVersion) !== SYNC_SCHEMA_VERSION) return { ok: false, reason: '対応していないschemaVersionです。' };
    if (!payload.data || typeof payload.data !== 'object') return { ok: false, reason: 'dataが見つかりません。' };
    var collections = ['recipes', 'ingredientMaster', 'tags', 'mealPlans', 'shoppingLists', 'pantryItems', 'cookingHistory', 'importSources'];
    for (var index = 0; index < collections.length; index += 1) {
      if (!Array.isArray(payload.data[collections[index]])) return { ok: false, reason: collections[index] + 'が配列ではありません。' };
    }
    if (!payload.data.settings || typeof payload.data.settings !== 'object' || Array.isArray(payload.data.settings)) return { ok: false, reason: 'settingsの形式が不正です。' };
    var serialized;
    try { serialized = JSON.stringify(payload); } catch (error) { return { ok: false, reason: 'JSONを読み込めませんでした。' }; }
    if (serialized.length > 5000000) return { ok: false, reason: 'JSONが大きすぎます。' };
    return { ok: true, snapshot: clone(payload) };
  }

  function dataTimestamp() {
    var date = new Date();
    var pad = function (value) { return String(value).padStart(2, '0'); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + '_' + pad(date.getHours()) + pad(date.getMinutes());
  }

  function downloadJSON(filename, payload) {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function shareSnapshot(snapshot) {
    var filename = 'meal-note-' + dataTimestamp() + '.json';
    var text = JSON.stringify(snapshot, null, 2);
    if (navigator.share && typeof File !== 'undefined') {
      var file = new File([text], filename, { type: 'application/json' });
      var canShare = !navigator.canShare || navigator.canShare({ files: [file] });
      if (canShare) {
        await navigator.share({ title: 'Meal Note バックアップ', text: 'Meal Noteのデータバックアップ', files: [file] });
        return;
      }
    }
    downloadJSON(filename, snapshot);
    showToast('共有機能に対応していないため、JSONをダウンロードしました。');
  }

  function saveLocalSnapshot() {
    var snapshot = buildSyncSnapshot();
    try {
      localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(snapshot));
      state.sync.lastLocalBackupAt = nowISO();
      state.sync.lastError = '';
      saveState();
      return snapshot;
    } catch (error) {
      state.sync.lastError = 'ローカルバックアップを保存できませんでした。';
      saveState();
      return null;
    }
  }

  function readLocalSnapshot() {
    try {
      var raw = localStorage.getItem(LOCAL_BACKUP_KEY);
      if (!raw) return null;
      var result = validateSyncSnapshot(JSON.parse(raw));
      return result.ok ? result.snapshot : null;
    } catch (error) {
      return null;
    }
  }

  function applyDataSnapshot(snapshot) {
    var currentSync = clone(state.sync || {});
    var imported = normalizeState(Object.assign({ version: 2 }, clone(snapshot.data)));
    imported.sync = Object.assign({}, currentSync, imported.sync || {}, { deviceId: currentSync.deviceId || createDeviceId(), lastError: '' });
    imported.sync.settingsUpdatedAt = snapshot.data.settingsUpdatedAt || currentSync.settingsUpdatedAt || '';
    state = imported;
    saveState();
    ui.pendingImport = null;
    ui.dataError = '';
  }

  function readSnapshotFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var result = validateSyncSnapshot(JSON.parse(String(reader.result || '')));
        if (!result.ok) { ui.dataError = result.reason; render(); return; }
        ui.pendingImport = result.snapshot;
        ui.dataError = '';
        location.hash = '#/more/data';
        render();
      } catch (error) {
        ui.dataError = 'JSONを読み込めませんでした。';
        render();
      }
    };
    reader.onerror = function () { ui.dataError = 'ファイルを読み込めませんでした。'; render(); };
    reader.readAsText(file);
  }

  function formatDateTime(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function dataRecordTimestamp(record) {
    return String(record && (record.updatedAt || record.createdAt || '') || '');
  }

  function mergeRecordArrays(localRecords, cloudRecords) {
    var result = [];
    var byId = {};
    (localRecords || []).concat(cloudRecords || []).forEach(function (record) {
      if (!record) return;
      var item = clone(record);
      if (!item.id) item.id = uid('imported');
      var existingIndex = byId[item.id];
      if (existingIndex == null) {
        byId[item.id] = result.length;
        result.push(item);
        return;
      }
      var existing = result[existingIndex];
      var currentTime = dataRecordTimestamp(existing);
      var incomingTime = dataRecordTimestamp(item);
      if (incomingTime > currentTime || (incomingTime === currentTime && JSON.stringify(item) > JSON.stringify(existing))) result[existingIndex] = item;
    });
    return result;
  }

  function mergeShoppingLists(localLists, cloudLists) {
    var merged = mergeRecordArrays(localLists, cloudLists);
    return merged.map(function (list) {
      var local = (localLists || []).find(function (item) { return item.id === list.id; });
      var cloud = (cloudLists || []).find(function (item) { return item.id === list.id; });
      list.items = mergeRecordArrays(local && local.items, cloud && cloud.items);
      return list;
    });
  }

  function mergeSnapshots(localSnapshot, cloudSnapshot) {
    var localData = localSnapshot.data || {};
    var cloudData = cloudSnapshot.data || {};
    var mergedSettingsTime = String(localData.settingsUpdatedAt || localSnapshot.updatedAt || '') >= String(cloudData.settingsUpdatedAt || cloudSnapshot.updatedAt || '')
      ? String(localData.settingsUpdatedAt || localSnapshot.updatedAt || '')
      : String(cloudData.settingsUpdatedAt || cloudSnapshot.updatedAt || '');
    return {
      schemaVersion: SYNC_SCHEMA_VERSION,
      syncVersion: Math.max(Number(localSnapshot.syncVersion || 0), Number(cloudSnapshot.syncVersion || 0)) + 1,
      updatedAt: nowISO(),
      sourceDeviceId: state.sync.deviceId,
      data: {
        recipes: mergeRecordArrays(localData.recipes, cloudData.recipes),
        ingredientMaster: mergeRecordArrays(localData.ingredientMaster, cloudData.ingredientMaster),
        tags: mergeRecordArrays(localData.tags, cloudData.tags),
        mealPlans: mergeRecordArrays(localData.mealPlans, cloudData.mealPlans),
        shoppingLists: mergeShoppingLists(localData.shoppingLists, cloudData.shoppingLists),
        pantryItems: mergeRecordArrays(localData.pantryItems, cloudData.pantryItems),
        cookingHistory: mergeRecordArrays(localData.cookingHistory, cloudData.cookingHistory),
        importSources: mergeRecordArrays(localData.importSources, cloudData.importSources),
        settings: String(localData.settingsUpdatedAt || localSnapshot.updatedAt || '') >= String(cloudData.settingsUpdatedAt || cloudSnapshot.updatedAt || '') ? clone(localData.settings) : clone(cloudData.settings),
        settingsUpdatedAt: mergedSettingsTime
      }
    };
  }

  function googleClientId() {
    return window.MEAL_NOTE_CONFIG && String(window.MEAL_NOTE_CONFIG.googleClientId || '').trim();
  }

  function waitForGoogleIdentity() {
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      var check = function () {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) { resolve(); return; }
        if (Date.now() - started > 6000) { reject(new Error('Google認証ライブラリを読み込めませんでした。通信状態を確認してください。')); return; }
        setTimeout(check, 200);
      };
      check();
    });
  }

  function getDriveAccessToken(interactive) {
    if (!googleClientId()) return Promise.reject(new Error('Google Client IDが未設定です。app-config.jsにWeb用Client IDを設定してください。'));
    if (driveRuntime.accessToken && driveRuntime.expiresAt > Date.now() + 30000) return Promise.resolve(driveRuntime.accessToken);
    return waitForGoogleIdentity().then(function () {
      return new Promise(function (resolve, reject) {
        driveRuntime.tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: googleClientId(),
          scope: 'https://www.googleapis.com/auth/drive.file',
          callback: function (response) {
            if (!response || response.error) {
              reject(new Error('Google認証に失敗しました。' + (response && response.error ? ' (' + response.error + ')' : '')));
              return;
            }
            driveRuntime.accessToken = response.access_token;
            driveRuntime.expiresAt = Date.now() + Number(response.expires_in || 3600) * 1000;
            driveRuntime.connected = true;
            resolve(driveRuntime.accessToken);
          }
        });
        try { driveRuntime.tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' }); } catch (error) { reject(error); }
      });
    });
  }

  function driveApi(path, options) {
    if (!driveRuntime.accessToken) return Promise.reject(new Error('Google Driveに接続されていません。'));
    var request = Object.assign({}, options || {});
    request.headers = Object.assign({}, request.headers || {}, { Authorization: 'Bearer ' + driveRuntime.accessToken });
    return fetch('https://www.googleapis.com/drive/v3/' + path, request).then(function (response) {
      return response.text().then(function (body) {
        var payload = null;
        try { payload = body ? JSON.parse(body) : null; } catch (error) { payload = null; }
        if (!response.ok) {
          if (response.status === 401) { driveRuntime.accessToken = ''; driveRuntime.expiresAt = 0; driveRuntime.connected = false; }
          var message = payload && payload.error && payload.error.message ? payload.error.message : 'Google Drive APIでエラーが発生しました。';
          var apiError = new Error(message);
          apiError.status = response.status;
          throw apiError;
        }
        return payload;
      });
    });
  }

  function driveUpload(fileId, content) {
    var request = {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + driveRuntime.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(content)
    };
    return fetch('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(fileId) + '?uploadType=media&fields=id,modifiedTime', request).then(function (response) {
      return response.text().then(function (body) {
        if (!response.ok) {
          if (response.status === 401) { driveRuntime.accessToken = ''; driveRuntime.expiresAt = 0; driveRuntime.connected = false; }
          var payload = null;
          try { payload = body ? JSON.parse(body) : null; } catch (error) { payload = null; }
          var message = payload && payload.error && payload.error.message ? payload.error.message : 'Google Driveへのアップロードに失敗しました。';
          var uploadError = new Error(message);
          uploadError.status = response.status;
          throw uploadError;
        }
        try { return body ? JSON.parse(body) : {}; } catch (error) { return {}; }
      });
    });
  }

  function findOrCreateDriveFolder() {
    var cachedId = state.sync.driveFolderId;
    var readCached = cachedId ? driveApi('files/' + encodeURIComponent(cachedId) + '?fields=id,name,mimeType,trashed') : Promise.resolve(null);
    return readCached.catch(function (error) {
      if (error.status === 404) return null;
      throw error;
    }).then(function (cached) {
      if (cached && !cached.trashed && cached.mimeType === 'application/vnd.google-apps.folder') return cached;
      var query = encodeURIComponent("name = 'Recipe App' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents");
      return driveApi('files?q=' + query + '&pageSize=20&orderBy=modifiedTime%20desc&fields=files(id,name,mimeType,modifiedTime)').then(function (result) {
        if (result.files && result.files.length) return result.files[0];
        return driveApi('files?fields=id,name,mimeType&alt=json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Recipe App', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }) });
      });
    }).then(function (folder) {
      state.sync.driveFolderId = folder.id;
      return folder;
    });
  }

  function findOrCreateSyncFile(folderId, createIfMissing) {
    var cachedId = state.sync.driveFileId;
    var readCached = cachedId ? driveApi('files/' + encodeURIComponent(cachedId) + '?fields=id,name,mimeType,trashed,parents') : Promise.resolve(null);
    return readCached.catch(function (error) {
      if (error.status === 404) return null;
      throw error;
    }).then(function (cached) {
      if (cached && !cached.trashed) return { file: cached, existed: true };
      var query = encodeURIComponent("name = 'recipe-app-sync.json' and trashed = false and '" + folderId + "' in parents");
      return driveApi('files?q=' + query + '&pageSize=20&orderBy=modifiedTime%20desc&fields=files(id,name,mimeType,modifiedTime,parents)').then(function (result) {
        if (result.files && result.files.length) return { file: result.files[0], existed: true };
        if (createIfMissing === false) return { file: null, existed: false };
        return driveApi('files?fields=id,name,mimeType,parents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'recipe-app-sync.json', mimeType: 'application/json', parents: [folderId] }) }).then(function (file) {
          return { file: file, existed: false };
        });
      });
    }).then(function (result) {
      if (result.file) state.sync.driveFileId = result.file.id;
      return result;
    });
  }

  function findOrCreateBackupFolder(folderId) {
    var query = encodeURIComponent("name = 'backups' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '" + folderId + "' in parents");
    return driveApi('files?q=' + query + '&pageSize=20&orderBy=modifiedTime%20desc&fields=files(id,name,mimeType,modifiedTime)').then(function (result) {
      if (result.files && result.files.length) return result.files[0];
      return driveApi('files?fields=id,name,mimeType,parents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'backups', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] }) });
    });
  }

  function fetchDriveSnapshot(fileId) {
    return driveApi('files/' + encodeURIComponent(fileId) + '?alt=media').then(function (payload) {
      var result = validateSyncSnapshot(payload);
      if (!result.ok) throw new Error('Drive上の同期ファイルが不正です。' + result.reason);
      return result.snapshot;
    });
  }

  function backupSnapshotToDrive(folderId, snapshot) {
    return findOrCreateBackupFolder(folderId).then(function (backupFolder) {
      var filename = dataTimestamp() + '.json';
      return driveApi('files?fields=id,name,mimeType,parents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: filename, mimeType: 'application/json', parents: [backupFolder.id] }) }).then(function (file) {
        return driveUpload(file.id, snapshot).then(function () {
          var retention = Math.max(1, Math.min(10, Number(state.settings.backupRetention || 5)));
          return driveApi('files?q=' + encodeURIComponent("'" + backupFolder.id + "' in parents and trashed = false and name contains '.json'") + '&pageSize=100&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime)').then(function (result) {
            var files = result.files || [];
            var oldFiles = files.slice(retention);
            if (!oldFiles.length || !confirm('Driveバックアップが' + files.length + '個あります。古い' + oldFiles.length + '個を削除して、最大' + retention + '個に整理しますか？')) return { file: file, pruned: false, count: files.length };
            return Promise.all(oldFiles.map(function (oldFile) { return driveApi('files/' + encodeURIComponent(oldFile.id), { method: 'DELETE' }); })).then(function () { return { file: file, pruned: true, count: retention }; });
          });
        });
      });
    });
  }

  function setDataError(message) {
    state.sync.lastError = message || '';
    saveState();
    ui.dataError = message || '';
  }

  async function connectDrive() {
    await getDriveAccessToken(true);
    state.sync.lastError = '';
    saveState();
    showToast('Google Driveに接続しました。');
  }

  async function syncDrive() {
    var localSnapshot = saveLocalSnapshot();
    if (!localSnapshot) throw new Error('同期前のローカルバックアップを作成できませんでした。');
    await getDriveAccessToken(false);
    var folder = await findOrCreateDriveFolder();
    var syncFile = await findOrCreateSyncFile(folder.id);
    var cloudSnapshot = syncFile.existed ? await fetchDriveSnapshot(syncFile.file.id) : null;
    var merged = cloudSnapshot ? mergeSnapshots(localSnapshot, cloudSnapshot) : localSnapshot;
    var valid = validateSyncSnapshot(merged);
    if (!valid.ok) throw new Error('統合後のデータ検証に失敗しました。' + valid.reason);
    await backupSnapshotToDrive(folder.id, merged);
    applyDataSnapshot(merged);
    state.sync.driveFolderId = folder.id;
    state.sync.driveFileId = syncFile.file.id;
    await driveUpload(syncFile.file.id, merged);
    state.sync.lastSyncAt = nowISO();
    state.sync.lastCloudUpdatedAt = merged.updatedAt;
    state.sync.lastError = '';
    saveState();
    showToast('Driveと同期しました。');
  }

  async function backupDrive() {
    var snapshot = saveLocalSnapshot();
    if (!snapshot) throw new Error('ローカルバックアップを作成できませんでした。');
    await getDriveAccessToken(false);
    var folder = await findOrCreateDriveFolder();
    var result = await backupSnapshotToDrive(folder.id, snapshot);
    state.sync.driveFolderId = folder.id;
    state.sync.lastDriveBackupAt = nowISO();
    state.sync.lastError = result.pruned ? '' : 'バックアップは作成しました。古いバックアップは未整理です。';
    saveState();
    showToast('Driveバックアップを作成しました。');
  }

  async function restoreDrive() {
    var localSnapshot = saveLocalSnapshot();
    if (!localSnapshot) throw new Error('復元前のローカルバックアップを作成できませんでした。');
    await getDriveAccessToken(false);
    var folder = await findOrCreateDriveFolder();
    var syncFile = await findOrCreateSyncFile(folder.id, false);
    if (!syncFile.existed || !syncFile.file) throw new Error('Drive上に同期ファイルがありません。先に同期を実行してください。');
    var snapshot = await fetchDriveSnapshot(syncFile.file.id);
    applyDataSnapshot(snapshot);
    state.sync.driveFolderId = folder.id;
    state.sync.driveFileId = syncFile.file.id;
    state.sync.lastCloudUpdatedAt = snapshot.updatedAt;
    state.sync.lastError = '';
    saveState();
    showToast('Driveのデータを復元しました。');
  }

  async function runDriveAction(action) {
    try {
      if (action === 'connect-drive') await connectDrive();
      if (action === 'sync-drive') await syncDrive();
      if (action === 'backup-drive') await backupDrive();
      if (action === 'restore-drive') await restoreDrive();
      ui.dataError = '';
    } catch (error) {
      var message = error && error.message ? error.message : 'Drive操作に失敗しました。';
      setDataError(message);
      showToast(message);
    }
    render();
  }

  function recipeById(id) {
    return state.recipes.find(function (recipe) { return recipe.id === id; });
  }

  function masterById(id) {
    return state.ingredientMaster.find(function (item) { return item.id === id; });
  }

  function recipeIngredientText(item, servings, originalServings) {
    if (item.quantity == null || !Number.isFinite(Number(item.quantity))) return item.originalText || item.displayName;
    var scale = Number(servings || originalServings) / Number(originalServings || 1);
    var quantity = Number(item.quantity) * scale;
    return formatQuantity(quantity) + (item.unit ? ' ' + item.unit : '') + ' ' + item.displayName;
  }

  function categoryForIngredient(item) {
    var master = masterById(item.ingredientId);
    return master ? master.category : 'その他';
  }

  function allTags() {
    var values = [];
    state.recipes.filter(function (recipe) { return !recipe.deletedAt; }).forEach(function (recipe) { (recipe.tags || []).forEach(function (tag) { if (values.indexOf(tag) === -1) values.push(tag); }); });
    return values.sort(function (a, b) { return a.localeCompare(b, 'ja'); });
  }

  function routePath() {
    var raw = location.hash.replace(/^#/, '') || '/recipes';
    return raw.split('?')[0] || '/recipes';
  }

  function routeParts() {
    return routePath().split('/').filter(Boolean);
  }

  function currentTopRoute() {
    var parts = routeParts();
    if (parts[0] === 'recipes') return 'recipes';
    if (parts[0] === 'meal-plan') return 'meal-plan';
    if (parts[0] === 'shopping') return 'shopping';
    if (parts[0] === 'more') return 'more';
    return 'recipes';
  }

  function applyTheme() {
    var preference = state.settings.theme || 'dark';
    var theme = preference;
    if (preference === 'system') theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
  }

  function updateNavigation() {
    var active = currentTopRoute();
    document.querySelectorAll('[data-nav-route]').forEach(function (link) {
      link.classList.toggle('active', link.dataset.navRoute === active);
    });
    var count = 0;
    state.shoppingLists.forEach(function (list) {
      if (list.deletedAt) return;
      (list.items || []).forEach(function (item) { if (!item.deletedAt && !item.checked && !item.excluded) count += 1; });
    });
    ['shoppingBadge', 'shoppingBadgeMobile'].forEach(function (id) {
      var badge = document.getElementById(id);
      if (badge) { badge.hidden = count === 0; badge.textContent = count > 99 ? '99+' : String(count); }
    });
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2600);
  }

  function htmlEmpty(title, body, action) {
    return '<div class="empty-state"><strong>' + escapeHTML(title) + '</strong><p>' + escapeHTML(body) + '</p>' + (action || '') + '</div>';
  }

  function render() {
    applyTheme();
    updateNavigation();
    var path = routePath();
    document.body.classList.toggle('cooking-active', path.indexOf('/cook') !== -1);
    if (path === '/recipes' || path === '/') view.innerHTML = renderRecipes();
    else if (path === '/recipes/new') view.innerHTML = renderRecipeForm(null);
    else if (path === '/recipes/import') view.innerHTML = ui.importDraft ? renderImportReview() : renderImportPage();
    else if (path.indexOf('/recipes/') === 0 && path.endsWith('/cook')) view.innerHTML = renderCooking(routeParts()[1]);
    else if (path.indexOf('/recipes/') === 0 && path.endsWith('/edit')) view.innerHTML = renderRecipeForm(routeParts()[1]);
    else if (path.indexOf('/recipes/') === 0) view.innerHTML = renderRecipeDetail(routeParts()[1]);
    else if (path === '/meal-plan') view.innerHTML = renderMealPlan();
    else if (path === '/shopping') view.innerHTML = renderShopping();
      else if (path === '/more') view.innerHTML = renderMore();
      else if (path === '/more/data') view.innerHTML = renderDataManagement();
      else if (path === '/more/tags') view.innerHTML = renderTags();
    else if (path === '/more/pantry') view.innerHTML = renderPantry();
    else if (path === '/more/settings') view.innerHTML = renderSettings();
    else view.innerHTML = renderRecipes();
    if (path.indexOf('/cook') !== -1) requestWakeLock();
  }

  window.addEventListener('hashchange', render);
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () { if (state.settings.theme === 'system') render(); });

  function recipeMatches(recipe) {
    if (recipe.deletedAt) return false;
    var search = normalize(ui.search);
    var haystack = normalize([
      recipe.title,
      recipe.description,
      recipe.category,
      (recipe.tags || []).join(' '),
      (recipe.ingredients || []).map(function (item) { return item.displayName + ' ' + item.originalText; }).join(' ')
    ].join(' '));
    if (search && haystack.indexOf(search) === -1) return false;
    if (ui.category !== 'すべて' && recipe.category !== ui.category) return false;
    if (ui.tag !== 'すべて' && (recipe.tags || []).indexOf(ui.tag) === -1) return false;
    if (ui.favoriteOnly && !recipe.favorite) return false;
    if (ui.maxTime && totalTime(recipe) > Number(ui.maxTime)) return false;
    return true;
  }

  function filteredRecipes() {
    var result = state.recipes.filter(recipeMatches);
    result.sort(function (a, b) {
      if (ui.sort === 'name') return a.title.localeCompare(b.title, 'ja');
      if (ui.sort === 'time') return totalTime(a) - totalTime(b);
      if (ui.sort === 'rating') return (averageRating(b.id) || 0) - (averageRating(a.id) || 0);
      if (ui.sort === 'cooked') return String(lastCooked(b.id) || '').localeCompare(String(lastCooked(a.id) || ''));
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    return result;
  }

  function selectOptions(items, current, includeAll) {
    var values = includeAll ? ['すべて'].concat(items) : items;
    return values.map(function (item) { return '<option value="' + escapeAttr(item) + '"' + (item === current ? ' selected' : '') + '>' + escapeHTML(item) + '</option>'; }).join('');
  }

  function renderRecipes() {
    var categories = ['主菜', '副菜', '主食', '汁物', 'おつまみ'];
    var recipes = filteredRecipes();
    var action = ui.selectionMode
      ? '<button class="button button-primary" type="button" data-action="bulk-shopping">選択したレシピから作成</button>'
      : '<button class="button" type="button" data-action="toggle-select-mode">複数選択</button>';
    var heading = '<div class="page-heading"><div><p class="eyebrow">Recipe library</p><h1>レシピ</h1><p>作ったもの、作りたいものを、すぐ見つけられる場所。</p></div><div class="heading-actions"><a class="button" href="#/recipes/import">URLから取り込む</a><a class="button button-primary" href="#/recipes/new"><span aria-hidden="true">＋</span> レシピを追加</a></div></div>';
    var filtersActive = Boolean(ui.search || ui.category !== 'すべて' || ui.tag !== 'すべて' || ui.favoriteOnly || ui.maxTime || ui.sort !== 'recent');
    var filterSummary = filtersActive ? '条件を設定中' : 'タップして検索・絞り込み';
    var toolbar = '<section class="panel toolbar-panel" aria-label="レシピの検索と絞り込み"><details class="filter-disclosure" ' + (filtersActive ? 'open' : '') + '><summary><span class="filter-summary-icon" aria-hidden="true">⌕</span><span><strong>検索・絞り込み</strong><small>' + filterSummary + '</small></span></summary><div class="filter-controls">' +
      '<div class="toolbar-row"><label class="search-field"><span aria-hidden="true">⌕</span><input data-filter-search type="search" value="' + escapeAttr(ui.search) + '" placeholder="レシピ名・材料・タグで検索" aria-label="レシピを検索"></label>' +
      '<label class="filter-label">カテゴリ<select data-filter="category" class="compact-field">' + selectOptions(categories, ui.category, true) + '</select></label>' +
      '<label class="filter-label">タグ<select data-filter="tag" class="compact-field">' + selectOptions(allTags(), ui.tag, true) + '</select></label></div>' +
      '<div class="toolbar-row"><label class="check-label"><input type="checkbox" data-filter="favorite" ' + (ui.favoriteOnly ? 'checked' : '') + '> お気に入りのみ</label>' +
      '<label class="filter-label">調理時間<select data-filter="max-time" class="compact-field"><option value=""' + (!ui.maxTime ? ' selected' : '') + '>制限なし</option><option value="15"' + (ui.maxTime === '15' ? ' selected' : '') + '>15分以内</option><option value="30"' + (ui.maxTime === '30' ? ' selected' : '') + '>30分以内</option><option value="60"' + (ui.maxTime === '60' ? ' selected' : '') + '>60分以内</option></select></label>' +
      '<label class="filter-label">並び順<select data-filter="sort" class="compact-field"><option value="recent"' + (ui.sort === 'recent' ? ' selected' : '') + '>最近追加</option><option value="name"' + (ui.sort === 'name' ? ' selected' : '') + '>名前順</option><option value="time"' + (ui.sort === 'time' ? ' selected' : '') + '>調理時間</option><option value="cooked"' + (ui.sort === 'cooked' ? ' selected' : '') + '>最近調理した順</option><option value="rating"' + (ui.sort === 'rating' ? ' selected' : '') + '>評価順</option></select></label></div></div></details>' +
      '<div class="toolbar-actions"><span class="results-meta">' + recipes.length + '件</span><span class="topbar-spacer"></span>' +
      '<div class="segmented" aria-label="表示形式"><button type="button" class="' + (state.settings.recipeView === 'list' ? 'active' : '') + '" data-action="set-recipe-view" data-view="list">☰ リスト</button><button type="button" class="' + (state.settings.recipeView === 'card' ? 'active' : '') + '" data-action="set-recipe-view" data-view="card">▦ カード</button></div>' +
      action + '</div></section>';
    var content = recipes.length ? (state.settings.recipeView === 'list' ? renderRecipeList(recipes) : renderRecipeCards(recipes)) : htmlEmpty('レシピが見つかりません', '検索条件をゆるめるか、新しいレシピを追加してください。', '<a class="button button-primary" href="#/recipes/new">レシピを追加</a>');
    return heading + toolbar + content;
  }

  function renderRecipeList(recipes) {
    var rows = recipes.map(function (recipe) {
      var selected = ui.selectedRecipes[recipe.id];
      var ingredients = (recipe.ingredients || []).slice(0, 4).map(function (item) { return item.displayName; }).join(' / ');
      return '<div class="recipe-row">' +
        (ui.selectionMode ? '<label class="check-label"><input type="checkbox" data-action="select-recipe" data-id="' + escapeAttr(recipe.id) + '" ' + (selected ? 'checked' : '') + '><span class="sr-only">選択</span></label>' : '') +
        '<div class="recipe-main"><span class="recipe-swatch" style="--swatch:' + escapeAttr(recipe.color || PALETTE[0]) + '"></span><div><a class="recipe-title" href="#/recipes/' + escapeAttr(recipe.id) + '">' + escapeHTML(recipe.title) + '</a><span class="recipe-sub">' + escapeHTML(ingredients || '材料未登録') + '</span></div></div>' +
        '<div class="recipe-category"><strong>' + escapeHTML(recipe.category || '未分類') + '</strong><span>' + escapeHTML((recipe.tags || []).slice(0, 2).join(' · ')) + '</span></div>' +
        '<div class="recipe-tags">' + escapeHTML(ingredients || '—') + '</div>' +
        '<div class="recipe-meta">' + escapeHTML(timeLabel(recipe)) + '<br><span>' + escapeHTML(recipe.originalServings + '人前') + '</span></div>' +
        '<div class="recipe-last"><span class="rating">' + (averageRating(recipe.id) ? '★ ' + averageRating(recipe.id).toFixed(1) : '☆ 未評価') + '</span><br>' + (lastCooked(recipe.id) ? '最終 ' + escapeHTML(formatDate(lastCooked(recipe.id))) : '未調理') + '</div>' +
        '<button class="favorite-button ' + (recipe.favorite ? 'is-favorite' : '') + '" type="button" data-action="favorite" data-id="' + escapeAttr(recipe.id) + '" aria-label="' + (recipe.favorite ? 'お気に入りを外す' : 'お気に入りに追加') + '">' + (recipe.favorite ? '★' : '☆') + '</button>' +
        '</div>';
    }).join('');
    return '<section class="panel recipe-list ' + (ui.selectionMode ? 'selection-list' : '') + '" aria-label="レシピ一覧"><div class="recipe-list-header">' + (ui.selectionMode ? '<span></span>' : '') + '<span>レシピ</span><span>カテゴリ</span><span>主な材料</span><span>時間 / 人数</span><span>評価 / 最終調理</span><span></span></div>' + rows + '</section>';
  }

  function renderRecipeCards(recipes) {
    var cards = recipes.map(function (recipe) {
      var summary = (recipe.ingredients || []).slice(0, 3).map(function (item) { return item.displayName; }).join(' / ');
      return '<article class="recipe-card"><div class="recipe-card-visual" style="--swatch:' + escapeAttr(recipe.color || PALETTE[0]) + '"><button class="favorite-button card-favorite ' + (recipe.favorite ? 'is-favorite' : '') + '" type="button" data-action="favorite" data-id="' + escapeAttr(recipe.id) + '" aria-label="' + (recipe.favorite ? 'お気に入りを外す' : 'お気に入りに追加') + '">' + (recipe.favorite ? '★' : '☆') + '</button></div><div class="recipe-card-body"><a href="#/recipes/' + escapeAttr(recipe.id) + '"><h3>' + escapeHTML(recipe.title) + '</h3></a><p>' + escapeHTML(recipe.description || summary || '材料未登録') + '</p><div class="recipe-card-meta"><span>' + escapeHTML(recipe.category || '未分類') + ' · ' + escapeHTML(timeLabel(recipe)) + '</span><span class="rating">' + (averageRating(recipe.id) ? '★ ' + averageRating(recipe.id).toFixed(1) : '☆') + '</span></div></div></article>';
    }).join('');
    return '<section class="recipe-cards" aria-label="レシピカード一覧">' + cards + '</section>';
  }

  function lastCooked(recipeId) {
    var history = state.cookingHistory.filter(function (item) { return !item.deletedAt && item.recipeId === recipeId; }).sort(function (a, b) { return String(b.cookedAt).localeCompare(String(a.cookedAt)); });
    return history[0] ? history[0].cookedAt.slice(0, 10) : '';
  }

  function averageRating(recipeId) {
    var ratings = state.cookingHistory.filter(function (item) { return !item.deletedAt && item.recipeId === recipeId && item.rating != null; }).map(function (item) { return Number(item.rating); });
    return ratings.length ? ratings.reduce(function (sum, value) { return sum + value; }, 0) / ratings.length : 0;
  }

  function formDraftFor(id) {
    var key = id || 'new';
    if (!ui.formDraft[key]) {
      var source = id ? recipeById(id) : null;
      ui.formDraft[key] = source ? clone(source) : {
        id: null,
        title: '',
        description: '',
        originalServings: 2,
        prepTimeMinutes: 10,
        cookTimeMinutes: 10,
        sourceType: 'manual',
        sourceUrl: '',
        favorite: false,
        category: '主菜',
        tags: [],
        ingredients: [defaultIngredient('', null, '', '', false)],
        steps: [{ id: uid('step'), stepNumber: 1, instruction: '', timerSeconds: null }],
        color: PALETTE[0]
      };
    }
    return ui.formDraft[key];
  }

  function renderRecipeForm(id) {
    var draft = formDraftFor(id);
    var ingredients = draft.ingredients || [];
    var steps = draft.steps || [];
    var tagText = (draft.tags || []).join(', ');
    var ingredientRows = ingredients.map(function (item, index) {
      return '<div class="repeat-row" data-ingredient-row data-index="' + index + '" data-id="' + escapeAttr(item.id || '') + '">' +
        '<input name="ingredient-name-' + index + '" value="' + escapeAttr(item.displayName) + '" placeholder="例：玉ねぎ" aria-label="材料名 ' + (index + 1) + '" required>' +
        '<input name="ingredient-quantity-' + index + '" value="' + (item.quantity == null ? '' : escapeAttr(item.quantity)) + '" type="number" step="0.01" min="0" placeholder="数量" aria-label="数量 ' + (index + 1) + '">' +
        '<input name="ingredient-unit-' + index + '" value="' + escapeAttr(item.unit || '') + '" placeholder="単位" aria-label="単位 ' + (index + 1) + '">' +
        '<input name="ingredient-note-' + index + '" value="' + escapeAttr(item.note || '') + '" placeholder="メモ・下処理" aria-label="材料メモ ' + (index + 1) + '">' +
        '<label class="check-label"><input name="ingredient-optional-' + index + '" type="checkbox" ' + (item.optional ? 'checked' : '') + '> 任意</label>' +
        '<button class="remove-button" type="button" data-action="remove-ingredient" data-index="' + index + '" aria-label="材料を削除">×</button></div>';
    }).join('');
    var stepRows = steps.map(function (item, index) {
      return '<div class="repeat-row step-row" data-step-row data-index="' + index + '"><span class="repeat-number">' + (index + 1) + '</span><textarea name="step-' + index + '" rows="2" placeholder="この工程で行うこと" aria-label="工程 ' + (index + 1) + '" required>' + escapeHTML(item.instruction || '') + '</textarea><button class="remove-button" type="button" data-action="remove-step" data-index="' + index + '" aria-label="工程を削除">×</button></div>';
    }).join('');
    return '<div class="form-heading"><div><p class="eyebrow">Recipe editor</p><h1>' + (id ? 'レシピを編集' : '新しいレシピ') + '</h1><p>材料と工程をあとから何度でも整えられます。</p></div></div>' +
      '<form class="form-layout" data-form="recipe" data-recipe-id="' + escapeAttr(id || '') + '">' +
      '<section class="panel form-panel"><div class="form-grid">' +
      '<div class="field full"><label for="recipe-title">レシピ名</label><input id="recipe-title" name="title" value="' + escapeAttr(draft.title) + '" placeholder="例：週末のトマト煮" required></div>' +
      '<div class="field full"><label for="recipe-description">説明・メモ</label><textarea id="recipe-description" name="description" placeholder="この料理のポイントや家族の好みなど">' + escapeHTML(draft.description || '') + '</textarea></div>' +
      '<div class="field"><label for="recipe-category">カテゴリ</label><select id="recipe-category" name="category">' + selectOptions(['主菜', '副菜', '主食', '汁物', 'おつまみ'], draft.category || '主菜', false) + '</select></div>' +
      '<div class="field"><label for="recipe-tags">タグ</label><input id="recipe-tags" name="tags" value="' + escapeAttr(tagText) + '" placeholder="和食, 時短"></div>' +
      '<div class="field"><label for="recipe-servings">元の人数</label><input id="recipe-servings" name="originalServings" type="number" min="1" step="1" value="' + escapeAttr(draft.originalServings || 2) + '"></div>' +
      '<div class="field"><label for="recipe-source">出典URL（任意）</label><input id="recipe-source" name="sourceUrl" type="url" value="' + escapeAttr(draft.sourceUrl || '') + '" placeholder="https://..."></div>' +
      '<div class="field"><label for="recipe-prep">下準備（分）</label><input id="recipe-prep" name="prepTimeMinutes" type="number" min="0" step="1" value="' + escapeAttr(draft.prepTimeMinutes || 0) + '"></div>' +
      '<div class="field"><label for="recipe-cook">加熱・調理（分）</label><input id="recipe-cook" name="cookTimeMinutes" type="number" min="0" step="1" value="' + escapeAttr(draft.cookTimeMinutes || 0) + '"></div>' +
      '</div></section>' +
      '<section class="panel form-panel"><div class="section-heading"><div><h2>材料</h2><p>数量が空欄の材料は、人数変更でもそのまま表示します。</p></div><button class="button button-small" type="button" data-action="add-ingredient">＋ 材料を追加</button></div><div class="repeatable">' + ingredientRows + '</div></section>' +
      '<section class="panel form-panel"><div class="section-heading"><div><h2>作り方</h2><p>調理中は工程ごとに進捗を確認できます。</p></div><button class="button button-small" type="button" data-action="add-step">＋ 工程を追加</button></div><div class="repeatable">' + stepRows + '</div></section>' +
      '<div class="form-actions"><a class="button button-quiet" href="#/recipes' + (id ? '/' + escapeAttr(id) : '') + '">キャンセル</a><button class="button button-primary" type="submit">保存する</button></div></form>';
  }

  function renderRecipeDetail(id) {
    var recipe = recipeById(id);
    if (!recipe || recipe.deletedAt) return htmlEmpty('レシピが見つかりません', '削除されたか、URLが正しくありません。', '<a class="button button-primary" href="#/recipes">レシピ一覧へ戻る</a>');
    var servings = ui.detailServings && ui.detailServings[id] ? ui.detailServings[id] : recipe.originalServings;
    var average = averageRating(id);
    var history = state.cookingHistory.filter(function (item) { return !item.deletedAt && item.recipeId === id; }).sort(function (a, b) { return String(b.cookedAt).localeCompare(String(a.cookedAt)); });
    var ingredientRows = (recipe.ingredients || []).map(function (item) {
      var quantityText = recipeIngredientText(item, servings, recipe.originalServings);
      if (item.displayName) quantityText = quantityText.replace(item.displayName, '').trim();
      return '<li class="ingredient-item"><span class="ingredient-quantity">' + escapeHTML(quantityText) + '</span><span class="ingredient-name">' + escapeHTML(item.displayName) + (item.optional ? ' <span class="optional-badge">任意</span>' : '') + (item.note ? '<span class="ingredient-note">' + escapeHTML(item.note) + '</span>' : '') + '</span></li>';
    }).join('');
    var stepRows = (recipe.steps || []).map(function (item, index) {
      return '<li class="step-item"><span class="step-number">' + (index + 1) + '</span><div class="step-instruction">' + escapeHTML(item.instruction) + (item.timerSeconds ? '<span class="pill">タイマー ' + Math.round(item.timerSeconds / 60) + '分</span>' : '') + '</div></li>';
    }).join('');
    var historyRows = history.slice(0, 5).map(function (item) {
      return '<div class="history-row"><div><strong>' + escapeHTML(formatDate(item.cookedAt.slice(0, 10))) + '</strong><small>' + escapeHTML(item.servings + '人前') + '</small>' + (item.note ? '<p>' + escapeHTML(item.note) + '</p>' : '') + '</div><span class="rating">' + (item.rating ? '★ ' + item.rating : '未評価') + '</span></div>';
    }).join('');
    return '<div class="page-heading"><div><a class="link" href="#/recipes">← レシピ一覧</a></div><div class="heading-actions"><a class="button" href="#/recipes/' + escapeAttr(id) + '/edit">編集</a><button class="button button-danger" type="button" data-action="delete-recipe" data-id="' + escapeAttr(id) + '">削除</button></div></div>' +
      '<div class="detail-layout"><div><section class="panel detail-hero"><div class="tag-list"><span class="pill">' + escapeHTML(recipe.category || '未分類') + '</span>' + (recipe.tags || []).map(function (tag) { return '<span class="pill">' + escapeHTML(tag) + '</span>'; }).join('') + '</div><h1>' + escapeHTML(recipe.title) + '</h1><p class="detail-description">' + escapeHTML(recipe.description || 'このレシピにはまだ説明がありません。') + '</p><div class="detail-actions"><button class="button button-primary" type="button" data-action="open-add-meal" data-recipe-id="' + escapeAttr(id) + '">献立に追加</button><a class="button" href="#/recipes/' + escapeAttr(id) + '/cook">調理モードを開始</a>' + (recipe.sourceUrl ? '<a class="button button-quiet" target="_blank" rel="noreferrer" href="' + escapeAttr(recipe.sourceUrl) + '">元ページを開く ↗</a>' : '') + '</div><div class="detail-stats"><div class="detail-stat"><small>調理時間</small><strong>' + escapeHTML(timeLabel(recipe)) + '</strong></div><div class="detail-stat"><small>元の人数</small><strong>' + escapeHTML(recipe.originalServings + '人前') + '</strong></div><div class="detail-stat"><small>評価</small><strong class="rating">' + (average ? '★ ' + average.toFixed(1) : '☆ —') + '</strong></div><div class="detail-stat"><small>お気に入り</small><strong><button class="favorite-button ' + (recipe.favorite ? 'is-favorite' : '') + '" type="button" data-action="favorite" data-id="' + escapeAttr(id) + '" aria-label="お気に入り">' + (recipe.favorite ? '★' : '☆') + '</button></strong></div></div></section>' +
      '<section class="panel detail-section"><div class="section-heading"><div><h2>材料</h2><p>人数に合わせて数量を計算表示しています。元データは変わりません。</p></div><div class="servings-control"><button type="button" data-action="adjust-servings" data-id="' + escapeAttr(id) + '" data-delta="-1" aria-label="人数を減らす">−</button><output>' + escapeHTML(servings) + '人前</output><button type="button" data-action="adjust-servings" data-id="' + escapeAttr(id) + '" data-delta="1" aria-label="人数を増やす">＋</button></div></div><ul class="ingredient-list">' + ingredientRows + '</ul></section>' +
      '<section class="panel detail-section"><div class="section-heading"><h2>作り方</h2></div><ol class="step-list">' + stepRows + '</ol></section></div>' +
      '<aside class="side-stack"><section class="panel"><div class="section-heading"><div><h3>調理履歴</h3><p>作った記録がここに残ります。</p></div></div><div class="history-stat-grid"><div class="history-stat"><strong>' + history.length + '</strong><small>調理回数</small></div><div class="history-stat"><strong>' + (lastCooked(id) ? formatDate(lastCooked(id)) : '—') + '</strong><small>最終調理</small></div><div class="history-stat"><strong>' + (average ? average.toFixed(1) : '—') + '</strong><small>平均評価</small></div></div>' + (historyRows ? '<div class="history-list" style="margin-top:14px">' + historyRows + '</div>' : '<p class="field-note" style="margin-top:16px">まだ調理履歴はありません。</p>') + '</section><section class="panel"><h3 style="margin:0 0 13px;font-size:14px">レシピ情報</h3><p class="field-note">登録日：' + escapeHTML(formatDate(String(recipe.createdAt).slice(0, 10))) + '</p><p class="field-note">更新日：' + escapeHTML(formatDate(String(recipe.updatedAt).slice(0, 10))) + '</p><p class="field-note">登録方法：' + (recipe.sourceType === 'json_ld' ? 'JSON-LDインポート' : '手動入力') + '</p></section></aside></div>';
  }

  function mealsFor(date, slot) {
    return state.mealPlans.filter(function (item) { return !item.deletedAt && item.date === date && (!slot || item.mealSlot === slot) && recipeById(item.recipeId) && !recipeById(item.recipeId).deletedAt; });
  }

  function renderMealPlan() {
    var start = weekStart(ui.weekOffset);
    var startISO = isoDate(start);
    var endISO = isoDate(addDays(start, 6));
    var days = WEEKDAYS.map(function (label, index) {
      var date = isoDate(addDays(start, index));
      var today = date === isoDate(new Date());
      var slots = SLOTS.map(function (slot) {
        var meals = mealsFor(date, slot.key);
        var chips = meals.map(function (meal) {
          var recipe = recipeById(meal.recipeId);
          if (!recipe) return '';
          return '<span class="meal-chip"><a href="#/recipes/' + escapeAttr(recipe.id) + '">' + escapeHTML(recipe.title) + '</a><small>' + escapeHTML(meal.servings + '人前') + '</small><button class="text-button danger" type="button" data-action="remove-meal" data-id="' + escapeAttr(meal.id) + '" aria-label="' + escapeAttr(recipe.title) + 'を献立から削除">×</button></span>';
        }).join('');
        return '<div class="meal-slot"><span class="meal-slot-label">' + slot.label + '</span><div class="meal-slot-content">' + (chips || '<span class="field-note">予定なし</span>') + '<button class="add-slot" type="button" data-action="open-add-meal" data-date="' + date + '" data-slot="' + slot.key + '">＋ 追加</button></div></div>';
      }).join('');
      return '<article class="day-card ' + (today ? 'today' : '') + '"><div class="day-heading"><strong>' + label + '</strong><time datetime="' + date + '">' + formatDate(date) + (today ? ' · 今日' : '') + '</time></div>' + slots + '</article>';
    }).join('');
    return '<div class="page-heading"><div><p class="eyebrow">Weekly plan</p><h1>献立</h1><p>一週間の流れを見ながら、空いている枠に料理を置いていきます。</p></div></div>' +
      '<div class="week-toolbar"><div class="week-controls"><button class="button button-small" type="button" data-action="week-prev">← 前の週</button><button class="button button-small" type="button" data-action="week-today">今週</button><button class="button button-small" type="button" data-action="week-next">次の週 →</button></div><span class="week-label">' + formatDate(startISO) + ' — ' + formatDate(endISO) + '</span><button class="button button-primary" type="button" data-action="generate-shopping" data-start="' + startISO + '" data-end="' + endISO + '">この週の買い物リストを作成</button></div>' +
      '<section class="week-grid" aria-label="週間献立">' + days + '</section>';
  }

  function listForCurrentWeek() {
    var start = isoDate(weekStart(ui.weekOffset));
    var end = isoDate(addDays(weekStart(ui.weekOffset), 6));
    return state.shoppingLists.find(function (list) { return !list.deletedAt && list.periodStart === start && list.periodEnd === end; });
  }

  function shoppingItemLabel(item) {
    return item.quantity == null ? (item.originalText || item.displayName) : formatQuantity(item.quantity) + (item.unit ? ' ' + item.unit : '');
  }

  function renderShopping() {
    var activeLists = state.shoppingLists.filter(function (item) { return !item.deletedAt; });
    var list = listForCurrentWeek() || activeLists[activeLists.length - 1];
    var items = list ? (list.items || []).filter(function (item) { return !item.deletedAt; }) : [];
    var visible = ui.showExcluded ? items : items.filter(function (item) { return !item.excluded; });
    var checked = visible.filter(function (item) { return item.checked; }).length;
    var content = '';
    if (!list) {
      content = htmlEmpty('買い物リストはまだありません', '献立を作成した週から、材料をまとめてリスト化できます。', '<a class="button button-primary" href="#/meal-plan">献立から作成する</a>');
    } else if (!visible.length) {
      content = htmlEmpty('買い物はすべて準備済み', '除外した項目も、必要になれば「除外を見る」から復元できます。', '');
    } else {
      content = ui.shoppingView === 'category' ? renderShoppingByCategory(visible, list) : renderShoppingByRecipe(visible, list);
    }
    return '<div class="page-heading"><div><p class="eyebrow">Shopping list</p><h1>買い物</h1><p>献立の材料を、売り場で迷わない形にまとめます。</p></div><div class="heading-actions"><button class="button" type="button" data-action="open-manual-shopping">＋ 手動で追加</button><button class="button button-primary" type="button" data-action="generate-shopping" data-start="' + isoDate(weekStart(ui.weekOffset)) + '" data-end="' + isoDate(addDays(weekStart(ui.weekOffset), 6)) + '">今週から再生成</button></div></div>' +
      '<div class="shopping-header"><span class="shopping-summary">' + (list ? escapeHTML(list.name) + ' · ' + checked + '/' + visible.length + '件チェック済み' : '献立から自動生成') + '</span><div class="segmented" aria-label="買い物リストの表示形式"><button type="button" class="' + (ui.shoppingView === 'category' ? 'active' : '') + '" data-action="set-shopping-view" data-view="category">売り場別</button><button type="button" class="' + (ui.shoppingView === 'recipe' ? 'active' : '') + '" data-action="set-shopping-view" data-view="recipe">レシピ別</button></div></div>' +
      (list ? '<div class="shopping-tools"><label class="check-label"><input type="checkbox" data-action="show-excluded" ' + (ui.showExcluded ? 'checked' : '') + '> 除外した項目も表示</label></div>' : '') + '<div id="shoppingContent">' + content + '</div>';
  }

  function renderShoppingByCategory(items, list) {
    var groups = {};
    items.forEach(function (item) { var key = item.category || 'その他'; if (!groups[key]) groups[key] = []; groups[key].push(item); });
    var order = SHOPPING_CATEGORIES.concat(Object.keys(groups).filter(function (key) { return SHOPPING_CATEGORIES.indexOf(key) === -1; }));
    var html = order.filter(function (category) { return groups[category] && groups[category].length; }).map(function (category) {
      return '<section class="panel shopping-group"><h3>' + escapeHTML(category) + '<span>' + groups[category].length + '品</span></h3>' + groups[category].map(function (item) { return renderShoppingItem(item, list); }).join('') + '</section>';
    }).join('');
    return '<div class="shopping-groups">' + html + '</div>';
  }

  function renderShoppingByRecipe(items, list) {
    var groups = {};
    items.forEach(function (item) { var key = item.sourceRecipes && item.sourceRecipes.length ? item.sourceRecipes.join('・') : '手動追加'; if (!groups[key]) groups[key] = []; groups[key].push(item); });
    return '<div class="shopping-groups">' + Object.keys(groups).map(function (name) { return '<section class="panel shopping-group"><h3>' + escapeHTML(name) + '<span>' + groups[name].length + '品</span></h3>' + groups[name].map(function (item) { return renderShoppingItem(item, list); }).join('') + '</section>'; }).join('') + '</div>';
  }

  function renderShoppingItem(item, list) {
      return '<div class="shopping-item ' + (item.checked ? 'checked' : '') + '"><input type="checkbox" data-action="toggle-shopping" data-list-id="' + escapeAttr(list.id) + '" data-id="' + escapeAttr(item.id) + '" ' + (item.checked ? 'checked' : '') + ' aria-label="' + escapeAttr(item.displayName) + '"><div class="shopping-name">' + escapeHTML(item.displayName) + (item.manualItem ? '<span class="pill" style="margin-left:6px">手動</span>' : '') + (item.excluded ? '<span class="pill" style="margin-left:6px">除外中</span>' : '') + '<span class="shopping-source">' + escapeHTML((item.sourceRecipes || []).join(' · ') || '手動追加') + '</span></div><span class="shopping-qty">' + escapeHTML(shoppingItemLabel(item)) + '</span><div class="shopping-actions"><button class="text-button" type="button" data-action="edit-shopping" data-list-id="' + escapeAttr(list.id) + '" data-id="' + escapeAttr(item.id) + '">編集</button><button class="text-button" type="button" data-action="toggle-excluded" data-list-id="' + escapeAttr(list.id) + '" data-id="' + escapeAttr(item.id) + '">' + (item.excluded ? '戻す' : '除外') + '</button><button class="text-button danger" type="button" data-action="delete-shopping" data-list-id="' + escapeAttr(list.id) + '" data-id="' + escapeAttr(item.id) + '">削除</button></div></div>';
  }

  function renderMore() {
    var cards = [
      ['#\/more\/tags', '⌁', 'タグ管理', '料理の分類や検索に使うタグを整えます。'],
      ['#\/more\/pantry', '＋', '常備品', '家にある調味料などを買い物から除外します。'],
      ['#\/more\/settings', '⚙', '設定', 'テーマや買い物リストの基本設定。'],
      ['#\/more\/data', '⇄', 'データ管理', 'JSONバックアップとGoogle Drive同期を管理します。'],
      ['#\/recipes\/import', '↥', 'インポート履歴', 'JSON-LDから取り込んだレシピを確認します。']
    ].map(function (item) { return '<a class="more-card" href="' + item[0] + '"><span class="more-card-icon" aria-hidden="true">' + item[1] + '</span><h2>' + item[2] + '</h2><p>' + item[3] + '</p></a>'; }).join('');
    return '<div class="page-heading"><div><p class="eyebrow">Workspace</p><h1>その他</h1><p>レシピの土台や、アプリの使い心地を整えます。</p></div></div><div class="more-grid">' + cards + '</div><section class="panel form-panel" style="margin-top:16px"><div class="section-heading"><div><h2>このアプリについて</h2><p>Meal Note はこのブラウザ内にデータを保存する個人用 PWA です。</p></div><span class="pill">MVP</span></div><p class="field-note">AI・アカウント・外部DBに依存せず、レシピ保存から献立、買い物、調理履歴までをひとつの流れで扱えます。</p></section>';
  }

  function renderDataManagement() {
    var configured = Boolean(googleClientId());
    var driveLabel = !configured ? '未設定' : (driveRuntime.connected ? '接続済み' : '未接続');
    var activeRecipes = state.recipes.filter(function (item) { return !item.deletedAt; }).length;
    var pending = ui.pendingImport;
    var pendingSummary = pending ? '<div class="data-preview"><strong>読み込み準備完了</strong><span>レシピ ' + pending.data.recipes.length + '件 · 献立 ' + pending.data.mealPlans.length + '件 · 買い物リスト ' + pending.data.shoppingLists.length + '件</span><div class="form-actions"><button class="button button-primary" type="button" data-action="apply-local-import">この内容で置き換える</button><button class="button" type="button" data-action="cancel-local-import">キャンセル</button></div></div>' : '';
     return '<div class="page-heading"><div><a class="link" href="#/more">← その他</a><p class="eyebrow" style="margin-top:15px">Data management</p><h1>データ管理</h1><p>通常の保存先はこの端末です。普段のバックアップ・端末移行はJSONの書き出しと共有を使います。</p></div></div>' +
       '<section class="panel form-panel"><div class="section-heading"><div><h2>バックアップ・データ移行</h2><p>レシピ・献立・買い物・調理履歴・設定をまとめて扱います。</p></div><span class="pill">' + activeRecipes + 'レシピ</span></div><div class="data-actions"><button class="button button-primary" type="button" data-action="download-data">JSONを書き出す</button><button class="button" type="button" data-action="share-local-data">バックアップを共有</button><button class="button" type="button" data-action="open-local-file">JSONを読み込む</button></div><input id="local-json-file" class="sr-only" type="file" accept="application/json,.json" data-file-input="local-json"><p class="field-note">スマホでは共有ボタンから、Google Drive・iCloud Drive・Filesなどへ保存できます。共有非対応の環境ではJSONダウンロードに切り替わります。</p>' + pendingSummary + '</section>' +
       '<section class="panel form-panel" style="margin-top:16px"><div class="section-heading"><div><h2>ローカルバックアップ</h2><p>読み込みや復元の前に、端末内の退避データを自動作成します。</p></div><span class="pill">' + escapeHTML(formatDateTime(state.sync.lastLocalBackupAt)) + '</span></div><div class="data-status-grid data-status-local"><div><small>端末内バックアップ</small><strong>' + escapeHTML(formatDateTime(state.sync.lastLocalBackupAt)) + '</strong></div><div><small>端末ID</small><strong>' + escapeHTML(String(state.sync.deviceId).slice(0, 8)) + '…</strong></div></div><div class="data-actions"><button class="button" type="button" data-action="backup-local">バックアップを更新</button><button class="button" type="button" data-action="restore-local-backup">バックアップ一覧</button></div></section>' +
       '<details class="panel advanced-sync" style="margin-top:16px"><summary><span><strong>高度な同期</strong><small>Google Drive API · ' + escapeHTML(driveLabel) + '</small></span><span class="pill">' + escapeHTML(driveLabel) + '</span></summary><div class="advanced-sync-body"><div class="section-heading"><div><h2>Google Drive</h2><p>現在は未設定・Deferredです。必要になった時だけ有効化できます。</p></div></div><div class="data-status-grid"><div><small>最終同期</small><strong>' + escapeHTML(formatDateTime(state.sync.lastSyncAt)) + '</strong></div><div><small>最終Driveバックアップ</small><strong>' + escapeHTML(formatDateTime(state.sync.lastDriveBackupAt)) + '</strong></div><div><small>設定状態</small><strong>' + (configured ? 'Client ID設定済み' : '未設定') + '</strong></div></div><div class="data-actions"><button class="button" type="button" data-action="connect-drive">Google Drive設定</button><button class="button" type="button" data-action="sync-drive">同期（統合して保存）</button><button class="button" type="button" data-action="backup-drive">Driveバックアップ</button><button class="button" type="button" data-action="restore-drive">Driveから復元</button></div><p class="field-note">同期は「Driveから取得 → レコード単位で統合 → 検証 → ローカル保存 → Drive更新」の順で行います。設定や個人的なメモも同期対象にできます。Google未設定のままでも、JSONバックアップ機能は通常どおり利用できます。</p>' + (state.sync.lastError || ui.dataError ? '<div class="notice error data-error">' + escapeHTML(ui.dataError || state.sync.lastError) + '</div>' : '') + '</div></details>' +
       '<section class="panel form-panel" style="margin-top:16px"><h2>保存範囲と安全性</h2><p class="field-note">JSONには、アプリのデータと設定が含まれます。通常の保存先はこの端末で、Google Drive API同期は任意の高度な機能です。Client Secretやアクセストークンはリポジトリ・localStorageへ保存しません。</p></section>';
  }

  function renderTags() {
    var tagCounts = {};
    state.recipes.filter(function (recipe) { return !recipe.deletedAt; }).forEach(function (recipe) { (recipe.tags || []).forEach(function (tag) { tagCounts[tag] = (tagCounts[tag] || 0) + 1; }); });
    var tags = Object.keys(tagCounts).sort(function (a, b) { return a.localeCompare(b, 'ja'); });
    var rows = tags.map(function (tag) { return '<div class="management-row"><div><strong>' + escapeHTML(tag) + '</strong><small>' + tagCounts[tag] + '件のレシピで使用中</small></div><div class="row-actions"><button class="text-button danger" type="button" data-action="remove-tag" data-tag="' + escapeAttr(tag) + '">削除</button></div></div>'; }).join('');
    return '<div class="page-heading"><div><a class="link" href="#/more">← その他</a><p class="eyebrow" style="margin-top:15px">Tags</p><h1>タグ管理</h1><p>レシピを横断して探すためのラベルです。</p></div></div><section class="panel form-panel"><form class="inline-form" data-form="tag"><input name="tag" placeholder="新しいタグ名" required><button class="button button-primary" type="submit">追加</button></form><div class="management-list">' + (rows || '<p class="field-note">まだタグがありません。</p>') + '</div></section>';
  }

  function renderPantry() {
    var pantryIds = state.pantryItems.filter(function (item) { return !item.deletedAt; }).map(function (item) { return item.ingredientId; });
    var rows = state.ingredientMaster.filter(function (item) { return !item.deletedAt; }).slice().sort(function (a, b) { return a.canonicalName.localeCompare(b.canonicalName, 'ja'); }).map(function (item) {
      var active = pantryIds.indexOf(item.id) !== -1;
      return '<div class="management-row"><div><strong>' + escapeHTML(item.canonicalName) + '</strong><small>' + escapeHTML(item.category) + (active ? ' · 買い物から除外' : '') + '</small></div><div class="row-actions"><label class="check-label"><input type="checkbox" data-action="toggle-pantry" data-ingredient-id="' + escapeAttr(item.id) + '" ' + (active ? 'checked' : '') + '> 常備</label></div></div>';
    }).join('');
    return '<div class="page-heading"><div><a class="link" href="#/more">← その他</a><p class="eyebrow" style="margin-top:15px">Pantry</p><h1>常備品</h1><p>家にいつもあるものを登録すると、買い物リスト生成時に初期状態で除外します。</p></div></div><section class="panel form-panel"><div class="notice">「常備品を買い物から除外」は設定でオフにできます。除外された項目はリスト上から完全には消えず、必要なら復元できます。</div><div class="management-list" style="margin-top:17px">' + rows + '</div></section>';
  }

  function renderSettings() {
    return '<div class="page-heading"><div><a class="link" href="#/more">← その他</a><p class="eyebrow" style="margin-top:15px">Settings</p><h1>設定</h1><p>見た目と、買い物リストのふるまいを変更できます。</p></div></div><section class="panel form-panel"><div class="form-grid"><div class="field"><label for="theme-setting">テーマ</label><select id="theme-setting" data-setting="theme"><option value="dark"' + (state.settings.theme === 'dark' ? ' selected' : '') + '>Dark（推奨）</option><option value="light"' + (state.settings.theme === 'light' ? ' selected' : '') + '>Light</option><option value="system"' + (state.settings.theme === 'system' ? ' selected' : '') + '>System</option></select><span class="field-note">設定はこのブラウザに保存されます。</span></div><div class="field"><label>買い物</label><label class="check-label"><input type="checkbox" data-setting="excludePantry" ' + (state.settings.excludePantry ? 'checked' : '') + '> 常備品を自動で除外する</label><span class="field-note">除外済みの品は、各リストから復元できます。</span></div><div class="field"><label for="backup-retention-setting">Driveバックアップ保持数</label><select id="backup-retention-setting" data-setting="backupRetention">' + [1, 3, 5, 7, 10].map(function (count) { return '<option value="' + count + '"' + (Number(state.settings.backupRetention || 5) === count ? ' selected' : '') + '>' + count + '個</option>'; }).join('') + '</select><span class="field-note">最大10個。古いバックアップを削除する前に確認します。</span></div></div></section><section class="panel form-panel" style="margin-top:16px"><div class="section-heading"><div><h2>サンプルデータ</h2><p>初回起動時と同じ10件のレシピに戻します。</p></div><button class="button button-danger" type="button" data-action="reset-data">サンプルデータを再読込</button></div><p class="field-note">この操作は現在のブラウザ内データを置き換えます。必要なデータがある場合は実行しないでください。</p></section>';
  }

  function renderImportPage() {
    return '<div class="page-heading"><div><a class="link" href="#/recipes">← レシピ一覧</a><p class="eyebrow" style="margin-top:15px">Import</p><h1>URLから取り込む</h1><p>Schema.org の JSON-LD Recipe を検出し、保存前に編集できます。</p></div></div><section class="panel form-panel"><div class="notice">外部サイトの読み込みはブラウザの CORS 制約を受けます。URL取得に失敗した場合は、ページの JSON-LD を貼り付けてレビューできます。</div><form class="form-layout" data-form="import" style="margin-top:17px"><div class="field"><label for="import-url">レシピページのURL</label><input id="import-url" name="url" type="url" placeholder="https://example.com/recipe"></div><div class="field"><label for="import-source">JSON-LD またはページHTML（任意）</label><textarea id="import-source" name="source" placeholder="script[type=&quot;application/ld+json&quot;] の内容、またはHTMLを貼り付け"></textarea><span class="field-note">URLと貼り付けの両方がある場合は、貼り付け内容を優先します。</span></div><div class="form-actions"><button class="button button-primary" type="submit">解析してレビュー</button></div></form>' + (ui.importError ? '<div class="notice error" style="margin-top:16px">' + escapeHTML(ui.importError) + '</div>' : '') + '</section>';
  }

  function renderImportReview() {
    var draft = ui.importDraft;
    var ingredients = draft.ingredients || [];
    var steps = draft.steps || [];
    var ingredientText = ingredients.map(function (item) { return item.originalText || item.displayName; }).join('\n');
    var stepText = steps.map(function (item) { return item.instruction; }).join('\n');
    return '<div class="page-heading"><div><a class="link" href="#/recipes/import">← インポート入力へ戻る</a><p class="eyebrow" style="margin-top:15px">Review before save</p><h1>取り込み内容を確認</h1><p>自動保存はされません。内容を整えてから保存してください。</p></div><div class="heading-actions"><button class="button" type="button" data-action="clear-import">破棄</button></div></div><section class="panel form-panel"><div class="notice">取得元：' + escapeHTML(draft.sourceUrl || '貼り付けデータ') + '<br>Recipe JSON-LD として検出しました。</div><form class="form-layout" data-form="import-review" style="margin-top:17px"><div class="import-review"><div class="form-grid"><div class="field full"><label for="review-title">レシピ名</label><input id="review-title" name="title" value="' + escapeAttr(draft.title) + '" required></div><div class="field full"><label for="review-description">説明</label><textarea id="review-description" name="description">' + escapeHTML(draft.description || '') + '</textarea></div><div class="field"><label for="review-category">カテゴリ</label><select id="review-category" name="category">' + selectOptions(['主菜', '副菜', '主食', '汁物', 'おつまみ'], draft.category || '主菜', false) + '</select></div><div class="field"><label for="review-servings">元の人数</label><input id="review-servings" name="originalServings" type="number" min="1" value="' + escapeAttr(draft.originalServings || 2) + '"></div><div class="field"><label for="review-prep">下準備（分）</label><input id="review-prep" name="prepTimeMinutes" type="number" min="0" value="' + escapeAttr(draft.prepTimeMinutes || 0) + '"></div><div class="field"><label for="review-cook">調理（分）</label><input id="review-cook" name="cookTimeMinutes" type="number" min="0" value="' + escapeAttr(draft.cookTimeMinutes || 0) + '"></div><div class="field full"><label for="review-tags">タグ（カンマ区切り）</label><input id="review-tags" name="tags" value="' + escapeAttr((draft.tags || []).join(', ')) + '"></div></div><div class="field"><label for="review-ingredients">材料（1行1材料）</label><textarea id="review-ingredients" name="ingredients" required>' + escapeHTML(ingredientText) + '</textarea><label for="review-steps" style="margin-top:12px">工程（1行1工程）</label><textarea id="review-steps" name="steps" required>' + escapeHTML(stepText) + '</textarea></div></div><div class="form-actions"><button class="button button-primary" type="submit">確認して保存</button></div></form></section>';
  }

  function cookSessionFor(id, recipe) {
    if (!ui.cookSessions[id]) {
      ui.cookSessions[id] = { servings: recipe.originalServings, checkedIngredients: {}, currentStep: 0 };
    }
    return ui.cookSessions[id];
  }

  function renderCooking(id) {
    var recipe = recipeById(id);
    if (!recipe || recipe.deletedAt) return htmlEmpty('レシピが見つかりません', '調理モードを開始できません。', '<a class="button button-primary" href="#/recipes">レシピ一覧へ戻る</a>');
    var session = cookSessionFor(id, recipe);
    var steps = recipe.steps || [];
    var current = Math.min(session.currentStep, Math.max(steps.length - 1, 0));
    var ingredients = (recipe.ingredients || []).map(function (item, index) {
      var checked = session.checkedIngredients[index];
      return '<button class="cook-ingredient ' + (checked ? 'checked' : '') + '" type="button" data-action="toggle-cook-ingredient" data-recipe-id="' + escapeAttr(id) + '" data-index="' + index + '"><span class="cook-check" aria-hidden="true">' + (checked ? '✓' : '') + '</span><span>' + escapeHTML(item.displayName) + '</span><span class="cook-ingredient-qty">' + escapeHTML(recipeIngredientText(item, session.servings, recipe.originalServings).replace(item.displayName, '').trim()) + '</span></button>';
    }).join('');
    var stepRows = steps.map(function (step, index) {
      var done = index < current;
      return '<div class="cook-step ' + (index === current ? 'current ' : '') + (done ? 'done' : '') + '"><span class="cook-step-index">' + (done ? '✓' : index + 1) + '</span><div class="cook-step-text">' + escapeHTML(step.instruction) + '</div></div>';
    }).join('');
    var completion = current >= Math.max(steps.length - 1, 0) ? '<div class="cook-complete panel"><h2>料理ができたら</h2><form data-form="cook-complete"><div class="form-grid"><div class="field"><label for="cook-rating">評価</label><select id="cook-rating" name="rating"><option value="">評価しない</option><option value="5">★★★★★ 5</option><option value="4">★★★★ 4</option><option value="3">★★★ 3</option><option value="2">★★ 2</option><option value="1">★ 1</option></select></div><div class="field full"><label for="cook-note">メモ</label><textarea id="cook-note" name="note" placeholder="次回はこうしたい、家族の反応など"></textarea></div></div><div class="form-actions"><button class="button button-primary" type="submit">調理履歴に保存</button></div></form></div>' : '';
    return '<div class="cook-shell"><div class="cook-topbar"><a href="#/recipes/' + escapeAttr(id) + '">← レシピ詳細へ戻る</a><span class="pill">調理モード</span></div><div class="cook-hero"><p class="eyebrow">Cooking mode</p><h1>' + escapeHTML(recipe.title) + '</h1><p>' + escapeHTML(session.servings + '人前 · ' + timeLabel(recipe)) + ' ／ 材料をタップするとチェックできます。</p></div><div class="cook-grid"><section class="panel cook-panel"><h2>材料</h2><div>' + ingredients + '</div></section><section class="panel cook-panel"><h2>工程</h2><div>' + (stepRows || '<p class="field-note">工程が登録されていません。</p>') + '</div><div class="cook-controls"><span class="cook-progress">' + (steps.length ? (current + 1) + ' / ' + steps.length + ' 工程' : '工程なし') + '</span><div><button class="button button-small" type="button" data-action="cook-prev" data-recipe-id="' + escapeAttr(id) + '" ' + (current <= 0 ? 'disabled' : '') + '>← 戻る</button> <button class="button button-small button-primary" type="button" data-action="cook-next" data-recipe-id="' + escapeAttr(id) + '" ' + (current >= steps.length - 1 ? 'disabled' : '') + '>次へ →</button></div></div></section></div>' + completion + '</div>';
  }

  function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      wakeLock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { /* non-supporting browsers simply keep normal screen behavior */ });
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }

  function openModal(content) {
    modal.innerHTML = content;
    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.setAttribute('open', '');
  }

  function closeModal() {
    if (typeof modal.close === 'function' && modal.open) modal.close();
    else modal.removeAttribute('open');
  }

  function renderAddMealModal(recipeId, date, slot) {
    var recipes = state.recipes.filter(function (recipe) { return !recipe.deletedAt; }).slice().sort(function (a, b) { return a.title.localeCompare(b.title, 'ja'); });
    var defaultDate = date || isoDate(weekStart(ui.weekOffset));
    var selectedRecipe = recipeById(recipeId);
    return '<div class="modal-inner"><div class="modal-header"><div><h2 id="modalTitle">献立に追加</h2><p>食べる日と時間帯、人数を設定します。</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="閉じる">×</button></div><form data-form="add-meal"><div class="form-grid"><div class="field"><label for="meal-date">日付</label><input id="meal-date" name="date" type="date" value="' + escapeAttr(defaultDate) + '" required></div><div class="field"><label for="meal-slot">時間帯</label><select id="meal-slot" name="slot">' + SLOTS.map(function (item) { return '<option value="' + item.key + '"' + (item.key === (slot || 'dinner') ? ' selected' : '') + '>' + item.label + '</option>'; }).join('') + '</select></div><div class="field full"><label for="meal-recipe">レシピ</label><select id="meal-recipe" name="recipeId" required><option value="">レシピを選択</option>' + recipes.map(function (item) { return '<option value="' + escapeAttr(item.id) + '"' + (selectedRecipe && item.id === selectedRecipe.id ? ' selected' : '') + '>' + escapeHTML(item.title) + '</option>'; }).join('') + '</select></div><div class="field"><label for="meal-servings">人数</label><input id="meal-servings" name="servings" type="number" min="1" step="1" value="' + escapeAttr(selectedRecipe ? selectedRecipe.originalServings : 2) + '"></div><div class="field"><label for="meal-note">メモ</label><input id="meal-note" name="note" placeholder="例：副菜を追加"></div></div><div class="form-actions"><button class="button button-quiet" type="button" data-action="close-modal">キャンセル</button><button class="button button-primary" type="submit">献立に追加</button></div></form></div>';
  }

  function renderManualShoppingModal(item, list) {
    var editing = Boolean(item);
    return '<div class="modal-inner"><div class="modal-header"><div><h2 id="modalTitle">' + (editing ? '買い物項目を編集' : '買い物項目を追加') + '</h2><p>買い物リストに手動項目を登録します。</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="閉じる">×</button></div><form data-form="shopping-item" data-list-id="' + escapeAttr(list ? list.id : '') + '" data-item-id="' + escapeAttr(item ? item.id : '') + '"><div class="form-grid"><div class="field full"><label for="shopping-name">品名</label><input id="shopping-name" name="displayName" value="' + escapeAttr(item ? item.displayName : '') + '" placeholder="例：ヨーグルト" required></div><div class="field"><label for="shopping-quantity">数量</label><input id="shopping-quantity" name="quantity" type="number" min="0" step="0.01" value="' + (item && item.quantity != null ? escapeAttr(item.quantity) : '') + '" placeholder="任意"></div><div class="field"><label for="shopping-unit">単位</label><input id="shopping-unit" name="unit" value="' + escapeAttr(item ? item.unit : '') + '" placeholder="個 / g / 本"></div><div class="field"><label for="shopping-category">売り場</label><select id="shopping-category" name="category">' + selectOptions(SHOPPING_CATEGORIES, item ? item.category : 'その他', false) + '</select></div></div><div class="form-actions"><button class="button button-quiet" type="button" data-action="close-modal">キャンセル</button><button class="button button-primary" type="submit">保存する</button></div></form></div>';
  }

  function listForId(id) {
    return state.shoppingLists.find(function (list) { return list.id === id; });
  }

  function itemForList(list, id) {
    return list && (list.items || []).find(function (item) { return item.id === id; });
  }

  function selectedRecipeIds() {
    return Object.keys(ui.selectedRecipes).filter(function (id) { return ui.selectedRecipes[id]; });
  }

  function ingredientAggregationKey(item) {
    return (item.ingredientId || 'custom-' + normalize(item.displayName)) + '|' + normalize(item.unit || '');
  }

  function syncShoppingListForDate(date) {
    if (!date) return null;
    var targetDate = dateFromISO(date);
    var start = isoDate(mondayOf(targetDate));
    var end = isoDate(addDays(mondayOf(targetDate), 6));
    var existing = state.shoppingLists.find(function (list) { return list.periodStart === start && list.periodEnd === end; });
    var hasMeals = state.mealPlans.some(function (meal) { return !meal.deletedAt && meal.date >= start && meal.date <= end && recipeById(meal.recipeId) && !recipeById(meal.recipeId).deletedAt; });
    if (!hasMeals) {
      if (existing) {
        var clearedAt = nowISO();
        (existing.items || []).forEach(function (item) { if (!item.manualItem && !item.deletedAt) { item.deletedAt = clearedAt; item.updatedAt = clearedAt; } });
        existing.updatedAt = clearedAt;
        saveState();
      }
      return existing || null;
    }
    return makeShoppingList(start, end, null, { silent: true });
  }

  function makeShoppingList(start, end, recipeIds, options) {
    options = options || {};
    var plans = recipeIds
      ? recipeIds.map(function (recipeId) {
        var selectedRecipe = recipeById(recipeId);
        return selectedRecipe ? { recipeId: selectedRecipe.id, servings: selectedRecipe.originalServings } : null;
      }).filter(Boolean)
      : state.mealPlans.filter(function (meal) { return !meal.deletedAt && meal.date >= start && meal.date <= end && recipeById(meal.recipeId) && !recipeById(meal.recipeId).deletedAt; });
    if (!plans.length) {
      if (!options.silent) showToast('この範囲に献立がありません。先にレシピを追加してください。');
      return null;
    }
    var existing = state.shoppingLists.find(function (list) { return list.periodStart === start && list.periodEnd === end; });
    var oldManual = existing ? (existing.items || []).filter(function (item) { return item.manualItem; }) : [];
    var grouped = {};
    plans.forEach(function (meal) {
      var recipe = recipeById(meal.recipeId);
      if (!recipe) return;
      (recipe.ingredients || []).forEach(function (ingredient) {
        var key = ingredientAggregationKey(ingredient);
        var quantity = ingredient.quantity == null ? null : Number(ingredient.quantity) * (Number(meal.servings || recipe.originalServings) / Number(recipe.originalServings || 1));
        var category = categoryForIngredient(ingredient);
        if (!grouped[key]) {
          grouped[key] = {
            id: uid('shop'),
            ingredientId: ingredient.ingredientId,
            displayName: ingredient.displayName,
            quantity: quantity,
            unit: ingredient.unit || '',
            originalText: ingredient.originalText || ingredient.displayName,
            category: category,
            checked: false,
            excluded: false,
            manualItem: false,
            sourceRecipes: [recipe.title],
            createdAt: nowISO(),
            updatedAt: nowISO(),
            deletedAt: null
          };
        } else {
          if (grouped[key].quantity != null && quantity != null) grouped[key].quantity += quantity;
          if (grouped[key].sourceRecipes.indexOf(recipe.title) === -1) grouped[key].sourceRecipes.push(recipe.title);
        }
      });
    });
    var items = Object.keys(grouped).map(function (key) {
      var next = grouped[key];
      var old = existing && (existing.items || []).find(function (item) { return !item.manualItem && ingredientAggregationKey(item) === key; });
      if (old) { next.id = old.id; next.createdAt = old.createdAt || next.createdAt; next.checked = old.checked; next.excluded = old.excluded; }
      next.updatedAt = nowISO();
      var pantry = state.pantryItems.some(function (item) { return !item.deletedAt && item.ingredientId === next.ingredientId && item.alwaysAvailable; });
      if (state.settings.excludePantry && pantry && !old) next.excluded = true;
      return next;
    }).concat(oldManual);
    if (existing) {
      (existing.items || []).filter(function (item) { return !item.manualItem && !item.deletedAt && !items.some(function (next) { return next.id === item.id; }); }).forEach(function (item) {
        var tombstone = clone(item);
        tombstone.deletedAt = nowISO();
        tombstone.updatedAt = tombstone.deletedAt;
        items.push(tombstone);
      });
    }
    var list = existing || { id: uid('list'), name: '買い物 · ' + formatDate(start) + '—' + formatDate(end), periodStart: start, periodEnd: end, status: 'open', createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null, items: [] };
    list.items = items;
    list.updatedAt = nowISO();
    if (!existing) state.shoppingLists.push(list);
    saveState();
    if (!options.silent) showToast(items.filter(function (item) { return !item.excluded; }).length + '品を買い物リストにまとめました。');
    return list;
  }

  function syncRecipeFormDraft(form) {
    var id = form.dataset.recipeId || null;
    var draft = formDraftFor(id);
    var formData = new FormData(form);
    draft.title = String(formData.get('title') || '').trim();
    draft.description = String(formData.get('description') || '').trim();
    draft.category = String(formData.get('category') || '主菜');
    draft.originalServings = Math.max(1, Number(formData.get('originalServings') || 1));
    draft.prepTimeMinutes = Math.max(0, Number(formData.get('prepTimeMinutes') || 0));
    draft.cookTimeMinutes = Math.max(0, Number(formData.get('cookTimeMinutes') || 0));
    draft.sourceUrl = String(formData.get('sourceUrl') || '').trim();
    draft.tags = String(formData.get('tags') || '').split(',').map(function (tag) { return tag.trim(); }).filter(Boolean);
    draft.ingredients = Array.from(form.querySelectorAll('[data-ingredient-row]')).map(function (row) {
      var name = row.querySelector('[name^="ingredient-name-"]').value.trim();
      var quantityValue = row.querySelector('[name^="ingredient-quantity-"]').value;
      var unit = row.querySelector('[name^="ingredient-unit-"]').value.trim();
      var note = row.querySelector('[name^="ingredient-note-"]').value.trim();
      var optional = row.querySelector('[name^="ingredient-optional-"]');
      return { id: row.dataset.id || uid('ri'), ingredientId: name ? ensureIngredientMaster(name, '', unit) : 'custom-', displayName: name, quantity: quantityValue === '' ? null : Number(quantityValue), unit: unit, originalText: quantityValue === '' ? name : formatQuantity(quantityValue) + (unit ? ' ' + unit : '') + ' ' + name, optional: optional ? optional.checked : false, note: note };
    }).filter(function (item) { return item.displayName; });
    draft.steps = Array.from(form.querySelectorAll('[data-step-row]')).map(function (row) {
      return { id: row.dataset.id || uid('step'), stepNumber: 0, instruction: row.querySelector('textarea').value.trim(), timerSeconds: null };
    }).filter(function (item) { return item.instruction; }).map(function (item, index) { item.stepNumber = index + 1; return item; });
    return draft;
  }

  function saveRecipeDraft(draft, id) {
    if (!draft.title) { showToast('レシピ名を入力してください。'); return null; }
    if (!draft.ingredients.length) { showToast('材料を1つ以上入力してください。'); return null; }
    if (!draft.steps.length) { showToast('工程を1つ以上入力してください。'); return null; }
    var isNew = !id;
    draft.updatedAt = nowISO();
    draft.deletedAt = null;
    if (id) {
      var target = recipeById(id);
      if (target) Object.assign(target, draft);
    } else {
      draft.id = uid('recipe');
      draft.createdAt = nowISO();
      if (!draft.color) draft.color = PALETTE[state.recipes.length % PALETTE.length];
      state.recipes.unshift(draft);
    }
    if (isNew && draft.sourceType === 'json_ld') {
      state.importSources.push({
        id: uid('import'),
        recipeId: draft.id,
        type: 'web',
        url: draft.sourceUrl || '',
        originalTitle: draft.title,
        importMethod: 'json_ld',
        rawMetadata: draft.rawMetadata || null,
         createdAt: nowISO(),
         updatedAt: nowISO(),
         deletedAt: null
      });
    }
    draft.tags.forEach(function (tag) {
       if (!state.tags.some(function (item) { return !item.deletedAt && item.name === tag; })) state.tags.push({ id: uid('tag'), name: tag, type: 'tag', createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null });
    });
    saveState();
    delete ui.formDraft[id || 'new'];
    showToast('レシピを保存しました。');
    location.hash = '#/recipes/' + draft.id;
    return draft;
  }

  function handleClick(event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.dataset.action;
    if (action === 'download-data') {
      downloadJSON('meal-note-' + dataTimestamp() + '.json', buildSyncSnapshot());
      showToast('JSONを書き出しました。');
      return;
    }
    if (action === 'open-local-file') {
      var fileInput = document.getElementById('local-json-file');
      if (fileInput) fileInput.click();
      return;
    }
    if (action === 'backup-local') {
      if (saveLocalSnapshot()) showToast('端末内バックアップを更新しました。');
      render();
      return;
    }
    if (action === 'restore-local-backup') {
      var localBackup = readLocalSnapshot();
      if (!localBackup) { setDataError('端末内バックアップが見つからないか、形式が不正です。'); render(); return; }
      ui.pendingImport = localBackup;
      ui.dataError = '';
      showToast('バックアップを確認してから適用してください。');
      render();
      return;
    }
    if (action === 'apply-local-import') {
      if (!ui.pendingImport) return;
      if (!confirm('現在のローカルデータを読み込み内容で置き換えますか？置き換え前のバックアップは自動保存されます。')) return;
      if (!saveLocalSnapshot()) return;
      applyDataSnapshot(ui.pendingImport);
      showToast('ローカルデータを復元しました。');
      render();
      return;
    }
    if (action === 'cancel-local-import') {
      ui.pendingImport = null;
      ui.dataError = '';
      render();
      return;
    }
    if (action === 'share-local-data') {
      shareSnapshot(buildSyncSnapshot()).then(function () { showToast('データを共有しました。'); }).catch(function (error) {
        if (error && error.name === 'AbortError') return;
        showToast('共有できなかったため、JSONをダウンロードします。');
        downloadJSON('meal-note-' + dataTimestamp() + '.json', buildSyncSnapshot());
      });
      return;
    }
    if (action === 'connect-drive' || action === 'sync-drive' || action === 'backup-drive') {
      runDriveAction(action);
      return;
    }
    if (action === 'restore-drive') {
      if (!confirm('Driveの同期データで現在のローカルデータを置き換えますか？置き換え前のバックアップは自動保存されます。')) return;
      runDriveAction(action);
      return;
    }
    if (action === 'toggle-theme') {
      state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light';
      touchSettings();
      saveState();
      render();
      return;
    }
    if (action === 'set-recipe-view') {
      state.settings.recipeView = target.dataset.view;
      touchSettings();
      saveState();
      render();
      return;
    }
    if (action === 'favorite') {
      var favoriteRecipe = recipeById(target.dataset.id);
      if (favoriteRecipe) { favoriteRecipe.favorite = !favoriteRecipe.favorite; favoriteRecipe.updatedAt = nowISO(); saveState(); render(); }
      return;
    }
    if (action === 'toggle-select-mode') {
      ui.selectionMode = !ui.selectionMode;
      if (!ui.selectionMode) ui.selectedRecipes = {};
      render();
      return;
    }
    if (action === 'select-recipe') {
      ui.selectedRecipes[target.dataset.id] = target.checked;
      return;
    }
    if (action === 'bulk-shopping') {
      var selected = selectedRecipeIds();
      if (!selected.length) { showToast('レシピを1つ以上選択してください。'); return; }
      var start = isoDate(weekStart(ui.weekOffset));
      var end = isoDate(addDays(weekStart(ui.weekOffset), 6));
      var list = makeShoppingList(start, end, selected);
      if (list) { ui.selectionMode = false; ui.selectedRecipes = {}; location.hash = '#/shopping'; }
      return;
    }
    if (action === 'adjust-servings') {
      ui.detailServings = ui.detailServings || {};
      var recipe = recipeById(target.dataset.id);
      if (recipe) { ui.detailServings[recipe.id] = Math.max(1, Number(ui.detailServings[recipe.id] || recipe.originalServings) + Number(target.dataset.delta)); render(); }
      return;
    }
    if (action === 'delete-recipe') {
      if (!confirm('このレシピを削除しますか？献立と調理履歴からも参照できなくなります。')) return;
      var removeId = target.dataset.id;
      var affectedMealDates = state.mealPlans.filter(function (item) { return item.recipeId === removeId; }).map(function (item) { return item.date; });
      state.recipes.forEach(function (item) { if (item.id === removeId) { item.deletedAt = nowISO(); item.updatedAt = item.deletedAt; } });
      state.mealPlans.forEach(function (item) { if (item.recipeId === removeId) { item.deletedAt = nowISO(); item.updatedAt = item.deletedAt; } });
      state.cookingHistory.forEach(function (item) { if (item.recipeId === removeId) { item.deletedAt = nowISO(); item.updatedAt = item.deletedAt; } });
      affectedMealDates.filter(function (date, index) { return affectedMealDates.indexOf(date) === index; }).forEach(syncShoppingListForDate);
      saveState();
      showToast('レシピを削除しました。');
      location.hash = '#/recipes';
      return;
    }
    if (action === 'open-add-meal') {
      openModal(renderAddMealModal(target.dataset.recipeId || '', target.dataset.date || '', target.dataset.slot || 'dinner'));
      return;
    }
    if (action === 'close-modal') { closeModal(); return; }
    if (action === 'week-prev') { ui.weekOffset -= 1; render(); return; }
    if (action === 'week-next') { ui.weekOffset += 1; render(); return; }
    if (action === 'week-today') { ui.weekOffset = 0; render(); return; }
    if (action === 'remove-meal') {
      var removedMeal = state.mealPlans.find(function (item) { return item.id === target.dataset.id; });
      if (removedMeal) { removedMeal.deletedAt = nowISO(); removedMeal.updatedAt = removedMeal.deletedAt; }
      if (removedMeal) syncShoppingListForDate(removedMeal.date);
      saveState();
      showToast('献立から外し、買い物リストを更新しました。');
      render();
      return;
    }
    if (action === 'generate-shopping') {
      var generated = makeShoppingList(target.dataset.start, target.dataset.end);
      if (generated && routePath() !== '/shopping') location.hash = '#/shopping';
      else render();
      return;
    }
     if (action === 'set-shopping-view') {
       ui.shoppingView = target.dataset.view;
       state.settings.shoppingView = ui.shoppingView;
       touchSettings();
       saveState();
      render();
      return;
    }
    if (action === 'show-excluded') {
      ui.showExcluded = target.checked;
      render();
      return;
    }
    if (action === 'toggle-shopping') {
      var list = listForId(target.dataset.listId);
      var shoppingItem = itemForList(list, target.dataset.id);
       if (shoppingItem) { shoppingItem.checked = target.checked; shoppingItem.updatedAt = nowISO(); list.updatedAt = shoppingItem.updatedAt; saveState(); render(); }
      return;
    }
    if (action === 'toggle-pantry') {
      var pantryId = target.dataset.ingredientId;
      var pantryIndex = state.pantryItems.findIndex(function (item) { return !item.deletedAt && item.ingredientId === pantryId; });
      var deletedPantry = state.pantryItems.find(function (item) { return item.deletedAt && item.ingredientId === pantryId; });
      if (target.checked && pantryIndex === -1) {
        if (deletedPantry) { deletedPantry.deletedAt = null; deletedPantry.updatedAt = nowISO(); }
        else state.pantryItems.push({ id: uid('pantry'), ingredientId: pantryId, alwaysAvailable: true, createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null });
      }
      if (!target.checked && pantryIndex !== -1) { state.pantryItems[pantryIndex].deletedAt = nowISO(); state.pantryItems[pantryIndex].updatedAt = state.pantryItems[pantryIndex].deletedAt; }
      saveState();
      render();
      return;
    }
    if (action === 'toggle-excluded') {
      var excludedList = listForId(target.dataset.listId);
      var excludedItem = itemForList(excludedList, target.dataset.id);
       if (excludedItem) { excludedItem.excluded = !excludedItem.excluded; excludedItem.updatedAt = nowISO(); excludedList.updatedAt = excludedItem.updatedAt; saveState(); render(); }
      return;
    }
    if (action === 'delete-shopping') {
      var deleteList = listForId(target.dataset.listId);
       if (deleteList) { var deletedShoppingItem = itemForList(deleteList, target.dataset.id); if (deletedShoppingItem) { deletedShoppingItem.deletedAt = nowISO(); deletedShoppingItem.updatedAt = deletedShoppingItem.deletedAt; deleteList.updatedAt = deletedShoppingItem.updatedAt; } saveState(); render(); }
      return;
    }
    if (action === 'edit-shopping') {
      var editList = listForId(target.dataset.listId);
      var editItem = itemForList(editList, target.dataset.id);
      if (editItem) openModal(renderManualShoppingModal(editItem, editList));
      return;
    }
    if (action === 'open-manual-shopping') {
      var currentList = listForCurrentWeek();
      if (!currentList) {
        var manualStart = isoDate(weekStart(ui.weekOffset));
        var manualEnd = isoDate(addDays(weekStart(ui.weekOffset), 6));
        currentList = { id: uid('list'), name: '買い物 · ' + formatDate(manualStart) + '—' + formatDate(manualEnd), periodStart: manualStart, periodEnd: manualEnd, status: 'open', createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null, items: [] };
        state.shoppingLists.push(currentList);
        saveState();
      }
      openModal(renderManualShoppingModal(null, currentList));
      return;
    }
    if (action === 'add-ingredient' || action === 'remove-ingredient' || action === 'add-step' || action === 'remove-step') {
      var form = target.closest('form[data-form="recipe"]');
      if (!form) return;
      var draft = syncRecipeFormDraft(form);
      var formId = form.dataset.recipeId || 'new';
      if (action === 'add-ingredient') draft.ingredients.push(defaultIngredient('', null, '', '', false));
      if (action === 'remove-ingredient') { draft.ingredients.splice(Number(target.dataset.index), 1); if (!draft.ingredients.length) draft.ingredients.push(defaultIngredient('', null, '', '', false)); }
      if (action === 'add-step') draft.steps.push({ id: uid('step'), stepNumber: draft.steps.length + 1, instruction: '', timerSeconds: null });
      if (action === 'remove-step') { draft.steps.splice(Number(target.dataset.index), 1); if (!draft.steps.length) draft.steps.push({ id: uid('step'), stepNumber: 1, instruction: '', timerSeconds: null }); }
      ui.formDraft[formId] = draft;
      render();
      return;
    }
    if (action === 'remove-tag') {
      var tag = target.dataset.tag;
      if (!confirm('タグ「' + tag + '」をレシピから外しますか？')) return;
       state.recipes.forEach(function (recipe) { if ((recipe.tags || []).indexOf(tag) !== -1) { recipe.tags = (recipe.tags || []).filter(function (item) { return item !== tag; }); recipe.updatedAt = nowISO(); } });
       state.tags.forEach(function (item) { if (item.name === tag && !item.deletedAt) { item.deletedAt = nowISO(); item.updatedAt = item.deletedAt; } });
      saveState();
      render();
      return;
    }
    if (action === 'reset-data') {
      if (!confirm('現在のデータを初期サンプルに置き換えますか？')) return;
       var deviceId = state.sync.deviceId;
       state = normalizeState(createSeedState());
       state.sync.deviceId = deviceId;
       ui = { search: '', category: 'すべて', tag: 'すべて', favoriteOnly: false, maxTime: '', sort: 'recent', formDraft: {}, weekOffset: 0, selectionMode: false, selectedRecipes: {}, shoppingView: 'category', importDraft: null, importError: '', cookSessions: {}, pendingImport: null, dataError: '' };
      saveState();
      showToast('サンプルデータを再読み込みしました。');
      location.hash = '#/recipes';
      return;
    }
    if (action === 'toggle-cook-ingredient') {
      var session = cookSessionFor(target.dataset.recipeId, recipeById(target.dataset.recipeId));
      var ingredientIndex = target.dataset.index;
      session.checkedIngredients[ingredientIndex] = !session.checkedIngredients[ingredientIndex];
      render();
      return;
    }
    if (action === 'cook-next' || action === 'cook-prev') {
      var cookRecipe = recipeById(target.dataset.recipeId);
      if (!cookRecipe) return;
      var cookSession = cookSessionFor(cookRecipe.id, cookRecipe);
      cookSession.currentStep = Math.max(0, Math.min((cookRecipe.steps || []).length - 1, cookSession.currentStep + (action === 'cook-next' ? 1 : -1)));
      render();
      return;
    }
    if (action === 'clear-import') { ui.importDraft = null; ui.importError = ''; location.hash = '#/recipes/import'; return; }
  }

  document.addEventListener('click', handleClick);

  document.addEventListener('input', function (event) {
    if (!event.target.matches('[data-filter-search]')) return;
    var cursor = event.target.selectionStart;
    ui.search = event.target.value;
    render();
    var input = document.querySelector('[data-filter-search]');
    if (input) { input.focus(); input.setSelectionRange(cursor, cursor); }
  });

  document.addEventListener('change', function (event) {
     var target = event.target;
     if (target.dataset.fileInput === 'local-json') {
       readSnapshotFile(target.files && target.files[0]);
       target.value = '';
       return;
     }
     var filter = target.dataset.filter;
    if (filter === 'category' || filter === 'tag' || filter === 'sort' || filter === 'max-time') {
      ui[filter === 'max-time' ? 'maxTime' : filter] = target.value;
      render();
      return;
    }
    if (filter === 'favorite') { ui.favoriteOnly = target.checked; render(); return; }
    var setting = target.dataset.setting;
     if (setting === 'theme') { state.settings.theme = target.value; touchSettings(); saveState(); render(); return; }
     if (setting === 'excludePantry') { state.settings.excludePantry = target.checked; touchSettings(); saveState(); return; }
     if (setting === 'backupRetention') { state.settings.backupRetention = Math.max(1, Math.min(10, Number(target.value || 5))); touchSettings(); saveState(); render(); return; }
  });

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.dataset.form) return;
    event.preventDefault();
    if (form.dataset.form === 'recipe') {
      var recipeId = form.dataset.recipeId || null;
      var draft = syncRecipeFormDraft(form);
      saveRecipeDraft(draft, recipeId);
      return;
    }
    if (form.dataset.form === 'add-meal') {
      var mealData = new FormData(form);
      var mealRecipe = recipeById(String(mealData.get('recipeId') || ''));
      if (!mealRecipe) { showToast('レシピを選択してください。'); return; }
      state.mealPlans.push({ id: uid('meal'), date: String(mealData.get('date')), mealSlot: String(mealData.get('slot')), recipeId: mealRecipe.id, servings: Math.max(1, Number(mealData.get('servings') || mealRecipe.originalServings)), note: String(mealData.get('note') || '').trim(), createdAt: nowISO(), updatedAt: nowISO() });
      syncShoppingListForDate(String(mealData.get('date')));
      saveState();
      closeModal();
      showToast('献立に追加し、買い物リストを更新しました。');
      render();
      return;
    }
    if (form.dataset.form === 'shopping-item') {
      var shoppingData = new FormData(form);
      var list = listForId(form.dataset.listId);
      if (!list) return;
      var item = form.dataset.itemId ? itemForList(list, form.dataset.itemId) : null;
      var quantityValue = String(shoppingData.get('quantity') || '');
      if (item) {
        item.displayName = String(shoppingData.get('displayName')).trim();
        item.quantity = quantityValue === '' ? null : Number(quantityValue);
        item.unit = String(shoppingData.get('unit') || '').trim();
        item.category = String(shoppingData.get('category') || 'その他');
      } else {
         list.items.push({ id: uid('shop'), ingredientId: null, displayName: String(shoppingData.get('displayName')).trim(), quantity: quantityValue === '' ? null : Number(quantityValue), unit: String(shoppingData.get('unit') || '').trim(), originalText: String(shoppingData.get('displayName')).trim(), category: String(shoppingData.get('category') || 'その他'), checked: false, excluded: false, manualItem: true, sourceRecipes: [], createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null });
      }
       var shoppingChangedAt = nowISO();
       if (item) item.updatedAt = shoppingChangedAt;
       list.updatedAt = shoppingChangedAt;
      saveState();
      closeModal();
      showToast('買い物項目を保存しました。');
      render();
      return;
    }
    if (form.dataset.form === 'tag') {
      var tagData = new FormData(form);
      var tagName = String(tagData.get('tag') || '').trim();
      if (!tagName) return;
       if (!state.tags.some(function (item) { return !item.deletedAt && item.name === tagName; })) state.tags.push({ id: uid('tag'), name: tagName, type: 'tag', createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null });
      saveState();
      form.reset();
      showToast('タグを追加しました。');
      render();
      return;
    }
    if (form.dataset.form === 'cook-complete') {
      var cookId = routeParts()[1];
      var cookRecipe = recipeById(cookId);
      if (!cookRecipe) return;
      var cookData = new FormData(form);
       state.cookingHistory.unshift({ id: uid('history'), recipeId: cookId, cookedAt: nowISO(), servings: cookSessionFor(cookId, cookRecipe).servings, rating: cookData.get('rating') ? Number(cookData.get('rating')) : null, note: String(cookData.get('note') || '').trim(), createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null });
      saveState();
      delete ui.cookSessions[cookId];
      showToast('調理履歴を保存しました。');
      location.hash = '#/recipes/' + cookId;
      return;
    }
    if (form.dataset.form === 'import') {
      handleImportSubmit(form);
      return;
    }
    if (form.dataset.form === 'import-review') {
      var reviewData = new FormData(form);
      var imported = clone(ui.importDraft);
      imported.title = String(reviewData.get('title') || '').trim();
      imported.description = String(reviewData.get('description') || '').trim();
      imported.category = String(reviewData.get('category') || '主菜');
      imported.originalServings = Math.max(1, Number(reviewData.get('originalServings') || 1));
      imported.prepTimeMinutes = Math.max(0, Number(reviewData.get('prepTimeMinutes') || 0));
      imported.cookTimeMinutes = Math.max(0, Number(reviewData.get('cookTimeMinutes') || 0));
      imported.tags = String(reviewData.get('tags') || '').split(',').map(function (tag) { return tag.trim(); }).filter(Boolean);
      imported.ingredients = parseIngredientLines(String(reviewData.get('ingredients') || ''));
      imported.steps = String(reviewData.get('steps') || '').split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean).map(function (instruction) { return { id: uid('step'), instruction: instruction, stepNumber: 0, timerSeconds: null }; });
      imported.steps.forEach(function (item, index) { item.stepNumber = index + 1; });
      saveRecipeDraft(imported, null);
      ui.importDraft = null;
      return;
    }
  });

  modal.addEventListener('click', function (event) {
    if (event.target === modal) closeModal();
  });

  function parseNumber(value) {
    var text = String(value || '').trim();
    if (text.indexOf('/') !== -1) {
      var parts = text.split('/');
      var numerator = Number(parts[0]);
      var denominator = Number(parts[1]);
      return denominator ? numerator / denominator : null;
    }
    var result = Number(text.replace(',', '.'));
    return Number.isFinite(result) ? result : null;
  }

  function parseIngredientLine(line) {
    var original = String(line || '').trim();
    if (!original) return null;
    var match = original.match(/^\s*((?:\d+(?:[.,]\d+)?|\d+\s*\/\s*\d+))?\s*(kg|g|ml|l|個|本|枚|丁|玉|缶|束|大さじ|小さじ)?\s*(.+?)\s*$/i);
    var quantity = match && match[1] ? parseNumber(match[1]) : null;
    var unit = match && match[2] ? match[2] : '';
    var name = match && match[3] ? match[3].trim() : original;
    if (quantity == null) {
      var trailing = original.match(/^(.+?)\s*((?:\d+(?:[.,]\d+)?|\d+\s*\/\s*\d+))\s*(kg|g|ml|l|個|本|枚|丁|玉|缶|束|大さじ|小さじ)\s*$/i);
      if (trailing) {
        name = trailing[1].trim();
        quantity = parseNumber(trailing[2]);
        unit = trailing[3];
      }
    }
    if (!name || /^(適量|少々|お好みで)$/.test(name)) { name = original; quantity = null; unit = ''; }
    return { id: uid('ri'), ingredientId: ensureIngredientMaster(name, '', unit), displayName: name, quantity: quantity, unit: unit, originalText: original, optional: false, note: '' };
  }

  function parseIngredientLines(text) {
    return String(text || '').split(/\r?\n/).map(parseIngredientLine).filter(Boolean);
  }

  function parseDuration(value) {
    var text = String(value || '');
    var hours = text.match(/(\d+)H/i);
    var minutes = text.match(/(\d+)M/i);
    return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  }

  function recipeType(value) {
    var types = Array.isArray(value) ? value : [value];
    return types.some(function (type) { return String(type || '').toLowerCase().indexOf('recipe') !== -1; });
  }

  function findRecipeJsonLd(value) {
    var candidates = [];
    function walk(node) {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== 'object') return;
      if (recipeType(node['@type']) || recipeType(node.type)) candidates.push(node);
      if (node['@graph']) walk(node['@graph']);
      Object.keys(node).forEach(function (key) {
        if (key !== '@graph' && typeof node[key] === 'object') walk(node[key]);
      });
    }
    walk(value);
    return candidates[0] || null;
  }

  function extractJsonLd(input) {
    var text = String(input || '').trim();
    if (!text) return null;
    try {
      var direct = JSON.parse(text);
      var directRecipe = findRecipeJsonLd(direct);
      if (directRecipe) return directRecipe;
    } catch (error) { /* continue with HTML parsing */ }
    if (!window.DOMParser) return null;
    var doc = new DOMParser().parseFromString(text, 'text/html');
    var scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
    for (var index = 0; index < scripts.length; index += 1) {
      try {
        var parsed = JSON.parse(scripts[index].textContent.trim());
        var recipe = findRecipeJsonLd(parsed);
        if (recipe) return recipe;
      } catch (error) { /* some sites contain invalid JSON-LD blocks */ }
    }
    return null;
  }

  function jsonLdToDraft(payload, sourceUrl) {
    var ingredients = Array.isArray(payload.recipeIngredient) ? payload.recipeIngredient : (payload.recipeIngredient ? [payload.recipeIngredient] : []);
    var instructions = payload.recipeInstructions || [];
    if (typeof instructions === 'string') instructions = instructions.split(/\r?\n/);
    if (!Array.isArray(instructions)) instructions = [instructions];
    instructions = instructions.map(function (item) {
      if (typeof item === 'string') return item;
      return item && (item.text || item.name || item.instruction) ? (item.text || item.name || item.instruction) : '';
    }).filter(Boolean);
    var yieldText = Array.isArray(payload.recipeYield) ? payload.recipeYield[0] : payload.recipeYield;
    var yieldMatch = String(yieldText || '').match(/\d+(?:\.\d+)?/);
    var draftIngredients = ingredients.map(function (line) { return parseIngredientLine(line); }).filter(Boolean);
    return {
      id: null,
      title: payload.name || '',
      description: payload.description || '',
      originalServings: yieldMatch ? Math.max(1, Number(yieldMatch[0])) : 2,
      prepTimeMinutes: parseDuration(payload.prepTime),
      cookTimeMinutes: parseDuration(payload.cookTime) || parseDuration(payload.totalTime),
      sourceType: 'json_ld',
      sourceUrl: sourceUrl || payload.url || '',
      favorite: false,
      category: payload.recipeCategory && /soup|汁/i.test(String(payload.recipeCategory)) ? '汁物' : '主菜',
      tags: Array.isArray(payload.keywords) ? payload.keywords : String(payload.keywords || '').split(',').map(function (tag) { return tag.trim(); }).filter(Boolean),
      ingredients: draftIngredients,
      steps: instructions.map(function (instruction, index) { return { id: uid('step'), stepNumber: index + 1, instruction: instruction, timerSeconds: null }; }),
      color: PALETTE[state.recipes.length % PALETTE.length],
      rawMetadata: payload
    };
  }

  async function handleImportSubmit(form) {
    var data = new FormData(form);
    var url = String(data.get('url') || '').trim();
    var source = String(data.get('source') || '').trim();
    ui.importError = '';
    if (!source && !url) { ui.importError = 'URLまたはJSON-LD / HTMLを入力してください。'; render(); return; }
    var payload = extractJsonLd(source);
    if (!payload && url) {
      try {
        var response = await fetch(url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        payload = extractJsonLd(await response.text());
      } catch (error) {
        ui.importError = 'URLを読み込めませんでした。サイト側のCORS制約の可能性があります。ページの JSON-LD を貼り付けて再度お試しください。';
        render();
        return;
      }
    }
    if (!payload) {
      ui.importError = 'Recipe形式のJSON-LDを検出できませんでした。手動入力に切り替えるか、JSON-LDの内容を貼り付けてください。';
      render();
      return;
    }
    ui.importDraft = jsonLdToDraft(payload, url);
    render();
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* app remains usable without offline shell */ });
    }
  }

  registerServiceWorker();
  render();
}());
