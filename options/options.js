// options/options.js
// Ayar sayfasi. lib/settings.js ve lib/history.js dogrudan kullanilir (bu sayfa
// eklenti baglaminda calisir; storage'a tam erisimi vardir).

import { getSettings, updateSettings, resetSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { clearAllHistory } from '../lib/history.js';
import {
  getApiKey, setApiKey, testConnection, describeKey,
  listModels, searchModels, describeModel
} from '../lib/ai.js';

const CHECKBOXES = [
  'deepScanVerify', 'deepScanRecursive', 'deepScanSources', 'deepScanMine',
  'showBadge', 'showSpecialByDefault', 'persistHistory',
  'aiEnabled', 'aiRedact', 'aiIncludeSources', 'aiSaveHistory',
  'aiIncludeCode', 'aiCodeThirdParty'
];
const NUMBERS = ['deepScanMaxDepth', 'historyLimit', 'aiMaxTokens', 'aiCodeBudget', 'aiCodePerFile'];
const SELECTS = ['defaultExportFormat'];
const TEXTS = ['aiModel'];

const el = (id) => document.getElementById(id);
let savedTimer = null;

function showSaved() {
  const node = el('saved');
  node.hidden = false;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { node.hidden = true; }, 1200);
}

/** Canli model listesi durumu (bellek ici). */
const modelState = { providerId: '', models: [], loading: false };

function setModelStatus(text, isError) {
  const node = el('aiModelStatus');
  node.textContent = text || '';
  node.className = 'modelpick__status' + (isError ? ' is-err' : '');
}

/** Model listesini filtreleyip cizer. */
function renderModelList() {
  const list = el('aiModelList');
  const selected = el('aiModel').value.trim();
  const filtered = searchModels(modelState.models, el('aiModelSearch').value);
  list.textContent = '';

  if (!filtered.length) {
    setModelStatus(modelState.models.length
      ? 'No model matches that search.'
      : 'No models loaded yet — paste a key, then press Refresh list.');
    return;
  }

  // Uzun listelerde (OpenRouter'da yuzlerce model var) ilk 60 sonuc yeterli.
  for (const model of filtered.slice(0, 60)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'modelrow' + (model.id === selected ? ' is-selected' : '');
    row.setAttribute('role', 'option');

    const id = document.createElement('span');
    id.className = 'modelrow__id';
    id.textContent = model.id;
    row.appendChild(id);

    const meta = describeModel(model);
    if (meta) {
      const m = document.createElement('span');
      m.className = 'modelrow__meta';
      m.textContent = meta;
      row.appendChild(m);
    }

    row.addEventListener('click', async () => {
      el('aiModel').value = model.id;
      renderModelList();
      await persist();
    });
    list.appendChild(row);
  }

  const shown = Math.min(filtered.length, 60);
  setModelStatus(`${shown} of ${filtered.length} model(s) shown${modelState.providerId ? ' · ' + modelState.providerId : ''}.`);
}

/** Saglayicidan model listesini indirir. */
async function loadModels({ force = false } = {}) {
  const key = el('aiKey').value.trim();
  const info = describeKey(key);
  if (!info.ok) {
    modelState.models = [];
    modelState.providerId = '';
    el('aiModelList').textContent = '';
    setModelStatus(key ? 'Key format not recognised — cannot list models.' : 'Paste an API key to load the model list.');
    return;
  }
  if (modelState.loading) return;

  modelState.loading = true;
  setModelStatus(force ? 'Refreshing model list…' : 'Loading model list…');
  try {
    const { models, cached, error } = await listModels(info.id, key, { force });
    modelState.providerId = info.id;
    modelState.models = models;
    if (error && !models.length) {
      setModelStatus(error, true);
      el('aiModelList').textContent = '';
      return;
    }
    renderModelList();
    if (cached) setModelStatus(`${models.length} model(s) · cached · press Refresh list for the latest.`);
  } finally {
    modelState.loading = false;
  }
}

/** Anahtardan okunan saglayiciyi durum satirinda gosterir. */
function syncKeyStatus() {
  const status = el('aiStatus');
  const key = el('aiKey').value.trim();

  if (!key) {
    status.className = 'ai-status';
    status.textContent = '';
    return;
  }
  const info = describeKey(key);
  if (info.ok) {
    status.className = 'ai-status is-ok';
    status.textContent = `Detected: ${info.label}`;
  } else {
    status.className = 'ai-status is-err';
    status.textContent = 'Key format not recognized';
  }
}

// ---------------------------------------------------------------------------
// Kullanici tanimli analizler
// ---------------------------------------------------------------------------

let customAnalyses = [];

function renderCustoms() {
  const host = el('customList');
  host.textContent = '';

  if (!customAnalyses.length) {
    const empty = document.createElement('p');
    empty.className = 'customs__empty';
    empty.textContent = 'No custom analyses yet. Add one to get your own button in the AI tab.';
    host.appendChild(empty);
    return;
  }

  customAnalyses.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'custom';

    const head = document.createElement('div');
    head.className = 'custom__head';

    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'custom__label';
    label.placeholder = 'Button label — e.g. GDPR exposure';
    label.value = item.label || '';
    label.addEventListener('change', async () => {
      customAnalyses[index].label = label.value.trim();
      await saveCustoms();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn--sm btn--danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      customAnalyses.splice(index, 1);
      await saveCustoms();
      renderCustoms();
    });

    head.appendChild(label);
    head.appendChild(remove);

    const instruction = document.createElement('textarea');
    instruction.className = 'custom__instruction';
    instruction.placeholder = 'What should the model do? Describe the task and the output you want — the collected inventory is appended automatically.';
    instruction.value = item.instruction || '';
    instruction.addEventListener('change', async () => {
      customAnalyses[index].instruction = instruction.value;
      await saveCustoms();
    });

    card.appendChild(head);
    card.appendChild(instruction);
    host.appendChild(card);
  });
}

async function saveCustoms() {
  await updateSettings({ aiCustomAnalyses: customAnalyses.filter((c) => c.label || c.instruction) });
  showSaved();
}

/** Ayarlari forma yansitir. */
function render(settings) {
  for (const id of CHECKBOXES) el(id).checked = Boolean(settings[id]);
  for (const id of NUMBERS) el(id).value = settings[id];
  for (const id of SELECTS) el(id).value = settings[id];
  for (const id of TEXTS) el(id).value = settings[id] || '';
}

/** Formdan ayar nesnesi toplar (siniri asan sayilar kirpilir). */
function collect() {
  const patch = {};
  for (const id of CHECKBOXES) patch[id] = el(id).checked;
  for (const id of SELECTS) patch[id] = el(id).value;
  for (const id of TEXTS) patch[id] = el(id).value.trim();
  patch.deepScanMaxDepth = Math.max(0, Math.min(3, parseInt(el('deepScanMaxDepth').value, 10) || 0));
  patch.historyLimit = Math.max(1, Math.min(200, parseInt(el('historyLimit').value, 10) || 20));
  patch.aiMaxTokens = Math.max(256, Math.min(8192, parseInt(el('aiMaxTokens').value, 10) || 2000));
  patch.aiCodeBudget = Math.max(10000, Math.min(600000, parseInt(el('aiCodeBudget').value, 10) || 120000));
  patch.aiCodePerFile = Math.max(4000, Math.min(200000, parseInt(el('aiCodePerFile').value, 10) || 40000));
  return patch;
}

async function persist() {
  await updateSettings(collect());
  showSaved();
}

async function init() {
  const settings = await getSettings();
  render(settings);

  // API anahtari (ayarlardan ayri saklanir).
  el('aiKey').value = (await getApiKey()) || '';
  syncKeyStatus();

  // Kullanici tanimli analizler
  customAnalyses = Array.isArray(settings.aiCustomAnalyses) ? [...settings.aiCustomAnalyses] : [];
  renderCustoms();

  for (const id of [...CHECKBOXES, ...SELECTS, ...TEXTS, ...NUMBERS]) {
    el(id).addEventListener('change', persist);
  }

  el('aiKey').addEventListener('input', syncKeyStatus);
  el('aiKey').addEventListener('change', async () => {
    await setApiKey(el('aiKey').value.trim());
    syncKeyStatus();
    showSaved();
    loadModels({ force: true });   // yeni anahtar -> yeni model listesi
  });

  // --- Model secici ---
  el('aiModelSearch').addEventListener('input', renderModelList);
  el('aiModelRefresh').addEventListener('click', () => loadModels({ force: true }));
  el('aiModelClear').addEventListener('click', async () => {
    el('aiModel').value = '';
    renderModelList();
    await persist();
  });
  el('aiModel').addEventListener('change', () => { renderModelList(); });

  // --- Ozel analizler ---
  el('customAdd').addEventListener('click', async () => {
    customAnalyses.push({
      id: `c${Date.now().toString(36)}`,
      label: '',
      instruction: ''
    });
    await saveCustoms();
    renderCustoms();
  });

  // Anahtar zaten varsa listeyi (onbellekten) yukle
  if (el('aiKey').value.trim()) loadModels();
  else setModelStatus('Paste an API key to load the model list.');

  el('aiTest').addEventListener('click', async () => {
    const status = el('aiStatus');
    status.className = 'ai-status';
    status.textContent = 'Testing…';
    await setApiKey(el('aiKey').value.trim());
    await persist();
    try {
      const { provider, model } = await testConnection();
      status.className = 'ai-status is-ok';
      status.textContent = `Connected — ${provider} · ${model}`;
      loadModels();
    } catch (err) {
      status.className = 'ai-status is-err';
      status.textContent = err.message;
    }
  });

  el('resetDefaults').addEventListener('click', async () => {
    const next = await resetSettings();
    render(next);
    showSaved();
  });

  el('clearHistory').addEventListener('click', async () => {
    await clearAllHistory();
    const node = el('saved');
    node.textContent = 'History cleared ✓';
    node.hidden = false;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { node.hidden = true; node.textContent = 'Saved ✓'; }, 1400);
  });
}

// DEFAULT_SETTINGS referansi, ileride "farkli mi" gostergesi icin hazir tutulur.
void DEFAULT_SETTINGS;

init();
