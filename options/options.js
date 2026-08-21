// options/options.js
// Ayar sayfasi. lib/settings.js ve lib/history.js dogrudan kullanilir (bu sayfa
// eklenti baglaminda calisir; storage'a tam erisimi vardir).

import { getSettings, updateSettings, resetSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { clearAllHistory } from '../lib/history.js';
import { getApiKey, setApiKey, testConnection, describeKey, modelsFor } from '../lib/ai.js';

const CHECKBOXES = [
  'deepScanVerify', 'deepScanRecursive', 'deepScanSources', 'deepScanMine',
  'showBadge', 'showSpecialByDefault', 'persistHistory',
  'aiEnabled', 'aiRedact'
];
const NUMBERS = ['deepScanMaxDepth', 'historyLimit', 'aiMaxTokens'];
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

/** Anahtardan okunan saglayiciyi durum satirinda gosterir. */
function syncKeyStatus() {
  const status = el('aiStatus');
  const key = el('aiKey').value.trim();
  const list = el('aiModelList');
  const modelField = el('aiModel');

  if (!key) {
    status.className = 'ai-status';
    status.textContent = '';
    list.textContent = '';
    modelField.placeholder = 'auto';
    return;
  }

  const info = describeKey(key);
  if (info.ok) {
    status.className = 'ai-status is-ok';
    status.textContent = `Detected: ${info.label}`;
    // Saglayiciya gore model onerileri + varsayilanin yer tutucu olarak gosterimi
    const models = modelsFor(info.id);
    list.textContent = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    }
    modelField.placeholder = models.length ? `auto — ${models[0]}` : 'auto';
  } else {
    status.className = 'ai-status is-err';
    status.textContent = 'Key format not recognized';
    list.textContent = '';
    modelField.placeholder = 'auto';
  }
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

  for (const id of [...CHECKBOXES, ...SELECTS, ...TEXTS, ...NUMBERS]) {
    el(id).addEventListener('change', persist);
  }

  el('aiKey').addEventListener('input', syncKeyStatus);
  el('aiKey').addEventListener('change', async () => {
    await setApiKey(el('aiKey').value.trim());
    syncKeyStatus();
    showSaved();
  });

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
